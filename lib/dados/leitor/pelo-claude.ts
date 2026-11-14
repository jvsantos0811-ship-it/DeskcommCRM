/**
 * O LEITOR PELO CLAUDE — PC-036.
 *
 * A organização com a escolha `claude` (`config.ts`) não é lida pelo cron do
 * CRM: quem lê é uma tarefa agendada do Claude, de fora, pela porta Ficha da
 * agência (`lib/mcp/agencia/ferramentas-da-ficha.ts`). O CRM não chama modelo
 * nenhum aqui (zero `llm_calls` de `leitor_da_conversa`) — só faz o que o
 * Leitor do CRM faz em volta da leitura, pelas MESMAS funções:
 *
 *   1. `pendentesPeloClaude`   — quem o Leitor leria agora (`selecionarParaLeitura`);
 *   2. `materialDaLeitura`     — o prompt da organização já montado
 *                                (`montarPromptDoLeitor`), a conversa transcrita
 *                                (`transcreverConversa`), os fatos do banco e a
 *                                ficha anterior: o que o modelo do CRM receberia;
 *   3. `gravarFichaPeloClaude` — valida pelo schema central, grava pelo mesmo
 *                                `gravarFicha` (o gatilho do banco guarda a
 *                                anterior no histórico), calcula a regra fixa e
 *                                abre o aviso `lead_voltou` quando a regra manda;
 *   4. `concluirRodadaPeloClaude` — fecha a rodada do dia (`origem = 'claude'`);
 *                                o cron do retrato, que a esperava, gera o do dia.
 *
 * Não move card, não muda etapa, não mexe em marcador ou campo, não fala com
 * ninguém (decisão do João de 12/11). Toda função recusa organização que não
 * esteja em `claude`, com `RecusaDoLeitorPeloClaude`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { alcanceDaOrg, funisLidos, posicaoNoAlcance, type FunilDaOrg, type PosicaoNoAlcance } from "@/lib/dados/alcance-do-leitor";
import { expedienteDaOrg } from "@/lib/dados/expediente";
import { fichaDoLeitorSchema, GATILHOS, lerFicha, type FichaDoLeitor, type Gatilho, type OrigemDaFicha } from "@/lib/dados/ficha";
import { classificarFicha, type AcaoDaFicha, type AlertaDaFicha } from "@/lib/dados/regra-da-ficha";
import { diaNoFuso } from "@/lib/dados/retrato";
import { ehContatoDoNumeroInterno } from "@/lib/escalacao/numero-interno-de-aviso";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

import { configDoLeitor, configEfetivaDoLeitor, leitorPeloClaude } from "./config";
import { montarPromptDoLeitor, transcreverConversa, VERSAO_DO_PROMPT } from "./prompt";
import type { OrigemDaRodada } from "./rodadas";
import {
  agentesQueAtenderam,
  avisarSeOLeadVoltou,
  fatosDoBanco,
  gravarFicha,
  mensagensDoContato,
  selecionarParaLeitura,
  variaveisDoPromptDaOrg,
  type LeadRow,
  type OrgDoLeitor,
} from "./rodada";

/** Teto de leads por chamada de `pendentesPeloClaude` (PC-036 §4). */
export const PENDENTES_POR_CHAMADA = 50;
/** Origem da rodada do Claude em `leitor_rodadas` (migration 9033). */
export const ORIGEM_DA_RODADA_DO_CLAUDE = "claude" satisfies OrigemDaRodada;
/** Folga de relógio aceita em `mensagens_ate` (o relógio do Claude e o do banco). */
const FOLGA_DO_RELOGIO_MS = 5 * 60_000;

export const ORIGENS_DA_LEITURA_PELO_CLAUDE = ["leitor_0530", "gestor_17h10"] as const satisfies readonly OrigemDaFicha[];
export type OrigemDaLeituraPeloClaude = (typeof ORIGENS_DA_LEITURA_PELO_CLAUDE)[number];

export type CodigoDaRecusa =
  | "organizacao_nao_encontrada"
  | "leitor_nao_e_pelo_claude"
  | "lead_nao_encontrado"
  | "contato_fora_da_leitura"
  | "sem_mensagens"
  | "ficha_invalida"
  | "mensagens_ate_invalida"
  | "gatilho_nao_confere"
  | "leitura_mais_velha_que_a_atual";

/** Recusa com código: a porta devolve o código e a mensagem, sem dado do lead. */
export class RecusaDoLeitorPeloClaude extends Error {
  constructor(
    public readonly codigo: CodigoDaRecusa,
    message: string,
  ) {
    super(`${codigo}: ${message}`);
    this.name = "RecusaDoLeitorPeloClaude";
  }
}

interface OrgPeloClaude {
  org: OrgDoLeitor;
  ligadoEm: Date;
  config: ReturnType<typeof configDoLeitor>;
}

/** A organização, se ela é lida pelo Claude. Recusa nos outros casos. */
async function orgPeloClaude(admin: SupabaseClient, orgId: string): Promise<OrgPeloClaude> {
  const { data, error } = await admin
    .from("organizations")
    .select("id, settings, timezone, display_name, locale, created_at")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new Error(`organizacao: ${error.message}`);
  if (!data) throw new RecusaDoLeitorPeloClaude("organizacao_nao_encontrada", "Organization not found.");
  const org = data as OrgDoLeitor;
  const config = configDoLeitor(org.settings);
  // A escolha `claude` não depende do padrão da instalação: sem ler o padrão.
  const pelo = leitorPeloClaude(configEfetivaDoLeitor(config, org.created_at, null));
  if (!pelo) {
    throw new RecusaDoLeitorPeloClaude(
      "leitor_nao_e_pelo_claude",
      "This organization is not read by Claude. The owner turns it on in IA › Provedores › Leitor da conversa.",
    );
  }
  return { org, ligadoEm: pelo.ligadoEm, config };
}

const LEAD_COLUNAS =
  "id, contact_id, pipeline_id, tags, created_at, etapa:crm_stages!crm_leads_stage_id_fkey(name, is_won, is_lost, is_archived)";

interface LeadDaLeitura {
  lead: LeadRow;
  contactId: string;
}

/** O negócio desta organização e o contato dele, se o contato pode ser lido. */
async function leadDaLeitura(admin: SupabaseClient, orgId: string, leadId: string): Promise<LeadDaLeitura> {
  const { data, error } = await admin.from("crm_leads").select(LEAD_COLUNAS).eq("organization_id", orgId).eq("id", leadId).maybeSingle();
  if (error) throw new Error(`negocio: ${error.message}`);
  const lead = data as unknown as LeadRow | null;
  if (!lead || !lead.contact_id) throw new RecusaDoLeitorPeloClaude("lead_nao_encontrado", "Lead not found in this organization.");
  const { data: contato, error: eC } = await admin
    .from("contacts")
    .select("id, is_blocked, is_anonymized")
    .eq("organization_id", orgId)
    .eq("id", lead.contact_id)
    .maybeSingle();
  if (eC) throw new Error(`contato: ${eC.message}`);
  const c = contato as { is_blocked: boolean | null; is_anonymized: boolean | null } | null;
  // Bloqueado (pediu para parar) e anonimizado (LGPD) ficam fora, como no Leitor do CRM.
  if (!c || c.is_blocked || c.is_anonymized) {
    throw new RecusaDoLeitorPeloClaude("contato_fora_da_leitura", "This contact is not read (blocked, anonymized or missing).");
  }
  if (await ehContatoDoNumeroInterno(admin, orgId, lead.contact_id)) {
    throw new RecusaDoLeitorPeloClaude("contato_fora_da_leitura", "This contact is the internal notice number.");
  }
  return { lead, contactId: lead.contact_id };
}

interface NegociosDoContato {
  /** Os negócios com potencial do contato (o aviso `lead_voltou` e o "duplicado" olham). */
  abertos: LeadRow[];
  /** Onde cada negócio do contato está no alcance do Leitor, pelo id. */
  posicao: Map<string, PosicaoNoAlcance>;
}

async function negociosDoContato(admin: SupabaseClient, org: OrgDoLeitor, contactId: string): Promise<NegociosDoContato> {
  const alcance = alcanceDaOrg(org.settings);
  const [funisR, leadsR] = await Promise.all([
    admin.from("crm_pipelines").select("id, is_archived, is_client_pipeline").eq("organization_id", org.id),
    admin.from("crm_leads").select(LEAD_COLUNAS).eq("organization_id", org.id).eq("contact_id", contactId),
  ]);
  if (funisR.error) throw new Error(`funis: ${funisR.error.message}`);
  if (leadsR.error) throw new Error(`negocios: ${leadsR.error.message}`);
  const lidos = funisLidos(alcance, (funisR.data ?? []) as FunilDaOrg[]);
  const posicao = new Map<string, PosicaoNoAlcance>();
  for (const l of (leadsR.data ?? []) as unknown as LeadRow[]) {
    posicao.set(l.id, l.etapa ? posicaoNoAlcance({ pipeline_id: l.pipeline_id, tags: l.tags, etapa: l.etapa }, lidos, alcance) : "fora");
  }
  const abertos = ((leadsR.data ?? []) as unknown as LeadRow[]).filter((l) => posicao.get(l.id) === "com_potencial");
  return { abertos, posicao };
}

function ultimaEntradaDas(mensagens: Array<{ direction: string; created_at: string }>): Date | null {
  for (let i = mensagens.length - 1; i >= 0; i--) {
    if (mensagens[i]!.direction === "inbound") return new Date(mensagens[i]!.created_at);
  }
  return null;
}

// ─── 1. quem pede leitura ───────────────────────────────────────────────────

export interface PendenteDoClaude {
  lead_id: string;
  gatilho: Gatilho;
  /** `com_potencial` ou `pode_voltar` (o lead perdido que escreveu de novo). */
  posicao: "com_potencial" | "pode_voltar";
  etapa: string | null;
  ultima_fala_do_lead: string | null;
  ja_tem_ficha: boolean;
  /** A `mensagens_ate` da ficha atual (a leitura nova vai além dela). */
  mensagens_ate_da_ficha: string | null;
}

export interface ResultadoDosPendentes {
  dia: string;
  /** Desde quando a organização é lida pelo Claude (nada antes conta). */
  lido_desde: string;
  total: number;
  leads: PendenteDoClaude[];
  /** Pedem leitura e não vieram nesta chamada (teto). Peça de novo depois de gravar. */
  restantes: number;
}

/**
 * Os leads que o Leitor do CRM leria agora, pela MESMA seleção. Abre a rodada
 * do dia (`origem = 'claude'`) se ainda não existe: é ela que o retrato das
 * 06:00 espera.
 */
export async function pendentesPeloClaude(
  admin: SupabaseClient,
  orgId: string,
  opcoes: { agora: Date; limite?: number; ehInterno?: (db: SupabaseClient, orgId: string, contactId: string) => Promise<boolean> },
): Promise<ResultadoDosPendentes> {
  const { org, ligadoEm } = await orgPeloClaude(admin, orgId);
  const dia = diaNoFuso(opcoes.agora, fusoUtilizavel(org.timezone));
  const { error: eIns } = await admin.from("leitor_rodadas").insert({ organization_id: orgId, dia, origem: ORIGEM_DA_RODADA_DO_CLAUDE });
  if (eIns && eIns.code !== "23505") throw new Error(`abrir a rodada: ${eIns.message}`);

  const { aLer, fichaAnterior } = await selecionarParaLeitura(admin, org, { agora: opcoes.agora, ligadoEm });
  const limite = Math.max(1, Math.min(opcoes.limite ?? PENDENTES_POR_CHAMADA, PENDENTES_POR_CHAMADA));
  const ehInterno = opcoes.ehInterno ?? ehContatoDoNumeroInterno;
  const leads: PendenteDoClaude[] = [];
  let internos = 0;
  for (const item of aLer) {
    if (leads.length >= limite) break;
    if (await ehInterno(admin, orgId, item.lead.contact_id!)) {
      internos += 1;
      continue;
    }
    const anterior = fichaAnterior.get(item.lead.id);
    leads.push({
      lead_id: item.lead.id,
      gatilho: item.gatilho,
      posicao: item.posicao === "pode_voltar" ? "pode_voltar" : "com_potencial",
      etapa: item.lead.etapa?.name ?? null,
      ultima_fala_do_lead: item.ultimaEntrada?.toISOString() ?? null,
      ja_tem_ficha: fichaAnterior.has(item.lead.id),
      mensagens_ate_da_ficha: anterior ? anterior.toISOString() : null,
    });
  }
  return {
    dia,
    lido_desde: ligadoEm.toISOString(),
    total: aLer.length - internos,
    leads,
    restantes: Math.max(0, aLer.length - internos - leads.length),
  };
}

// ─── 2. o material da leitura ───────────────────────────────────────────────

/** O formato da ficha em JSON Schema (o mesmo `fichaDoLeitorSchema` que valida a gravação). */
export function formatoDaFicha(): Record<string, unknown> {
  return z.toJSONSchema(fichaDoLeitorSchema) as Record<string, unknown>;
}

export interface MaterialDaLeitura {
  lead_id: string;
  versao_prompt: string;
  /** As instruções do Leitor desta organização, exatamente as que o modelo do CRM receberia. */
  instrucoes: string;
  /** A conversa transcrita (todas as conversas do contato, sem grupo, até 400 mensagens). */
  conversa: string;
  /** A ficha tem de sair neste formato (JSON Schema). */
  formato_da_ficha: Record<string, unknown>;
  /** A hora da última mensagem lida: devolva este valor em `mensagens_ate` ao gravar. */
  mensagens_ate: string;
  mensagens_lidas: number;
  fatos_do_banco: { ultima_fala_do_lead: string | null; duplicado: boolean; nunca_respondido: boolean };
  ficha_anterior: {
    ficha: FichaDoLeitor | null;
    lida_em: string;
    mensagens_ate: string | null;
    modelo: string;
    origem: string | null;
  } | null;
}

export async function materialDaLeitura(admin: SupabaseClient, orgId: string, leadId: string): Promise<MaterialDaLeitura> {
  const { org, config } = await orgPeloClaude(admin, orgId);
  const { lead, contactId } = await leadDaLeitura(admin, orgId, leadId);
  const mensagens = await mensagensDoContato(admin, orgId, contactId);
  if (mensagens.length === 0) throw new RecusaDoLeitorPeloClaude("sem_mensagens", "This contact has no messages to read.");
  const expediente = expedienteDaOrg(org.settings, org.timezone);
  const [variaveis, negocios, fichaR] = await Promise.all([
    variaveisDoPromptDaOrg(admin, org, config),
    negociosDoContato(admin, org, contactId),
    admin
      .from("crm_lead_ficha")
      .select("ficha, lida_em, mensagens_ate, modelo, origem")
      .eq("organization_id", orgId)
      .eq("lead_id", lead.id)
      .maybeSingle(),
  ]);
  if (fichaR.error) throw new Error(`ficha: ${fichaR.error.message}`);
  const anterior = fichaR.data as { ficha: unknown; lida_em: string; mensagens_ate: string | null; modelo: string; origem?: string | null } | null;
  const ultimaEntrada = ultimaEntradaDas(mensagens);
  const banco = fatosDoBanco(lead, negocios.abertos, mensagens, ultimaEntrada);
  return {
    lead_id: lead.id,
    versao_prompt: VERSAO_DO_PROMPT,
    instrucoes: montarPromptDoLeitor(variaveis),
    conversa: transcreverConversa(mensagens, expediente.timezone),
    formato_da_ficha: formatoDaFicha(),
    mensagens_ate: mensagens[mensagens.length - 1]!.created_at,
    mensagens_lidas: mensagens.length,
    fatos_do_banco: {
      ultima_fala_do_lead: banco.ultima_fala_do_lead?.toISOString() ?? null,
      duplicado: banco.duplicado,
      nunca_respondido: banco.nunca_respondido,
    },
    ficha_anterior: anterior
      ? {
          ficha: lerFicha(anterior.ficha),
          lida_em: anterior.lida_em,
          mensagens_ate: anterior.mensagens_ate,
          modelo: anterior.modelo,
          origem: anterior.origem ?? null,
        }
      : null,
  };
}

// ─── 3. gravar a ficha ──────────────────────────────────────────────────────

export const entradaDaGravacaoSchema = z.object({
  lead_id: z.string().uuid(),
  ficha: z.unknown(),
  mensagens_ate: z.string().datetime({ offset: true }),
  gatilho: z.enum(GATILHOS),
  origem: z.enum(ORIGENS_DA_LEITURA_PELO_CLAUDE),
  modelo: z.string().trim().min(1).max(120),
});
export type EntradaDaGravacao = z.infer<typeof entradaDaGravacaoSchema>;

export interface ResultadoDaGravacao {
  gravada: true;
  lead_id: string;
  lida_em: string;
  mensagens_ate: string;
  situacao: string;
  temperatura: string;
  qualidade: string;
  acao: AcaoDaFicha;
  alertas: AlertaDaFicha[];
  aviso_lead_voltou: boolean;
  /** Chegou mensagem depois de `mensagens_ate`: a próxima seleção pega este lead de novo. */
  conversa_mudou: boolean;
}

/** As mensagens de erro do schema, só com o caminho do campo (nunca o valor). */
function errosDaFicha(e: z.ZodError): string {
  return e.issues
    .slice(0, 8)
    .map((i) => `${i.path.join(".") || "ficha"}: ${i.message}`)
    .join("; ");
}

export async function gravarFichaPeloClaude(
  admin: SupabaseClient,
  orgId: string,
  entrada: EntradaDaGravacao,
  opcoes: { agora: Date },
): Promise<ResultadoDaGravacao> {
  const { org } = await orgPeloClaude(admin, orgId);
  const lida = fichaDoLeitorSchema.safeParse(entrada.ficha);
  if (!lida.success) throw new RecusaDoLeitorPeloClaude("ficha_invalida", errosDaFicha(lida.error));
  const ficha = lida.data;

  const ate = new Date(entrada.mensagens_ate);
  if (Number.isNaN(ate.getTime()) || ate.getTime() > opcoes.agora.getTime() + FOLGA_DO_RELOGIO_MS) {
    throw new RecusaDoLeitorPeloClaude("mensagens_ate_invalida", "mensagens_ate is in the future. Send the value crm_leitor_conversa returned.");
  }
  const { lead, contactId } = await leadDaLeitura(admin, orgId, entrada.lead_id);

  const { data: atualR, error: eAtual } = await admin
    .from("crm_lead_ficha")
    .select("mensagens_ate")
    .eq("organization_id", orgId)
    .eq("lead_id", lead.id)
    .maybeSingle();
  if (eAtual) throw new Error(`ficha atual: ${eAtual.message}`);
  const atualAte = (atualR as { mensagens_ate: string | null } | null)?.mensagens_ate ?? null;
  if (atualAte && Date.parse(atualAte) > ate.getTime()) {
    throw new RecusaDoLeitorPeloClaude(
      "leitura_mais_velha_que_a_atual",
      `The current ficha already read messages up to ${atualAte}. Read the conversation again (crm_leitor_conversa).`,
    );
  }

  // O gatilho que a tarefa devolve é conferido aqui: `lead_voltou` só para o lead
  // perdido (ou com marcador que desqualifica) que escreveu de novo, e o lead
  // nessa posição só com ele. Senão a ficha guardaria um gatilho falso e o aviso
  // "Um lead perdido voltou" abriria para quem nunca saiu do funil.
  const negocios = await negociosDoContato(admin, org, contactId);
  const posicao = negocios.posicao.get(lead.id) ?? "fora";
  if ((entrada.gatilho === "lead_voltou") !== (posicao === "pode_voltar")) {
    throw new RecusaDoLeitorPeloClaude(
      "gatilho_nao_confere",
      `The trigger "${entrada.gatilho}" does not match this lead (${posicao}). Send the gatilho crm_leitor_pendentes returned.`,
    );
  }

  // As mensagens até onde a leitura foi: `atendido_por` e `mensagens_ate` da ficha
  // saem delas. O texto vai ao banco como veio (microssegundos), nunca por `Date`.
  const mensagens = await mensagensDoContato(admin, orgId, contactId, entrada.mensagens_ate);
  if (mensagens.length === 0) throw new RecusaDoLeitorPeloClaude("sem_mensagens", "No messages up to mensagens_ate.");
  const agentes = await agentesQueAtenderam(admin, orgId, contactId);
  await gravarFicha(admin, orgId, lead, contactId, ficha, entrada.modelo, entrada.gatilho, mensagens, agentes, entrada.origem);

  const abertos = negocios.abertos;
  const [convR] = await Promise.all([
    admin
      .from("conversations")
      .select("last_message_at")
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .eq("is_group", false)
      .gt("last_message_at", mensagens[mensagens.length - 1]!.created_at)
      .limit(1),
  ]);
  if (convR.error) throw new Error(`conversas: ${convR.error.message}`);
  const ultimaEntrada = ultimaEntradaDas(mensagens);
  const banco = fatosDoBanco(lead, abertos, mensagens, ultimaEntrada);
  const c = classificarFicha({ ficha, banco }, opcoes.agora);

  // O aviso é da leitura diária (como no Leitor do CRM); a correção do Gestor não o reabre.
  let aviso = false;
  if (entrada.gatilho === "lead_voltou" && entrada.origem === "leitor_0530") {
    const fuso = expedienteDaOrg(org.settings, org.timezone).timezone;
    const idioma = normalizarIdioma(org.locale);
    aviso = await avisarSeOLeadVoltou(admin, orgId, { lead, ultimaEntrada }, ficha, mensagens, abertos, {
      agora: opcoes.agora,
      fuso,
      idioma,
      t: (s: string) => traduzir(s, idioma),
    });
  }

  return {
    gravada: true,
    lead_id: lead.id,
    lida_em: new Date().toISOString(),
    mensagens_ate: mensagens[mensagens.length - 1]!.created_at,
    situacao: c.situacao,
    temperatura: c.temperatura,
    qualidade: c.qualidade,
    acao: c.acao,
    alertas: [...c.alertas],
    aviso_lead_voltou: aviso,
    conversa_mudou: (convR.data ?? []).length > 0,
  };
}

// ─── 4. fechar a rodada do dia ──────────────────────────────────────────────

export interface ResultadoDaConclusao {
  dia: string;
  iniciada_em: string;
  terminada_em: string;
  /** Fichas gravadas pela leitura das 05h30 desde o começo da rodada (contadas no banco). */
  gravadas: number;
  lidos_informados: number;
  erros: number;
}

export async function concluirRodadaPeloClaude(
  admin: SupabaseClient,
  orgId: string,
  entrada: { lidos: number; erros: number; ultimo_erro?: string | null },
  opcoes: { agora: Date; requestId?: string },
): Promise<ResultadoDaConclusao> {
  const { org } = await orgPeloClaude(admin, orgId);
  const dia = diaNoFuso(opcoes.agora, fusoUtilizavel(org.timezone));
  const { error: eIns } = await admin.from("leitor_rodadas").insert({ organization_id: orgId, dia, origem: ORIGEM_DA_RODADA_DO_CLAUDE });
  if (eIns && eIns.code !== "23505") throw new Error(`abrir a rodada: ${eIns.message}`);
  const { data: rodadaR, error: eR } = await admin
    .from("leitor_rodadas")
    .select("id, iniciada_em")
    .eq("organization_id", orgId)
    .eq("origem", ORIGEM_DA_RODADA_DO_CLAUDE)
    .eq("dia", dia)
    .maybeSingle();
  if (eR) throw new Error(`rodada: ${eR.message}`);
  const rodada = rodadaR as { id: string; iniciada_em: string } | null;
  if (!rodada) throw new Error("rodada: sem linha");

  const { data: fichas, error: eF } = await admin
    .from("crm_lead_ficha")
    .select("lead_id")
    .eq("organization_id", orgId)
    .eq("origem", "leitor_0530")
    .gte("lida_em", rodada.iniciada_em);
  if (eF) throw new Error(`fichas da rodada: ${eF.message}`);
  const gravadas = (fichas ?? []).length;
  const terminadaEm = new Date().toISOString();
  const ultimoErro = entrada.ultimo_erro ? entrada.ultimo_erro.slice(0, 300) : null;
  const { error: eUpd } = await admin
    .from("leitor_rodadas")
    .update({ lidos: gravadas, falhas: entrada.erros, ultimo_erro: ultimoErro, terminada_em: terminadaEm })
    .eq("organization_id", orgId)
    .eq("id", rodada.id);
  if (eUpd) throw new Error(`fechar a rodada: ${eUpd.message}`);

  await audit({
    organizationId: orgId,
    action: "leitor.rodada",
    resourceType: "leitor_rodadas",
    resourceId: rodada.id,
    metadata: { origem: ORIGEM_DA_RODADA_DO_CLAUDE, dia, lidos: gravadas, lidos_informados: entrada.lidos, falhas: entrada.erros, terminou: true },
    ...(opcoes.requestId ? { requestId: opcoes.requestId } : {}),
  });

  // O retrato NÃO é gerado aqui: a tarefa termina antes das 06:00 e o retrato do
  // dia sairia cortado. O cron do retrato (de hora em hora) espera a rodada aberta
  // (`retratoEsperaOLeitor`) e gera assim que ela fecha.
  return {
    dia,
    iniciada_em: rodada.iniciada_em,
    terminada_em: terminadaEm,
    gravadas,
    lidos_informados: entrada.lidos,
    erros: entrada.erros,
  };
}

// ─── para o cartão do Leitor ────────────────────────────────────────────────

export interface RodadaDoClaudeNaTela {
  dia: string;
  iniciada_em: string;
  terminada_em: string | null;
  /** Fichas que a rodada gravou (contadas no fechamento). */
  gravadas: number;
}

/** A última rodada do Claude desta organização (pelo cliente da sessão: RLS). Nunca lança. */
export async function ultimaRodadaDoClaude(db: SupabaseClient, orgId: string): Promise<RodadaDoClaudeNaTela | null> {
  const { data, error } = await db
    .from("leitor_rodadas")
    .select("dia, iniciada_em, terminada_em, lidos")
    .eq("organization_id", orgId)
    .eq("origem", ORIGEM_DA_RODADA_DO_CLAUDE)
    .order("iniciada_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as { dia: string; iniciada_em: string; terminada_em: string | null; lidos: number | null };
  return { dia: r.dia, iniciada_em: r.iniciada_em, terminada_em: r.terminada_em, gravadas: r.lidos ?? 0 };
}
