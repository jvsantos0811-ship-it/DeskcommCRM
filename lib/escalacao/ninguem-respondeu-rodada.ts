/**
 * A RODADA DO AVISO "NINGUÉM RESPONDEU" (PM-027 §7) — a parte com banco.
 *
 * O cron `ninguem-respondeu` chama isto a cada 5 minutos. Para cada organização
 * ATIVA que ligou o aviso (`settings.ninguem_respondeu`):
 *
 *   1. lê as conversas com mensagem do lead depois de ligado o aviso (até 14
 *      dias) que podem estar sem resposta, mais as que já têm aviso aberto;
 *   2. para cada uma, lê o contato, os negócios (alcance) e as últimas 15
 *      mensagens, marca a resposta automática do WhatsApp Business e aplica a
 *      regra pura (`avaliarConversa`);
 *   3. quando a forma não decide, pergunta à leitura curta — uma vez por
 *      mensagem do lead, com a resposta guardada em
 *      `conferencias_de_fim_da_conversa`;
 *   4. abre UM aviso por conversa (índice único parcial; 23505 = já aberto) e
 *      resolve o aviso quando alguém respondeu ou a conversa saiu do alcance.
 *
 * Toda leitura e escrita filtra `organization_id`. Nunca lança por uma
 * conversa: a falha de uma não para as outras (conta em `falhas`).
 */
import { alcanceDaOrg, funisLidos, posicaoNoAlcance, type FunilDaOrg, type PosicaoNoAlcance } from "@/lib/dados/alcance-do-leitor";
import { expedienteDaOrg } from "@/lib/dados/expediente";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { ehOperante, STATUS_OPERANTE } from "@/lib/organizacao/operante";
import type { createAdminClient } from "@/lib/supabase/admin";

import type { ConferidorDoFim } from "./conferir-fim-da-conversa";
import {
  avaliarConversa,
  configDoAviso,
  CONVERSAS_PARA_CONFIRMAR_AUTOMATICA,
  KIND_DO_AVISO,
  melhorPosicao,
  pareceRespostaAutomatica,
  textoDoAviso,
  type MensagemDaConversa,
} from "./ninguem-respondeu";
import { ehContatoDoNumeroInterno } from "./numero-interno-de-aviso";

type Admin = ReturnType<typeof createAdminClient>;

const DIA_MS = 24 * 60 * 60 * 1000;
/** Só olha mensagem do lead dos últimos 14 dias: espera mais longa é do painel. */
const JANELA_DE_BUSCA_MS = 14 * DIA_MS;
/** Conversas lidas por organização por rodada; o resto entra na próxima. */
const CONVERSAS_POR_RODADA = 500;
/** Leituras curtas por organização por rodada (teto de tempo e de gasto). */
const LEITURAS_POR_RODADA = 20;
/** Mensagens lidas por conversa. */
const MENSAGENS_LIDAS = 15;
/** Saída nossa até tanto depois da entrada pode ser a automática: ainda é candidata. */
const FOLGA_DA_AUTOMATICA_MS = 120_000;

export interface ResultadoDaRodada {
  organizacoes: number;
  examinadas: number;
  abertos: number;
  resolvidos: number;
  conferidas: number;
  falhas: number;
}

export interface DepsDaRodada {
  agora: Date;
  conferir: ConferidorDoFim;
  /** Dublê no teste; padrão = `ehContatoDoNumeroInterno`. */
  ehInterno?: (admin: Admin, organizationId: string, contactId: string) => Promise<boolean>;
}

interface OrgDaRodada {
  id: string;
  settings: unknown;
  timezone: string | null;
  locale: string | null;
  status: string | null;
}

interface ConversaDaRodada {
  id: string;
  contact_id: string | null;
  is_group: boolean | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
}

interface LeadDaRodada {
  contact_id: string;
  pipeline_id: string;
  tags: string[] | null;
  etapa: { name: string | null; is_won: boolean; is_lost: boolean; is_archived: boolean } | null;
}

export async function rodadaNinguemRespondeu(admin: Admin, deps: DepsDaRodada): Promise<ResultadoDaRodada> {
  const r: ResultadoDaRodada = { organizacoes: 0, examinadas: 0, abertos: 0, resolvidos: 0, conferidas: 0, falhas: 0 };

  const { data: orgsData, error: orgsErr } = await admin
    .from("organizations")
    .select("id, settings, timezone, locale, status")
    .eq("status", STATUS_OPERANTE)
    .eq("settings->ninguem_respondeu->>ligado", "true");
  if (orgsErr) throw new Error(`ninguem_respondeu_orgs: ${orgsErr.message}`);

  for (const org of (orgsData ?? []) as OrgDaRodada[]) {
    if (!ehOperante(org.status)) continue;
    const cfg = configDoAviso(org.settings);
    if (!cfg.ligado || !cfg.ligado_em) continue;
    r.organizacoes += 1;
    try {
      await rodadaDaOrganizacao(admin, deps, org, new Date(cfg.ligado_em), r);
    } catch (err) {
      r.falhas += 1;
      logger.warn("[ninguem-respondeu] organização falhou (as outras seguem)", {
        organization_id: org.id,
        detalhe: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }
  return r;
}

async function rodadaDaOrganizacao(
  admin: Admin,
  deps: DepsDaRodada,
  org: OrgDaRodada,
  ligadoEm: Date,
  r: ResultadoDaRodada,
): Promise<void> {
  const orgId = org.id;
  const agora = deps.agora;
  const expediente = expedienteDaOrg(org.settings, org.timezone);
  const alcance = alcanceDaOrg(org.settings);
  const idioma = normalizarIdioma(org.locale);
  const t = (s: string) => traduzir(s, idioma);
  const ehInterno = deps.ehInterno ?? ehContatoDoNumeroInterno;

  const { data: funisData, error: funisErr } = await admin
    .from("crm_pipelines")
    .select("id, is_archived, is_client_pipeline")
    .eq("organization_id", orgId);
  if (funisErr) throw new Error(`funis: ${funisErr.message}`);
  const lidos = funisLidos(alcance, (funisData ?? []) as FunilDaOrg[]);

  const { data: abertosData, error: abertosErr } = await admin
    .from("agent_inbox_items")
    .select("id, ref_id")
    .eq("organization_id", orgId)
    .eq("kind", KIND_DO_AVISO)
    .eq("status", "open");
  if (abertosErr) throw new Error(`abertos: ${abertosErr.message}`);
  const abertoPorConversa = new Map<string, string>();
  for (const a of (abertosData ?? []) as Array<{ id: string; ref_id: string | null }>) {
    if (a.ref_id) abertoPorConversa.set(a.ref_id, a.id);
  }

  const desdeBusca = new Date(Math.max(ligadoEm.getTime(), agora.getTime() - JANELA_DE_BUSCA_MS));
  const { data: candData, error: candErr } = await admin
    .from("conversations")
    .select("id, contact_id, is_group, last_inbound_at, last_outbound_at")
    .eq("organization_id", orgId)
    .eq("is_group", false)
    .gte("last_inbound_at", desdeBusca.toISOString())
    .order("last_inbound_at", { ascending: false })
    .limit(CONVERSAS_POR_RODADA);
  if (candErr) throw new Error(`conversas: ${candErr.message}`);

  const conversas = new Map<string, ConversaDaRodada>();
  for (const c of (candData ?? []) as ConversaDaRodada[]) {
    const entrada = c.last_inbound_at ? Date.parse(c.last_inbound_at) : null;
    const saida = c.last_outbound_at ? Date.parse(c.last_outbound_at) : null;
    // Respondida com folga (saída bem depois da última entrada) só interessa se tem aviso aberto.
    const podeEstarSemResposta = entrada !== null && (saida === null || saida < entrada + FOLGA_DA_AUTOMATICA_MS);
    if (podeEstarSemResposta || abertoPorConversa.has(c.id)) conversas.set(c.id, c);
  }
  const faltam = [...abertoPorConversa.keys()].filter((id) => !conversas.has(id));
  if (faltam.length > 0) {
    const { data: extra } = await admin
      .from("conversations")
      .select("id, contact_id, is_group, last_inbound_at, last_outbound_at")
      .eq("organization_id", orgId)
      .in("id", faltam);
    for (const c of (extra ?? []) as ConversaDaRodada[]) conversas.set(c.id, c);
    // Conversa apagada: o aviso não tem mais o que mostrar.
    for (const id of faltam) {
      if (!conversas.has(id)) await resolver(admin, orgId, abertoPorConversa.get(id)!, r);
    }
  }
  if (conversas.size === 0) return;

  const contatoIds = [...new Set([...conversas.values()].map((c) => c.contact_id).filter((x): x is string => !!x))];
  const bloqueado = new Map<string, boolean>();
  const posicoes = new Map<string, { posicao: PosicaoNoAlcance; etapa: string | null }[]>();
  if (contatoIds.length > 0) {
    const { data: contatos, error: contErr } = await admin
      .from("contacts")
      .select("id, is_blocked")
      .eq("organization_id", orgId)
      .in("id", contatoIds);
    if (contErr) throw new Error(`contatos: ${contErr.message}`);
    for (const c of (contatos ?? []) as Array<{ id: string; is_blocked: boolean | null }>) {
      bloqueado.set(c.id, c.is_blocked === true);
    }
    const { data: leads, error: leadsErr } = await admin
      .from("crm_leads")
      .select("contact_id, pipeline_id, tags, etapa:crm_stages!crm_leads_stage_id_fkey(name, is_won, is_lost, is_archived)")
      .eq("organization_id", orgId)
      .in("contact_id", contatoIds);
    if (leadsErr) throw new Error(`negocios: ${leadsErr.message}`);
    for (const l of (leads ?? []) as unknown as LeadDaRodada[]) {
      if (!l.etapa) continue;
      const posicao = posicaoNoAlcance(
        { pipeline_id: l.pipeline_id, tags: l.tags, etapa: l.etapa },
        lidos,
        alcance,
      );
      const lista = posicoes.get(l.contact_id) ?? [];
      lista.push({ posicao, etapa: l.etapa.name });
      posicoes.set(l.contact_id, lista);
    }
  }

  const automaticaPorTexto = new Map<string, boolean>();
  let leituras = 0;

  for (const conversa of conversas.values()) {
    r.examinadas += 1;
    const abertoId = abertoPorConversa.get(conversa.id) ?? null;
    try {
      const contatoId = conversa.contact_id;
      const listaPos = contatoId ? (posicoes.get(contatoId) ?? []) : [];
      const posicao = melhorPosicao(listaPos.map((p) => p.posicao));
      const etapa = listaPos.find((p) => p.posicao === posicao)?.etapa ?? null;

      const mensagens = await lerMensagens(admin, orgId, conversa.id);
      await marcarAutomaticas(admin, orgId, mensagens, agora, automaticaPorTexto);

      const avaliacao = avaliarConversa({
        mensagens,
        posicao,
        ehGrupo: conversa.is_group !== false,
        contatoBloqueado: contatoId ? bloqueado.get(contatoId) === true : false,
        contatoInterno: contatoId ? await ehInterno(admin, orgId, contatoId) : false,
        ligadoEm,
        agora,
        expediente,
      });

      if (avaliacao.tipo === "respondida" || avaliacao.tipo === "fora") {
        if (abertoId) await resolver(admin, orgId, abertoId, r);
        continue;
      }

      let avisar = avaliacao.tipo === "avisar";
      if (avaliacao.tipo === "conferir") {
        const memoria = await lerConferencia(admin, orgId, conversa.id, avaliacao.ultima.id);
        if (memoria !== null) {
          avisar = !memoria;
        } else if (leituras < LEITURAS_POR_RODADA) {
          leituras += 1;
          r.conferidas += 1;
          const veredito = await deps.conferir({ organizationId: orgId, contactId: contatoId, trecho: avaliacao.trecho });
          await gravarConferencia(admin, orgId, conversa.id, avaliacao.ultima.id, veredito);
          avisar = !veredito.terminou;
        } else {
          continue; // a leitura fica para a próxima rodada
        }
      }

      if (avisar && !abertoId && (avaliacao.tipo === "avisar" || avaliacao.tipo === "conferir")) {
        const texto = textoDoAviso(t, { desde: avaliacao.desde, etapa, fuso: expediente.timezone, idioma });
        const { error } = await admin.from("agent_inbox_items").insert({
          organization_id: orgId,
          kind: KIND_DO_AVISO,
          severity: "warn",
          title: texto.title,
          body: texto.body,
          ref_kind: "conversation",
          ref_id: conversa.id,
        });
        if (!error) r.abertos += 1;
        else if (error.code !== "23505") throw new Error(`aviso: ${error.message}`);
      }
    } catch (err) {
      r.falhas += 1;
      logger.warn("[ninguem-respondeu] conversa falhou (as outras seguem)", {
        organization_id: orgId,
        conversation_id: conversa.id,
        detalhe: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }
}

async function lerMensagens(admin: Admin, orgId: string, conversationId: string): Promise<MensagemDaConversa[]> {
  const { data, error } = await admin
    .from("messages")
    .select("id, direction, sent_via, type, body, media_derived_text, created_at")
    .eq("organization_id", orgId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(MENSAGENS_LIDAS);
  if (error) throw new Error(`mensagens: ${error.message}`);
  return ((data ?? []) as MensagemDaConversa[]).reverse();
}

/** Marca `automatica` nas saídas do celular que são a resposta automática do WhatsApp Business. */
async function marcarAutomaticas(
  admin: Admin,
  orgId: string,
  mensagens: MensagemDaConversa[],
  agora: Date,
  cache: Map<string, boolean>,
): Promise<void> {
  for (let i = 0; i < mensagens.length; i += 1) {
    const m = mensagens[i]!;
    if (!pareceRespostaAutomatica(m, i > 0 ? mensagens[i - 1]! : null)) continue;
    const texto = (m.body ?? "").trim();
    let automatica = cache.get(texto);
    if (automatica === undefined) {
      const { data } = await admin
        .from("messages")
        .select("conversation_id")
        .eq("organization_id", orgId)
        .eq("direction", "outbound")
        .eq("sent_via", "external_device")
        .eq("body", m.body ?? "")
        .gte("created_at", new Date(agora.getTime() - 30 * DIA_MS).toISOString())
        .limit(50);
      const distintas = new Set(((data ?? []) as Array<{ conversation_id: string }>).map((x) => x.conversation_id));
      automatica = distintas.size >= CONVERSAS_PARA_CONFIRMAR_AUTOMATICA;
      cache.set(texto, automatica);
    }
    if (automatica) m.automatica = true;
  }
}

async function lerConferencia(
  admin: Admin,
  orgId: string,
  conversationId: string,
  messageId: string,
): Promise<boolean | null> {
  const { data } = await admin
    .from("conferencias_de_fim_da_conversa")
    .select("terminou")
    .eq("organization_id", orgId)
    .eq("conversation_id", conversationId)
    .eq("message_id", messageId)
    .maybeSingle();
  const linha = data as { terminou: boolean } | null;
  return linha ? linha.terminou : null;
}

async function gravarConferencia(
  admin: Admin,
  orgId: string,
  conversationId: string,
  messageId: string,
  v: { terminou: boolean; origem: string; modelo: string | null },
): Promise<void> {
  const { error } = await admin.from("conferencias_de_fim_da_conversa").insert({
    organization_id: orgId,
    conversation_id: conversationId,
    message_id: messageId,
    terminou: v.terminou,
    origem: v.origem,
    modelo: v.modelo,
  });
  if (error && error.code !== "23505") {
    logger.warn("[ninguem-respondeu] veredito não gravado (a próxima rodada pergunta de novo)", {
      organization_id: orgId,
      conversation_id: conversationId,
      detalhe: error.message.slice(0, 160),
    });
  }
}

async function resolver(admin: Admin, orgId: string, itemId: string, r: ResultadoDaRodada): Promise<void> {
  const { data, error } = await admin
    .from("agent_inbox_items")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("id", itemId)
    .eq("status", "open")
    .select("id");
  if (error) throw new Error(`resolver: ${error.message}`);
  if (Array.isArray(data) && data.length > 0) r.resolvidos += 1;
}
