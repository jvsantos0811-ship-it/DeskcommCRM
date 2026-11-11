/**
 * "PAROU ANTES DA QUALIFICAÇÃO" (PC-025, item 3) — a regra, pura, sem banco.
 *
 * ─── Para que serve ──────────────────────────────────────────────────────────
 *
 * O maior vazamento do funil de IA é o lead que começou a conversar e parou
 * antes de chegar à qualificação. Duas medidas:
 *
 *   a) "Só mandou a 1ª mensagem": card aberto em que o cliente escreveu,
 *      recebeu resposta e nunca mais escreveu;
 *   b) "Conversou e parou antes da qualificação": card aberto em que o cliente
 *      respondeu pelo menos uma vez DEPOIS da primeira resposta, nunca chegou à
 *      etapa marco (nem às depois dela) e está sem mensagem do cliente há mais
 *      de N horas (24, 48 ou 72).
 *
 * A espera de N horas vale para as DUAS: sem ela, o cliente que acabou de
 * receber a primeira resposta (há 2 minutos) contaria como desistente em (a).
 *
 * ─── Só contagem e horário ───────────────────────────────────────────────────
 *
 * Os fatos vêm de `fn_dados_ritmo_da_conversa` (migration 9029), que lê das
 * mensagens só a direção e o horário — nunca o texto. Nenhuma IA é chamada.
 *
 * ─── Configuração por funil (Configurações › Funis) ──────────────────────────
 *
 * `settings.marco_de_qualificacao` (uma etapa, ex.: Qualificado) e
 * `settings.etapas_fora_da_medida` (ex.: Demanda futura, Análise humana, Lead
 * Antigo). Sem marco, a medida pede "configure o marco" em vez de adivinhar.
 *
 * ─── A base do percentual ────────────────────────────────────────────────────
 *
 * Os cards que CONVERSARAM no período: entraram no período (pelo dia do fuso
 * da organização) e o cliente escreveu ao menos uma vez — fora os que estão
 * numa etapa "fora desta medida".
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const HORAS_DA_MEDIDA = [24, 48, 72] as const;
export type HorasDaMedida = (typeof HORAS_DA_MEDIDA)[number];

/** Lê `settings.marco_de_qualificacao` sem lançar. */
export function marcoDeQualificacao(settings: unknown): string | null {
  const v = (settings as { marco_de_qualificacao?: unknown } | null)?.marco_de_qualificacao;
  return typeof v === "string" && UUID.test(v) ? v : null;
}

/** Lê `settings.etapas_fora_da_medida` sem lançar (só ids válidos, sem repetir). */
export function etapasForaDaMedida(settings: unknown): string[] {
  const v = (settings as { etapas_fora_da_medida?: unknown } | null)?.etapas_fora_da_medida;
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && UUID.test(x)))];
}

/** Uma linha de `fn_dados_ritmo_da_conversa` (numéricos podem vir como texto). */
export interface LinhaDoRitmo {
  lead_id: string;
  titulo: string;
  status: string;
  stage_id: string;
  etapa_posicao: number | string | null;
  criado_em: string;
  origem: string | null;
  anuncio_id: string | null;
  primeira_do_cliente_em: string | null;
  primeira_resposta_em: string | null;
  respostas_depois: number | string | null;
  ultima_do_cliente_em: string | null;
  agente_id: string | null;
  chegou_ao_marco: boolean | null;
}

export type MedidaDoParou = "so_primeira" | "parou";

export interface CardDoParou {
  id: string;
  titulo: string;
  medida: MedidaDoParou;
  stage_id: string;
  agente_id: string | null;
  origem: string;
  anuncio_id: string | null;
  /** O dia em que entrou, no fuso da organização. */
  dia: string;
  ultima_do_cliente_em: string | null;
}

export interface Quebra {
  chave: string;
  leads: number;
}

export interface ResultadoDoParou {
  /** A base do percentual: conversaram no período (fora das etapas fora da medida). */
  conversaram: number;
  so_primeira: number;
  parou: number;
  pct_so_primeira: number;
  pct_parou: number;
  cards: CardDoParou[];
  quebras: Record<MedidaDoParou, Record<"etapa" | "agente" | "origem" | "dia", Quebra[]>>;
}

function pct(parte: number, todo: number): number {
  return todo > 0 ? Math.round((parte / todo) * 1000) / 10 : 0;
}

function quebrar(
  cards: CardDoParou[],
  chave: (c: CardDoParou) => string,
  porChave = false,
): Quebra[] {
  const m = new Map<string, number>();
  for (const c of cards) m.set(chave(c), (m.get(chave(c)) ?? 0) + 1);
  const xs = [...m.entries()].map(([k, leads]) => ({ chave: k, leads }));
  return porChave
    ? xs.sort((a, b) => a.chave.localeCompare(b.chave))
    : xs.sort((a, b) => b.leads - a.leads || a.chave.localeCompare(b.chave));
}

/**
 * Classifica os cards. `diaDe` diz o dia do fuso da organização de um instante
 * (injetado para a regra ficar pura e testável sem fuso de máquina).
 */
export function classificarParouAntes(
  linhas: readonly LinhaDoRitmo[],
  opcoes: {
    agora: Date;
    horas: number;
    fora: ReadonlySet<string>;
    diaDe: (iso: string) => string;
  },
): ResultadoDoParou {
  const limite = opcoes.agora.getTime() - opcoes.horas * 3_600_000;
  let conversaram = 0;
  const cards: CardDoParou[] = [];
  for (const l of linhas) {
    if (opcoes.fora.has(l.stage_id)) continue;
    if (!l.primeira_do_cliente_em) continue;
    conversaram += 1;
    if (l.status !== "open") continue;
    if (!l.primeira_resposta_em) continue; // o cliente escreveu e ninguém respondeu: é outro problema
    const ultima = Date.parse(l.ultima_do_cliente_em ?? l.primeira_do_cliente_em);
    if (!Number.isFinite(ultima) || ultima > limite) continue; // ainda dentro das N horas
    const respostas = Number(l.respostas_depois ?? 0);
    let medida: MedidaDoParou | null = null;
    if (respostas === 0) medida = "so_primeira";
    else if (l.chegou_ao_marco !== true) medida = "parou";
    if (!medida) continue;
    cards.push({
      id: l.lead_id,
      titulo: l.titulo,
      medida,
      stage_id: l.stage_id,
      agente_id: l.agente_id,
      origem: l.origem ?? "",
      anuncio_id: l.anuncio_id,
      dia: opcoes.diaDe(l.criado_em),
      ultima_do_cliente_em: l.ultima_do_cliente_em,
    });
  }
  const daMedida = (m: MedidaDoParou) => cards.filter((c) => c.medida === m);
  const quebras = (m: MedidaDoParou) => {
    const xs = daMedida(m);
    return {
      etapa: quebrar(xs, (c) => c.stage_id),
      agente: quebrar(xs, (c) => c.agente_id ?? ""),
      origem: quebrar(xs, (c) => (c.anuncio_id ? `anuncio:${c.anuncio_id}` : c.origem)),
      dia: quebrar(xs, (c) => c.dia, true),
    };
  };
  const so = daMedida("so_primeira").length;
  const parou = daMedida("parou").length;
  return {
    conversaram,
    so_primeira: so,
    parou,
    pct_so_primeira: pct(so, conversaram),
    pct_parou: pct(parou, conversaram),
    cards,
    quebras: { so_primeira: quebras("so_primeira"), parou: quebras("parou") },
  };
}
