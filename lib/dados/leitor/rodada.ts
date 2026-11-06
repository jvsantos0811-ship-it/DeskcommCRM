/**
 * UMA PASSADA DO LEITOR NUMA ORGANIZAÇÃO — PM-027 §2 a §4.
 *
 * Acha os leads que mudaram desde a última leitura (`decidirLeitura`), lê a
 * conversa inteira de cada um (todas as conversas do contato, sem grupo), grava
 * a Ficha e, para o lead que voltou com potencial, abre o aviso `lead_voltou`
 * na Central. Não move etapa, não mexe em marcador, não fala com ninguém.
 *
 * Quem chama decide o orçamento (tempo e número de leituras): a rodada diária
 * das 06:00 e o "Atualizar agora" chamam esta função (`rodadas.ts`). O que não
 * coube fica para a passada seguinte — a seleção é por "mudou desde a ficha",
 * então nada se perde nem é lido duas vezes.
 *
 * Um lead que falha não para os outros. Sem modelo, modelo diferente do
 * aprovado e teto de gasto param a passada inteira: os próximos dariam no mesmo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { alcanceDaOrg, funisLidos, posicaoNoAlcance, type FunilDaOrg, type PosicaoNoAlcance } from "@/lib/dados/alcance-do-leitor";
import { expedienteDaOrg } from "@/lib/dados/expediente";
import type { AtendidoPor, FatosDoBanco, FichaDoLeitor, Gatilho } from "@/lib/dados/ficha";
import { classificarFicha, FORA_DA_VENDA } from "@/lib/dados/regra-da-ficha";
import { ehContatoDoNumeroInterno } from "@/lib/escalacao/numero-interno-de-aviso";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";

import { configDoLeitor, configEfetivaDoLeitor, leitorPodeRodar, type PadraoDoLeitor } from "./config";
import type { Leitor } from "./ler-lead";
import { lerPadraoDoLeitor } from "./padrao";
import { montarPromptDoLeitor, transcreverConversa, VERSAO_DO_PROMPT, type MensagemParaOLeitor, type VariaveisDoPrompt } from "./prompt";
import { decidirLeitura } from "./selecao";

const DIA_MS = 86_400_000;
/** Até quanto para trás procurar conversa mexida (a seleção ainda confere o marco). */
export const JANELA_DE_BUSCA_DIAS = 14;
export const CONVERSAS_POR_PASSADA = 1_000;
/** Teto de segurança de leituras numa passada (o custo esperado é ~20/dia). */
export const LEITURAS_POR_PASSADA = 150;
const MENSAGENS_LIDAS = 400;
const LOTE = 200;

export const KIND_LEAD_VOLTOU = "lead_voltou";

export interface OrgDoLeitor {
  id: string;
  settings: unknown;
  timezone: string | null;
  display_name: string | null;
  locale: string | null;
  /** Quando a organização nasceu: quem segue o padrão da instalação não lê nada antes disso. */
  created_at: string | null;
}

export interface ResultadoDaPassada {
  candidatos: number;
  lidos: number;
  falhas: number;
  /** Leads que pediam leitura e ficaram para a passada seguinte (orçamento). */
  restantes: number;
  avisos: number;
  parou: null | "desligado" | "sem_modelo" | "modelo_diferente" | "teto";
  ultimoErro: string | null;
}

export interface DepsDaPassada {
  agora: Date;
  ler: Leitor;
  /** Instante (ms) a partir do qual não começa leitura nova. */
  ateMs: number;
  maxLeituras?: number;
  ehInterno?: (db: SupabaseClient, orgId: string, contactId: string) => Promise<boolean>;
  /** O modelo padrão da instalação, já lido por quem chama; ausente = a passada lê. */
  padrao?: PadraoDoLeitor | null;
}

interface ConversaRow {
  id: string;
  contact_id: string | null;
  created_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
}
interface LeadRow {
  id: string;
  contact_id: string | null;
  pipeline_id: string;
  tags: string[] | null;
  created_at: string;
  etapa: { name: string; is_won: boolean; is_lost: boolean; is_archived: boolean } | null;
}
interface MensagemRow extends MensagemParaOLeitor {
  sent_by_user_id: string | null;
}

const data = (s: string | null | undefined) => (s ? new Date(s) : null);
const maior = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);

function emLotes<T>(xs: T[], n = LOTE): T[][] {
  const r: T[][] = [];
  for (let i = 0; i < xs.length; i += n) r.push(xs.slice(i, i + n));
  return r;
}

// ─── fatos do banco (puros) ─────────────────────────────────────────────────

/** Saída de verdade: não falhou e não é nota interna. */
const saidaQueChegou = (m: MensagemParaOLeitor) => m.direction === "outbound" && m.status !== "failed" && m.sent_via !== "system";

export function fatosDoBanco(
  lead: Pick<LeadRow, "id" | "created_at">,
  outrosAbertosDoContato: Array<Pick<LeadRow, "id" | "created_at">>,
  mensagens: MensagemParaOLeitor[],
  ultimaEntrada: Date | null,
): FatosDoBanco {
  const escreveu = mensagens.some((m) => m.direction === "inbound");
  return {
    ultima_fala_do_lead: ultimaEntrada,
    duplicado: outrosAbertosDoContato.some((o) => o.id !== lead.id && o.created_at < lead.created_at),
    nunca_respondido: escreveu && !mensagens.some(saidaQueChegou),
    midia_nao_entendida: false,
  };
}

export function atendidoPor(mensagens: MensagemRow[], agentes: string[]): AtendidoPor {
  const pessoas = new Set<string>();
  let celular = false;
  for (const m of mensagens) {
    if (!saidaQueChegou(m)) continue;
    if ((m.sent_via === "user" || m.sent_via === "crm") && m.sent_by_user_id) pessoas.add(m.sent_by_user_id);
    if (m.sent_via === "external_device") celular = true;
  }
  return { agentes, pessoas_pelo_crm: pessoas.size, pelo_celular: celular };
}

// ─── a passada ──────────────────────────────────────────────────────────────

export async function passadaDoLeitor(admin: SupabaseClient, org: OrgDoLeitor, deps: DepsDaPassada): Promise<ResultadoDaPassada> {
  const r: ResultadoDaPassada = { candidatos: 0, lidos: 0, falhas: 0, restantes: 0, avisos: 0, parou: null, ultimoErro: null };
  const padrao = deps.padrao !== undefined ? deps.padrao : await lerPadraoDoLeitor(admin);
  const config = configEfetivaDoLeitor(configDoLeitor(org.settings), org.created_at, padrao);
  const pode = leitorPodeRodar(config);
  if (!pode.pode) {
    r.parou = pode.porque;
    return r;
  }
  const { agora } = deps;
  const orgId = org.id;
  const expediente = expedienteDaOrg(org.settings, org.timezone);
  const alcance = alcanceDaOrg(org.settings);
  const ehInterno = deps.ehInterno ?? ehContatoDoNumeroInterno;

  const { data: funisData, error: funisErr } = await admin
    .from("crm_pipelines")
    .select("id, is_archived, is_client_pipeline")
    .eq("organization_id", orgId);
  if (funisErr) throw new Error(`funis: ${funisErr.message}`);
  const funis = (funisData ?? []) as FunilDaOrg[];
  const lidos = funisLidos(alcance, funis);
  if (lidos.size === 0) return r;

  // 1. Conversas mexidas desde o marco (o Leitor ligado, no máximo 14 dias atrás).
  const desde = new Date(Math.max(pode.ligadoEm.getTime(), agora.getTime() - JANELA_DE_BUSCA_DIAS * DIA_MS));
  const { data: convData, error: convErr } = await admin
    .from("conversations")
    .select("id, contact_id, created_at, last_inbound_at, last_outbound_at")
    .eq("organization_id", orgId)
    .eq("is_group", false)
    .gte("last_message_at", desde.toISOString())
    .order("last_message_at", { ascending: false })
    .limit(CONVERSAS_POR_PASSADA);
  if (convErr) throw new Error(`conversas: ${convErr.message}`);
  const porContato = new Map<string, { criadaEm: Date | null; ultimaEntrada: Date | null; ultimaSaida: Date | null }>();
  for (const c of (convData ?? []) as ConversaRow[]) {
    if (!c.contact_id) continue;
    const a = porContato.get(c.contact_id) ?? { criadaEm: null, ultimaEntrada: null, ultimaSaida: null };
    porContato.set(c.contact_id, {
      criadaEm: maior(a.criadaEm, data(c.created_at)),
      ultimaEntrada: maior(a.ultimaEntrada, data(c.last_inbound_at)),
      ultimaSaida: maior(a.ultimaSaida, data(c.last_outbound_at)),
    });
  }
  if (porContato.size === 0) return r;

  // 2. Contatos bloqueados ficam de fora; os negócios desses contatos e as fichas.
  const contatos = [...porContato.keys()];
  const bloqueado = new Set<string>();
  const leads: LeadRow[] = [];
  for (const lote of emLotes(contatos)) {
    const { data: cs, error: cErr } = await admin.from("contacts").select("id, is_blocked").eq("organization_id", orgId).in("id", lote);
    if (cErr) throw new Error(`contatos: ${cErr.message}`);
    for (const c of (cs ?? []) as Array<{ id: string; is_blocked: boolean | null }>) if (c.is_blocked) bloqueado.add(c.id);
    const { data: ls, error: lErr } = await admin
      .from("crm_leads")
      .select("id, contact_id, pipeline_id, tags, created_at, etapa:crm_stages!crm_leads_stage_id_fkey(name, is_won, is_lost, is_archived)")
      .eq("organization_id", orgId)
      .in("contact_id", lote);
    if (lErr) throw new Error(`negocios: ${lErr.message}`);
    leads.push(...((ls ?? []) as unknown as LeadRow[]));
  }
  const fichaAnterior = new Map<string, Date | null>();
  for (const lote of emLotes(leads.map((l) => l.id))) {
    const { data: fs, error: fErr } = await admin
      .from("crm_lead_ficha")
      .select("lead_id, mensagens_ate")
      .eq("organization_id", orgId)
      .in("lead_id", lote);
    if (fErr) throw new Error(`fichas: ${fErr.message}`);
    for (const f of (fs ?? []) as Array<{ lead_id: string; mensagens_ate: string | null }>) fichaAnterior.set(f.lead_id, data(f.mensagens_ate));
  }

  // 3. Quem pede leitura, do mais recente para o mais antigo.
  const abertosPorContato = new Map<string, LeadRow[]>();
  const aLer: Array<{ lead: LeadRow; posicao: PosicaoNoAlcance; gatilho: Gatilho; ultimaEntrada: Date | null }> = [];
  for (const l of leads) {
    if (!l.contact_id || !l.etapa || bloqueado.has(l.contact_id)) continue;
    const posicao = posicaoNoAlcance({ pipeline_id: l.pipeline_id, tags: l.tags, etapa: l.etapa }, lidos, alcance);
    if (posicao === "com_potencial") abertosPorContato.set(l.contact_id, [...(abertosPorContato.get(l.contact_id) ?? []), l]);
    const conversa = porContato.get(l.contact_id)!;
    const d = decidirLeitura(
      {
        posicao,
        leituraAnterior: fichaAnterior.has(l.id) ? { mensagensAte: fichaAnterior.get(l.id) ?? null } : null,
        conversa,
      },
      { ligadoEm: pode.ligadoEm, expediente },
    );
    if (d.ler) aLer.push({ lead: l, posicao, gatilho: d.gatilho, ultimaEntrada: conversa.ultimaEntrada });
  }
  aLer.sort((a, b) => (b.ultimaEntrada?.getTime() ?? 0) - (a.ultimaEntrada?.getTime() ?? 0));
  r.candidatos = aLer.length;
  if (aLer.length === 0) return r;

  // 4. O prompt da organização (uma vez por passada).
  const sistema = await promptDaOrg(admin, org, config);
  const idioma = normalizarIdioma(org.locale);
  const t = (s: string) => traduzir(s, idioma);
  const maxLeituras = deps.maxLeituras ?? LEITURAS_POR_PASSADA;

  let feitas = 0;
  for (const item of aLer) {
    if (feitas >= maxLeituras || Date.now() >= deps.ateMs) break;
    const contato = item.lead.contact_id!;
    try {
      if (await ehInterno(admin, orgId, contato)) continue;
      feitas += 1;
      const mensagens = await mensagensDoContato(admin, orgId, contato);
      if (mensagens.length === 0) continue;
      const leitura = await deps.ler({
        organizationId: orgId,
        contactId: contato,
        sistema,
        conversa: transcreverConversa(mensagens, expediente.timezone),
        aprovado: pode.modelo,
        reserva: config.reserva,
      });
      if (leitura.tipo === "sem_modelo" || leitura.tipo === "modelo_diferente" || leitura.tipo === "teto") {
        r.parou = leitura.tipo;
        r.ultimoErro = leitura.tipo === "modelo_diferente" ? `modelo ${leitura.usado} no lugar de ${leitura.aprovado}` : leitura.tipo;
        break;
      }
      if (leitura.tipo === "falhou") {
        r.falhas += 1;
        r.ultimoErro = leitura.erro;
        continue;
      }
      const agentes = await agentesQueAtenderam(admin, orgId, contato);
      await gravarFicha(admin, orgId, item.lead, contato, leitura.ficha, leitura.modelo, item.gatilho, mensagens, agentes);
      r.lidos += 1;

      if (item.gatilho === "lead_voltou") {
        const banco = fatosDoBanco(item.lead, abertosPorContato.get(contato) ?? [], mensagens, item.ultimaEntrada);
        const c = classificarFicha({ ficha: leitura.ficha, banco }, agora);
        if (!FORA_DA_VENDA.has(c.situacao) && (await abrirAvisoLeadVoltou(admin, orgId, item.lead, item.ultimaEntrada, expediente.timezone, idioma, t))) {
          r.avisos += 1;
        }
      }
    } catch (err) {
      r.falhas += 1;
      r.ultimoErro = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      logger.warn("[leitor] lead falhou (os outros seguem)", { organization_id: orgId, lead_id: item.lead.id, detalhe: r.ultimoErro });
    }
  }
  r.restantes = r.parou ? aLer.length - r.lidos : Math.max(0, aLer.length - feitas);
  return r;
}

// ─── leituras e gravações ───────────────────────────────────────────────────

/** As variáveis do prompt-molde desta organização, hoje (também congeladas nos casos da bateria). */
export async function variaveisDoPromptDaOrg(
  admin: SupabaseClient,
  org: Pick<OrgDoLeitor, "id" | "display_name">,
  config: ReturnType<typeof configDoLeitor>,
): Promise<VariaveisDoPrompt> {
  const [agentesR, tiposR] = await Promise.all([
    admin.from("ai_agents").select("name").eq("organization_id", org.id).limit(20),
    admin
      .from("catalog_products")
      .select("nome, requisitos")
      .eq("organization_id", org.id)
      .eq("tipo_de_lead", true)
      .eq("ativo", true)
      .order("nome")
      .limit(60),
  ]);
  if (agentesR.error) throw new Error(`agentes: ${agentesR.error.message}`);
  if (tiposR.error) throw new Error(`tipos: ${tiposR.error.message}`);
  return {
    organizacao: org.display_name?.trim() || "a empresa",
    agentes: ((agentesR.data ?? []) as Array<{ name: string | null }>).map((a) => a.name ?? "").filter(Boolean),
    tipos: ((tiposR.data ?? []) as Array<{ nome: string; requisitos: string[] | null }>).map((x) => ({
      nome: x.nome,
      requisitos: x.requisitos ?? [],
    })),
    prefixosDeAnuncio: config.prefixos_de_anuncio,
    termoDoContrato: config.termo_do_contrato,
  };
}

async function promptDaOrg(admin: SupabaseClient, org: OrgDoLeitor, config: ReturnType<typeof configDoLeitor>): Promise<string> {
  return montarPromptDoLeitor(await variaveisDoPromptDaOrg(admin, org, config));
}

/** As mensagens do contato (todas as conversas sem grupo), da mais antiga à mais nova; `ate` congela. */
export async function mensagensDoContato(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
  ate: Date | null = null,
): Promise<MensagemRow[]> {
  const { data: convs, error: cErr } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("is_group", false);
  if (cErr) throw new Error(`conversas do contato: ${cErr.message}`);
  const ids = ((convs ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (ids.length === 0) return [];
  const { data: ms, error: mErr } = await admin
    .from("messages")
    .select("direction, sent_via, type, body, media_derived_text, status, created_at, sent_by_user_id")
    .eq("organization_id", orgId)
    .in("conversation_id", ids)
    .lte("created_at", (ate ?? new Date("9999-12-31T00:00:00Z")).toISOString())
    .order("created_at", { ascending: false })
    .limit(MENSAGENS_LIDAS);
  if (mErr) throw new Error(`mensagens: ${mErr.message}`);
  return ((ms ?? []) as MensagemRow[]).reverse();
}

async function agentesQueAtenderam(admin: SupabaseClient, orgId: string, contactId: string): Promise<string[]> {
  const { data: chamadas } = await admin
    .from("llm_calls")
    .select("agent_id")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("purpose", "agent_turn")
    .not("agent_id", "is", null)
    .limit(200);
  const ids = [...new Set(((chamadas ?? []) as Array<{ agent_id: string }>).map((c) => c.agent_id))];
  if (ids.length === 0) return [];
  const { data: agentes } = await admin.from("ai_agents").select("id, name").eq("organization_id", orgId).in("id", ids);
  return ((agentes ?? []) as Array<{ name: string | null }>).map((a) => a.name ?? "").filter(Boolean);
}

async function gravarFicha(
  admin: SupabaseClient,
  orgId: string,
  lead: LeadRow,
  contactId: string,
  ficha: FichaDoLeitor,
  modelo: string,
  gatilho: Gatilho,
  mensagens: MensagemRow[],
  agentes: string[],
): Promise<void> {
  const ate = mensagens.length > 0 ? mensagens[mensagens.length - 1]!.created_at : null;
  const { error } = await admin.from("crm_lead_ficha").upsert(
    {
      organization_id: orgId,
      lead_id: lead.id,
      contact_id: contactId,
      ficha,
      atendido_por: atendidoPor(mensagens, agentes),
      modelo,
      versao_prompt: VERSAO_DO_PROMPT,
      gatilho,
      lida_em: new Date().toISOString(),
      mensagens_ate: ate,
    },
    { onConflict: "organization_id,lead_id" },
  );
  if (error) throw new Error(`ficha: ${error.message}`);
}

/** Abre o aviso "Um lead perdido voltou a escrever". Já aberto (23505) não é erro. */
async function abrirAvisoLeadVoltou(
  admin: SupabaseClient,
  orgId: string,
  lead: LeadRow,
  quando: Date | null,
  fuso: string,
  idioma: string,
  t: (s: string) => string,
): Promise<boolean> {
  const em = quando ?? new Date();
  const dia = new Intl.DateTimeFormat(idioma, { timeZone: fuso, day: "2-digit", month: "2-digit" }).format(em);
  const hora = new Intl.DateTimeFormat(idioma, { timeZone: fuso, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(em);
  const etapa = lead.etapa?.name ? ` ${t("Etapa: {etapa}.").replace("{etapa}", lead.etapa.name)}` : "";
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: orgId,
    kind: KIND_LEAD_VOLTOU,
    severity: "warn",
    title: t("Um lead perdido voltou a escrever"),
    body: `${t("O lead voltou a escrever em {dia} às {hora} e a conversa mostra que ainda pode virar negócio.").replace("{dia}", dia).replace("{hora}", hora)}${etapa}`,
    ref_kind: "lead",
    ref_id: lead.id,
  });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`aviso: ${error.message}`);
}
