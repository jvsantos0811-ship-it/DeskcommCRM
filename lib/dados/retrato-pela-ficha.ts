/**
 * O RETRATO PELA FICHA — Regra v2 §3 (PR 2) e PC-037 §1.
 *
 * Na organização com a chave `painel_pela_ficha` ligada (`painelPelaFicha`,
 * `lib/dados/leitor/config.ts`), o retrato deixa de contar mensagens: cada lead
 * com FICHA passa pela regra fixa (`classificarFicha`) e o painel mostra a
 * Situação, a Temperatura, a Qualidade, a Ação e os Alertas que ela devolve. O
 * lead sem ficha fica à parte, como "sem leitura", e não infla contador nenhum.
 *
 * Os contadores da PC-037:
 *   - Respondeu  = a ficha diz que o lead escreveu com as próprias palavras
 *                  (a mensagem pronta do anúncio não conta);
 *   - Engajado   = contou o caso ("sim" ou "parcial"), não mais 3 mensagens;
 *   - Interesse  = a ficha aponta um tipo de lead (o que o lead contou, não o anúncio).
 *
 * Puro: nada de banco nem de relógio (o `agora` vem por parâmetro). O retrato
 * guarda só CÓDIGOS do que a regra devolve — nunca texto livre tirado da
 * conversa (LGPD: o retrato não guarda texto de conversa, e não é limpo pela
 * anonimização). Por isso a ação vai só com o tipo (`AcaoNoRetrato`), sem o
 * evento esperado nem o que falta, e o interesse só quando é um tipo do catálogo.
 * O detalhe mora na ficha (`crm_lead_ficha`), que a anonimização apaga.
 */
import type { FatosDoBanco, FichaDoLeitor } from "./ficha";
import { INTERESSE_A_CONFIRMAR } from "./ficha";
import {
  ALERTAS_DA_FICHA,
  classificarFicha,
  FORA_DA_VENDA,
  SITUACOES_DA_FICHA,
  textoDaAcao,
  type AcaoDaFicha,
  type AlertaDaFicha,
  type QualidadeDaFicha,
  type SituacaoDaFicha,
  type TemperaturaDaFicha,
} from "./regra-da-ficha";
import type { Nivel, Temperatura } from "./qualidade";

/** A régua que conta mensagens (v3) e a que lê a ficha (Regra v2). */
export const REGUA_POR_MENSAGENS = 1;
export const REGUA_PELA_FICHA = 2;

/**
 * A ação como o retrato a guarda: só o tipo (e se falta confirmar a assinatura).
 * O texto do evento esperado e do que falta sai da conversa ("perícia do INSS",
 * "o problema de saúde") — fica na ficha, nunca no retrato.
 */
export interface AcaoNoRetrato {
  tipo: AcaoDaFicha["tipo"];
  confirmar_assinatura?: boolean;
}

export function acaoNoRetrato(a: AcaoDaFicha): AcaoNoRetrato {
  return a.tipo === "mover_para_clientes" ? { tipo: a.tipo, confirmar_assinatura: a.confirmarAssinatura } : { tipo: a.tipo };
}

/** O texto da ação no painel, sem o detalhe que só a ficha tem. */
export function textoDaAcaoNoRetrato(a: AcaoNoRetrato, t: (s: string) => string, funilDeClientes: string | null = null): string {
  switch (a.tipo) {
    case "chamar_depois":
      return t("Chamar depois do evento esperado");
    case "retomar":
      return t("Retomar a conversa");
    case "mover_para_clientes":
      return textoDaAcao({ tipo: a.tipo, confirmarAssinatura: a.confirmar_assinatura === true }, t, funilDeClientes);
    default:
      return textoDaAcao({ tipo: a.tipo } as AcaoDaFicha, t, funilDeClientes);
  }
}

/** O que o retrato guarda de cada lead lido: só os códigos que a regra fixa devolve. */
export interface FichaNoRetrato {
  situacao: SituacaoDaFicha;
  temperatura: TemperaturaDaFicha;
  qualidade: QualidadeDaFicha;
  acao: AcaoNoRetrato;
  alertas: AlertaDaFicha[];
  /** O tipo de lead DO CATÁLOGO que a conversa indica; nulo quando nada indica, "a confirmar" ou fora do catálogo. */
  interesse: string | null;
  palavras_proprias: boolean;
  contou_o_caso: FichaDoLeitor["contou_o_caso"];
}

/** O que o banco junta para a régua v2: a ficha de cada lead e os cards duplicados. */
export interface EntradaPelaFicha {
  /** A ficha de cada lead (só as que passam no schema central). */
  fichas: Map<string, FichaDoLeitor>;
  /** Leads com outro negócio com potencial do mesmo contato, criado antes (a mesma régua do Leitor). */
  duplicados: Set<string>;
  /** Os tipos de lead do catálogo: só eles valem como interesse (o resto é texto livre e não vai ao retrato). */
  tipos?: ReadonlySet<string>;
}

/** Os fatos de uma linha do retrato que a regra fixa usa ao lado da ficha. */
export interface FatosDaLinha {
  /** A última mensagem do lead (ISO), como o retrato a conhece. */
  ultimaFalaDoLead: string | null;
  primeiraMensagemDoLeadEm: string | null;
  primeiraRespostaDaEmpresaEm: string | null;
  duplicado: boolean;
}

export function fatosDoBancoDaLinha(f: FatosDaLinha): FatosDoBanco {
  const t = f.ultimaFalaDoLead ? Date.parse(f.ultimaFalaDoLead) : NaN;
  return {
    ultima_fala_do_lead: Number.isFinite(t) ? new Date(t) : null,
    duplicado: f.duplicado,
    // Escreveu e nunca recebeu resposta da empresa (IA ou pessoa).
    nunca_respondido: f.primeiraMensagemDoLeadEm !== null && f.primeiraRespostaDaEmpresaEm === null,
    // O retrato não lê mídia: o alerta vem da ficha (`midia_nao_entendida`).
    midia_nao_entendida: false,
  };
}

/** A regra fixa aplicada a um lead lido. `tipos` = os tipos de lead do catálogo da organização. */
export function fichaNoRetrato(
  ficha: FichaDoLeitor,
  banco: FatosDoBanco,
  agora: Date,
  tipos: ReadonlySet<string> = new Set(),
): FichaNoRetrato {
  const c = classificarFicha({ ficha, banco }, agora);
  const interesse =
    ficha.interesse && ficha.interesse !== INTERESSE_A_CONFIRMAR && tipos.has(ficha.interesse) ? ficha.interesse : null;
  return {
    situacao: c.situacao,
    temperatura: c.temperatura,
    qualidade: c.qualidade,
    acao: acaoNoRetrato(c.acao),
    alertas: [...c.alertas],
    interesse,
    palavras_proprias: ficha.palavras_proprias,
    contou_o_caso: ficha.contou_o_caso,
  };
}

/** O nível A–D da régua v2 (nulo para quem saiu da venda ou não foi lido). */
export function nivelPelaFicha(f: FichaNoRetrato | null): Nivel | null {
  if (!f || f.qualidade === "—") return null;
  return f.qualidade;
}

/** A temperatura de 3 valores que o resto do painel conhece. "Agendado" e "—" ficam de fora. */
export function temperaturaPelaFicha(f: FichaNoRetrato | null): Temperatura | null {
  if (!f) return null;
  if (f.temperatura === "Quente") return "quente";
  if (f.temperatura === "Morno") return "morno";
  if (f.temperatura === "Frio") return "frio";
  return null;
}

export function foraDaVenda(f: FichaNoRetrato | null | undefined): boolean {
  return Boolean(f && FORA_DA_VENDA.has(f.situacao));
}

/**
 * Régua v2: o grupo do lead ABERTO que não tem nível nem temperatura de venda —
 * para as listas e o Explorar não o chamarem de "Fechado" nem de "desqualificado".
 * Nulo quando o lead tem nível/temperatura (ou não é aberto, ou é régua v1).
 */
export type ChaveForaDaNota = "sem_leitura" | "agendado" | "fora_do_funil";
export const CHAVES_FORA_DA_NOTA: readonly ChaveForaDaNota[] = ["agendado", "fora_do_funil", "sem_leitura"];

export function chaveForaDaNota(l: { status: string; ficha?: FichaNoRetrato | null }): ChaveForaDaNota | null {
  if (l.status !== "open" || l.ficha === undefined) return null;
  if (l.ficha === null) return "sem_leitura";
  if (foraDaVenda(l.ficha)) return "fora_do_funil";
  if (l.ficha.temperatura === "Agendado") return "agendado";
  return null;
}

/** Régua v2: esfriou = contou o caso (sim ou parcial) e a regra diz Frio. Nada de contar mensagem. */
export function esfriouPelaFicha(f: FichaNoRetrato | null | undefined): boolean {
  if (!f || foraDaVenda(f)) return false;
  return f.temperatura === "Frio" && (f.contou_o_caso === "sim" || f.contou_o_caso === "parcial");
}

/** O lead de que os contadores precisam. */
export interface LeadParaContar {
  status: "open" | "won" | "lost";
  /** `undefined` = régua v1; `null` = régua v2 sem leitura. */
  ficha?: FichaNoRetrato | null;
}

/** Os números que só a régua v2 tem. */
export interface ResumoPelaFicha {
  /** Leads (de qualquer status) com ficha. */
  lidos: number;
  /** Leads abertos sem ficha: aparecem à parte e não inflam contador nenhum. */
  sem_leitura: number;
  /** Abertos que a regra tirou da venda (cliente, duplicado, fora da área…). */
  fora_do_funil: number;
  /** Abertos esperando um evento (perícia, alta, retorno combinado). */
  agendados: number;
  /** Abertos por situação. */
  situacoes: Record<SituacaoDaFicha, number>;
  /** Abertos com cada alerta. */
  alertas: Record<AlertaDaFicha, number>;
}

/** Os três contadores da PC-037, pela ficha. Lead sem ficha não conta. */
export function contadoresPelaFicha(leads: LeadParaContar[]): { responderam: number; engajados: number; interesse: number } {
  let responderam = 0;
  let engajados = 0;
  let interesse = 0;
  for (const l of leads) {
    if (!l.ficha) continue;
    if (l.ficha.palavras_proprias) responderam += 1;
    if (l.ficha.contou_o_caso === "sim" || l.ficha.contou_o_caso === "parcial") engajados += 1;
    if (l.ficha.interesse) interesse += 1;
  }
  return { responderam, engajados, interesse };
}

export function resumoPelaFicha(leads: LeadParaContar[]): ResumoPelaFicha {
  const situacoes = Object.fromEntries(SITUACOES_DA_FICHA.map((s) => [s, 0])) as Record<SituacaoDaFicha, number>;
  const alertas = Object.fromEntries(ALERTAS_DA_FICHA.map((a) => [a, 0])) as Record<AlertaDaFicha, number>;
  let lidos = 0;
  let semLeitura = 0;
  let fora = 0;
  let agendados = 0;
  for (const l of leads) {
    if (l.ficha) lidos += 1;
    if (l.status !== "open") continue;
    if (!l.ficha) {
      semLeitura += 1;
      continue;
    }
    situacoes[l.ficha.situacao] += 1;
    for (const a of l.ficha.alertas) alertas[a] += 1;
    if (FORA_DA_VENDA.has(l.ficha.situacao)) fora += 1;
    if (l.ficha.temperatura === "Agendado") agendados += 1;
  }
  return { lidos, sem_leitura: semLeitura, fora_do_funil: fora, agendados, situacoes, alertas };
}

/** A ordem das listas na régua v2: qualidade A → D, depois o mais novo. */
export function ordemDaQualidade(f: FichaNoRetrato | null | undefined): number {
  if (!f) return 9;
  const ordem: Record<QualidadeDaFicha, number> = { A: 0, B: 1, C: 2, D: 3, "—": 5 };
  return ordem[f.qualidade];
}
