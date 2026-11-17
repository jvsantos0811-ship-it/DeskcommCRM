/**
 * Importação do histórico do canal intermediado — os EFEITOS.
 *
 * A leitura da API é de `./historico.ts` (puro). Aqui moram a rede, o banco e o
 * relógio: uma rodada pega uma importação viva, anda pelas conversas do
 * provedor até o orçamento de tempo acabar, guarda o cursor e devolve. A
 * rodada seguinte (o cron, a cada minuto) continua de onde parou — é isso que
 * faz uma caixa de seis meses caber em rodadas de 40 segundos e sobreviver a
 * um contêiner que reinicia no meio.
 *
 * ─── Silêncio total ─────────────────────────────────────────────────────────
 *
 * Nada aqui passa por `efeitosDaEntrada`/`aplicarEfeitosPosEntrada`. A escrita
 * de cada conversa é UMA chamada a `fn_importar_conversa_historica` (9012),
 * que liga a chave de transação que cala os gatilhos de `messages`: nenhum
 * `message.received`, nenhuma demanda, nenhuma fila, nenhuma IA, automação ou
 * follow-up. O negócio nasce por `fn_nascer_lead_da_conversa` SEM `lead.created`
 * — o gesto inteiro é auditado uma vez, como `lead.imported`.
 *
 * ─── Repetir é seguro ───────────────────────────────────────────────────────
 *
 * Mensagem: `unique (organization_id, external_id)`. Negócio: um aberto por
 * contato (`fn_nascer_lead_da_conversa`). Conversa: pela thread do provedor.
 * Uma página reprocessada depois de uma queda não duplica nada; e "importar de
 * novo" a mesma conexão traz só o que faltou.
 *
 * ─── Uma rodada por vez, de verdade (PC-042) ────────────────────────────────
 *
 * Com o banco lento, uma página de 100 conversas passou de 3 minutos; o
 * orçamento só era conferido entre PÁGINAS e o carimbo só era renovado no fim
 * de cada uma, então o cron do minuto seguinte achou a rodada "perdida" e abriu
 * outra na mesma página: deadlock, e as duas regravando `contagens` inteiras
 * (a tela chegou a mostrar 0 mensagens com milhares no banco). Agora:
 *  - o orçamento é conferido entre CONVERSAS;
 *  - cada conversa termina com uma gravação que renova o carimbo e guarda onde
 *    a rodada está dentro da página (`CHAVE_DA_RETOMADA`), para a rodada
 *    seguinte continuar dali sem refazer a página;
 *  - toda gravação é condicionada ao carimbo da própria rodada e a um estado
 *    vivo: se outra rodada pegou a importação, ou alguém a cancelou, a gravação
 *    não casa linha nenhuma e a rodada para sem escrever mais nada
 *    (`RodadaPerdeuAImportacao`). Contagens nunca voltam para trás.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { lerNumeroInternoDeAviso, ehOChatDoAviso } from "@/lib/escalacao/numero-interno-de-aviso";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { logger } from "@/lib/logger";

import { resolveZernioCreds, type ZernioCredentials } from "./credentials";
import {
  lerPaginaDeConversas,
  lerPaginaDeMensagens,
  type ConversaDoHistorico,
  type MensagemDoHistorico,
} from "./historico";
import { upsertContact, waIdentityFrom } from "./ingest";
import { triarLeadsImportados } from "../triagem-do-historico";

type Admin = SupabaseClient;

export const ESTADOS_VIVOS = ["na_fila", "importando", "triando"] as const;
export type EstadoDaImportacao = (typeof ESTADOS_VIVOS)[number] | "concluida" | "falhou" | "cancelada";

/** Rodada sem sinal de vida há mais que isto foi interrompida — outra pode pegar. */
export const RODADA_PERDIDA_MS = 3 * 60_000;
/** Tempo de trabalho por rodada. O cron corta em 60 s; o resto é folga. */
export const ORCAMENTO_DA_RODADA_MS = 40_000;
const TEMPO_LIMITE_HTTP_MS = 15_000;
const POR_PAGINA = 100;
/** Teto de mensagens por conversa: seis meses de um número cabem com folga. */
const TETO_DE_MENSAGENS = 5_000;
const FALHAS_GUARDADAS = 20;

export interface Importacao {
  id: string;
  organization_id: string;
  channel_session_id: string;
  pipeline_id: string | null;
  stage_id: string | null;
  triagem_ligada: boolean;
  estado: EstadoDaImportacao;
  cursor_conversas: string | null;
  contagens: Record<string, number>;
  falhas: Array<{ quando: string; conversa?: string; motivo: string }>;
  iniciada_por: string | null;
  criada_em: string;
}

const COLUNAS =
  "id, organization_id, channel_session_id, pipeline_id, stage_id, triagem_ligada, estado, cursor_conversas, contagens, falhas, iniciada_por, criada_em";

/** O provedor pediu para esperar. A rodada para; a próxima tenta de novo. */
export class ProvedorPediuEspera extends Error {
  constructor(public readonly segundos: number | null) {
    super("zernio_pediu_espera");
  }
}

/**
 * A gravação não casou a linha: outra rodada pegou a importação (o carimbo
 * mudou) ou ela não está mais viva (cancelada, concluída). A rodada para sem
 * escrever — quem tem a importação agora é que grava.
 */
export class RodadaPerdeuAImportacao extends Error {
  constructor() {
    super("rodada_perdeu_a_importacao");
  }
}

/**
 * Onde a rodada parou DENTRO da página: a impressão do id da última conversa
 * feita. Mora em `contagens` porque é a única coluna livre sem migration; é um
 * número (o tipo da coluna) e a tela só lê as chaves que conhece. Sai das
 * contagens quando a página termina e antes da auditoria final.
 */
export const CHAVE_DA_RETOMADA = "retomar_depois_de";

/** FNV-1a de 32 bits: estável, curto, e cabe num número do JSON. */
export function impressaoDoId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** O que a rodada escreveu por último: o carimbo (`atualizada_em`) e o estado. */
interface Posse {
  carimbo: string;
  estado: EstadoDaImportacao;
}

export interface Dependencias {
  fetch: typeof fetch;
  agora: () => number;
}

const PADRAO: Dependencias = { fetch: (...a) => fetch(...a), agora: () => Date.now() };

async function chamarApi(deps: Dependencias, creds: ZernioCredentials, caminho: string): Promise<unknown> {
  const res = await deps.fetch(`${creds.baseUrl}${caminho}`, {
    headers: { Authorization: `Bearer ${creds.apiKey}` },
    signal: AbortSignal.timeout(TEMPO_LIMITE_HTTP_MS),
  });
  if (res.status === 429 || res.status === 503) {
    const ra = Number(res.headers.get("retry-after"));
    throw new ProvedorPediuEspera(Number.isFinite(ra) && ra > 0 ? ra : null);
  }
  if (!res.ok) throw new Error(`zernio_${res.status}`);
  return res.json();
}

/** Todas as mensagens de uma conversa, da mais antiga para a mais nova. */
export async function buscarMensagensDaConversa(
  deps: Dependencias,
  creds: ZernioCredentials,
  conversaId: string,
): Promise<{ mensagens: MensagemDoHistorico[]; ignoradas: number }> {
  const mensagens: MensagemDoHistorico[] = [];
  let ignoradas = 0;
  let cursor: string | null = null;
  do {
    const qs = new URLSearchParams({ accountId: creds.accountId, limit: String(POR_PAGINA), sortOrder: "asc" });
    if (cursor) qs.set("cursor", cursor);
    const pagina = lerPaginaDeMensagens(
      await chamarApi(deps, creds, `/v1/inbox/conversations/${encodeURIComponent(conversaId)}/messages?${qs}`),
    );
    mensagens.push(...pagina.mensagens);
    ignoradas += pagina.ignoradas;
    cursor = pagina.proximoCursor;
  } while (cursor && mensagens.length < TETO_DE_MENSAGENS);
  return { mensagens, ignoradas };
}

function somar(c: Record<string, number>, chave: string, n = 1): void {
  c[chave] = (c[chave] ?? 0) + n;
}

function registrarFalha(imp: Importacao, motivo: string, conversa?: string): void {
  imp.falhas = [{ quando: new Date().toISOString(), ...(conversa ? { conversa } : {}), motivo: motivo.slice(0, 200) }, ...imp.falhas].slice(
    0,
    FALHAS_GUARDADAS,
  );
}

/**
 * Grava o estado da rodada — só se a importação ainda for DESTA rodada (o
 * carimbo é o que ela escreveu por último) e ainda estiver viva. Renova o
 * carimbo: é o sinal de vida que impede o cron de abrir uma segunda rodada.
 */
async function salvar(
  admin: Admin,
  imp: Importacao,
  posse: Posse,
  deps: Dependencias,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const carimbo = new Date(deps.agora()).toISOString();
  const { data, error } = await admin
    .from("importacoes_de_historico")
    .update({
      estado: imp.estado,
      cursor_conversas: imp.cursor_conversas,
      contagens: imp.contagens,
      falhas: imp.falhas,
      atualizada_em: carimbo,
      ...extra,
    })
    .eq("id", imp.id)
    .eq("organization_id", imp.organization_id)
    .eq("atualizada_em", posse.carimbo)
    // Viva — ou no estado final que a PRÓPRIA rodada acabou de gravar (a
    // conclusão grava duas vezes). Cancelada por outra mão nunca casa.
    .in("estado", [...new Set<string>([...ESTADOS_VIVOS, posse.estado])])
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`importacao_nao_salva: ${error.message}`);
  if (!data) throw new RodadaPerdeuAImportacao();
  posse.carimbo = carimbo;
  posse.estado = imp.estado;
}

/**
 * Pega a importação para esta rodada. Só uma rodada por vez: o `update`
 * condicional é o cadeado — quem não casar a linha (outra rodada acabou de
 * carimbá-la) sai sem nada. O carimbo escrito aqui é a posse da rodada.
 */
async function pegar(
  admin: Admin,
  id: string,
  deps: Dependencias,
): Promise<{ imp: Importacao; posse: Posse } | null> {
  const perdida = new Date(deps.agora() - RODADA_PERDIDA_MS).toISOString();
  const carimbo = new Date(deps.agora()).toISOString();
  // Na fila: sai dela no MESMO update. Enquanto a linha dizia `na_fila`, o
  // cron seguinte podia pegá-la de novo — a fila não olha o carimbo — e duas
  // rodadas andavam juntas na primeira página.
  const daFila = await admin
    .from("importacoes_de_historico")
    .update({ atualizada_em: carimbo, estado: "importando" })
    .eq("id", id)
    .eq("estado", "na_fila")
    .select(COLUNAS)
    .maybeSingle();
  let imp = (daFila.data as Importacao | null) ?? null;
  if (!imp) {
    // Já começada: só se a rodada anterior está sem sinal de vida.
    const perdidaDeVez = await admin
      .from("importacoes_de_historico")
      .update({ atualizada_em: carimbo })
      .eq("id", id)
      .in("estado", [...ESTADOS_VIVOS])
      .lt("atualizada_em", perdida)
      .select(COLUNAS)
      .maybeSingle();
    imp = (perdidaDeVez.data as Importacao | null) ?? null;
  }
  return imp ? { imp, posse: { carimbo, estado: imp.estado } } : null;
}

export async function pegarImportacao(admin: Admin, id: string, deps: Dependencias = PADRAO): Promise<Importacao | null> {
  return (await pegar(admin, id, deps))?.imp ?? null;
}

/** As importações que precisam de uma rodada agora. */
export async function importacoesPendentes(admin: Admin, deps: Dependencias = PADRAO): Promise<string[]> {
  const perdida = new Date(deps.agora() - RODADA_PERDIDA_MS).toISOString();
  const { data } = await admin
    .from("importacoes_de_historico")
    .select("id")
    .in("estado", [...ESTADOS_VIVOS])
    .or(`estado.eq.na_fila,atualizada_em.lt.${perdida}`)
    .order("criada_em", { ascending: true })
    .limit(5);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

/** O título do card: o nome que a pessoa usa, ou o telefone. */
function tituloDoNegocio(c: ConversaDoHistorico): string {
  return (c.identity.displayName ?? c.identity.phone ?? "").trim() || "Contato antigo do WhatsApp";
}

function dataCurta(iso: string | null): string {
  if (!iso) return "?";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
}

/** Uma conversa: contato, mensagens e negócio. Devolve `false` quando pulou. */
async function importarUmaConversa(
  admin: Admin,
  deps: Dependencias,
  creds: ZernioCredentials,
  imp: Importacao,
  conversa: ConversaDoHistorico,
  internoCfg: Awaited<ReturnType<typeof lerNumeroInternoDeAviso>>,
): Promise<void> {
  const c = imp.contagens;
  somar(c, "conversas_lidas");

  if (conversa.isGroup) {
    somar(c, "grupos_pulados");
    return;
  }
  // O número interno de avisos não vira contato nem negócio — mesma guarda da
  // ingestão, e ANTES do upsert (é ele que cria o contato).
  if (
    (internoCfg.destino || internoCfg.jid) &&
    ehOChatDoAviso({ kind: conversa.identity.phone ? "phone" : "unknown", phone: conversa.identity.phone, lid: null }, internoCfg)
  ) {
    somar(c, "numero_interno_pulado");
    return;
  }

  const identidade = waIdentityFrom(conversa.identity);
  if (!identidade) {
    somar(c, "sem_identidade");
    return;
  }

  const { mensagens, ignoradas } = await buscarMensagensDaConversa(deps, creds, conversa.id);
  somar(c, "mensagens_ignoradas", ignoradas);
  if (mensagens.length === 0) {
    somar(c, "conversas_vazias");
    return;
  }

  const contactId = await upsertContact(admin, imp.organization_id, { identity: conversa.identity, conversationId: conversa.id }, identidade);
  if (!contactId) throw new Error("contato_nao_resolvido");

  const { data: contato } = await admin
    .from("contacts")
    .select("created_at")
    .eq("organization_id", imp.organization_id)
    .eq("id", contactId)
    .maybeSingle();
  const criadoAgora = Boolean(
    (contato as { created_at?: string } | null)?.created_at &&
      (contato as { created_at: string }).created_at >= imp.criada_em,
  );
  somar(c, criadoAgora ? "contatos_criados" : "contatos_reaproveitados");

  const { data, error } = await admin.rpc("fn_importar_conversa_historica" as never, {
    p_org: imp.organization_id,
    p_session: imp.channel_session_id,
    p_contact: contactId,
    p_thread: conversa.id,
    p_mensagens: mensagens.map((m) => ({
      external_id: m.externalId,
      direction: m.direction,
      sent_at: m.sentAt,
      type: m.type,
      body: m.body,
      status: m.status,
      media_url: m.mediaUrl,
      media_mime: m.mediaMime,
      metadata: { ...m.metadata, importacao_id: imp.id },
    })),
    p_pipeline: imp.pipeline_id,
    p_stage: imp.stage_id,
    p_titulo: tituloDoNegocio(conversa),
    p_importacao: imp.id,
  } as never);
  if (error) throw new Error(`gravacao_falhou: ${error.message}`);

  const r = data as {
    conversation_id: string;
    contact_id: string;
    gravadas: number;
    repetidas: number;
    ultima_mensagem_em: string | null;
    lead_id: string | null;
    lead_motivo: string;
    com_midia: string[];
  };
  somar(c, "mensagens_gravadas", r.gravadas);
  somar(c, "mensagens_repetidas", r.repetidas);
  somar(c, "midias_sem_arquivo", mensagens.filter((m) => m.midiaSemArquivo).length);
  if (r.lead_motivo === "criado") somar(c, "negocios_criados");
  else if (r.lead_motivo !== "sem_destino") somar(c, `negocios_pulados_${r.lead_motivo}`);

  // A mídia que ainda tem arquivo vai para o mesmo trabalhador que guarda a
  // mídia da ingestão — a URL do provedor expira, e a cópia é nossa.
  for (const messageId of r.com_midia ?? []) {
    await admin.rpc("emit_event" as never, {
      p_event_type: "media.persist_requested",
      p_entity_kind: "message",
      p_entity_id: messageId,
      p_payload: { message_id: messageId, conversation_id: r.conversation_id },
      p_metadata: { source: "zernio_importacao" },
      p_organization_id: imp.organization_id,
    } as never);
  }

  if (r.lead_id) {
    // A linha do tempo diz de onde o card veio e QUANDO a conversa parou —
    // "parou há 30 dias" e "parou há 5 meses" pedem abordagens diferentes.
    await emitLeadActivity(admin, {
      organizationId: imp.organization_id,
      leadId: r.lead_id,
      contactId: r.contact_id,
      type: "lead_created",
      sourceModule: "canal.importacao",
      sourceId: imp.id,
      actor: { type: "webhook_source", id: "importacao-de-historico" },
      reason: `Importado do histórico do WhatsApp — última mensagem em ${dataCurta(r.ultima_mensagem_em)}`,
      payload: { conversation_id: r.conversation_id, ultima_mensagem_em: r.ultima_mensagem_em, importacao_id: imp.id },
    });
  }
}

export interface ResultadoDaRodada {
  estado: EstadoDaImportacao;
  conversas: number;
  parouPor: "fim" | "tempo" | "espera_do_provedor" | "erro" | "nada" | "perdeu_a_vez";
}

/**
 * Uma rodada de trabalho numa importação. Nunca lança: o desfecho fica na
 * linha (`estado`, `falhas`) — é ali que a tela e quem depura olham.
 */
export async function rodarImportacao(
  admin: Admin,
  id: string,
  deps: Dependencias = PADRAO,
): Promise<ResultadoDaRodada> {
  const inicio = deps.agora();
  const pega = await pegar(admin, id, deps);
  if (!pega) return { estado: "na_fila", conversas: 0, parouPor: "nada" };
  const { imp, posse } = pega;
  const acabouOTempo = () => deps.agora() - inicio >= ORCAMENTO_DA_RODADA_MS;

  imp.contagens = { ...(imp.contagens ?? {}) };
  imp.falhas = Array.isArray(imp.falhas) ? imp.falhas : [];
  let conversas = 0;

  try {
    if (imp.estado === "na_fila") imp.estado = "importando";

    if (imp.estado === "importando") {
      const { data: sessao } = await admin
        .from("channel_sessions")
        .select("zernio_account_id")
        .eq("organization_id", imp.organization_id)
        .eq("id", imp.channel_session_id)
        .maybeSingle();
      const accountId = (sessao as { zernio_account_id?: string | null } | null)?.zernio_account_id ?? null;
      const creds = accountId
        ? await resolveZernioCreds(admin, { organizationId: imp.organization_id, accountId })
        : null;
      if (!creds) {
        imp.estado = "falhou";
        registrarFalha(imp, "A conexão não tem a chave do provedor, ou não é mais uma conexão deste tipo.");
        await salvar(admin, imp, posse, deps, { concluida_em: new Date(deps.agora()).toISOString() });
        return { estado: imp.estado, conversas, parouPor: "erro" };
      }
      const interno = await lerNumeroInternoDeAviso(admin, imp.organization_id);

      paginas: while (!acabouOTempo()) {
        const qs = new URLSearchParams({
          accountId: creds.accountId,
          platform: "whatsapp",
          limit: String(POR_PAGINA),
          sortOrder: "desc",
        });
        if (imp.cursor_conversas) qs.set("cursor", imp.cursor_conversas);
        const pagina = lerPaginaDeConversas(await chamarApi(deps, creds, `/v1/inbox/conversations?${qs}`), creds.accountId);
        if (pagina.contaRecusada) throw new ProvedorPediuEspera(pagina.contaRecusada.esperarSegundos);

        // Página retomada: continua depois da última conversa feita. Se ela não
        // está mais na página (a lista do provedor andou), refaz a página
        // inteira — refazer é seguro (ver o cabeçalho), pular não seria.
        const retomada = imp.contagens[CHAVE_DA_RETOMADA];
        let comeco = 0;
        if (typeof retomada === "number") {
          const feita = pagina.conversas.findIndex((c) => impressaoDoId(c.id) === retomada);
          comeco = feita >= 0 ? feita + 1 : 0;
        } else {
          somar(imp.contagens, "sem_identidade", pagina.semIdentidade);
        }

        for (let i = comeco; i < pagina.conversas.length; i++) {
          // O orçamento é conferido entre CONVERSAS: com o banco lento, uma
          // página inteira passa de minutos.
          if (acabouOTempo()) break paginas;
          const conversa = pagina.conversas[i]!;
          try {
            await importarUmaConversa(admin, deps, creds, imp, conversa, interno);
          } catch (err) {
            if (err instanceof ProvedorPediuEspera) throw err;
            somar(imp.contagens, "falhas");
            registrarFalha(imp, err instanceof Error ? err.message : String(err), conversa.id);
          }
          conversas++;
          imp.contagens[CHAVE_DA_RETOMADA] = impressaoDoId(conversa.id);
          // Sinal de vida + progresso, a cada conversa.
          await salvar(admin, imp, posse, deps);
        }

        // Página feita: o cursor anda e a marca de retomada sai.
        delete imp.contagens[CHAVE_DA_RETOMADA];
        imp.cursor_conversas = pagina.proximoCursor;
        if (!pagina.proximoCursor) {
          imp.estado = imp.triagem_ligada && imp.pipeline_id ? "triando" : "concluida";
          break;
        }
        await salvar(admin, imp, posse, deps);
      }
      await salvar(admin, imp, posse, deps);
    }

    if (imp.estado === "triando") {
      const restante = ORCAMENTO_DA_RODADA_MS - (deps.agora() - inicio);
      if (restante > 5_000) {
        const t = await triarLeadsImportados(admin, imp, restante, deps);
        for (const [k, v] of Object.entries(t.contagens)) somar(imp.contagens, k, v);
        if (t.terminou) imp.estado = "concluida";
        await salvar(admin, imp, posse, deps);
      }
    }

    if (imp.estado === "concluida") {
      await concluir(admin, imp, posse, deps);
      return { estado: imp.estado, conversas, parouPor: "fim" };
    }
    return { estado: imp.estado, conversas, parouPor: "tempo" };
  } catch (err) {
    if (err instanceof RodadaPerdeuAImportacao) {
      // Outra rodada tem a importação, ou ela foi cancelada: nada a gravar.
      logger.info("[importacao-historico] rodada perdeu a importação", {
        organization_id: imp.organization_id,
        importacao_id: imp.id,
      });
      return { estado: imp.estado, conversas, parouPor: "perdeu_a_vez" };
    }
    if (err instanceof ProvedorPediuEspera) {
      registrarFalha(imp, `O provedor pediu para esperar${err.segundos ? ` ${err.segundos} s` : ""}; a próxima rodada continua.`);
      await salvar(admin, imp, posse, deps).catch(() => undefined);
      return { estado: imp.estado, conversas, parouPor: "espera_do_provedor" };
    }
    logger.error("[importacao-historico] rodada falhou", {
      organization_id: imp.organization_id,
      importacao_id: imp.id,
      erro: err instanceof Error ? err.message : String(err),
    });
    // Falha de rede ou do banco no meio: a linha segue viva e a próxima
    // rodada tenta de novo. Só a falta de credencial (acima) encerra.
    registrarFalha(imp, err instanceof Error ? err.message : String(err));
    await salvar(admin, imp, posse, deps).catch(() => undefined);
    return { estado: imp.estado, conversas, parouPor: "erro" };
  }
}

/**
 * O relatório final, CONTADO no banco — as contagens das rodadas são
 * progresso (uma página refeita conta duas vezes); o que vai para a auditoria
 * é medido.
 */
async function concluir(admin: Admin, imp: Importacao, posse: Posse, deps: Dependencias): Promise<void> {
  const [{ count: mensagens }, { count: negocios }] = await Promise.all([
    admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", imp.organization_id)
      .eq("metadata->>importacao_id", imp.id),
    admin
      .from("crm_leads")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", imp.organization_id)
      .eq("source", "importado_zernio")
      .eq("source_metadata->>importacao_id", imp.id),
  ]);
  imp.contagens = {
    ...imp.contagens,
    mensagens_no_banco: mensagens ?? 0,
    negocios_no_banco: negocios ?? 0,
  };
  delete imp.contagens[CHAVE_DA_RETOMADA];
  await salvar(admin, imp, posse, deps, { concluida_em: new Date(deps.agora()).toISOString() });
  await audit({
    action: "lead.imported",
    actorUserId: imp.iniciada_por,
    organizationId: imp.organization_id,
    resourceType: "importacao_de_historico",
    resourceId: imp.id,
    bypassedRls: true,
    metadata: { origem: "zernio", channel_session_id: imp.channel_session_id, ...imp.contagens },
  });
}
