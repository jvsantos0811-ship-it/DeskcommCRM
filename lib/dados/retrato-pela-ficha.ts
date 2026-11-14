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
 * guarda só o que a regra devolve — nunca as provas da ficha, que são trechos da
 * conversa (LGPD: o retrato não guarda texto de conversa).
 */
import type { FatosDoBanco, FichaDoLeitor } from "./ficha";
import { INTERESSE_A_CONFIRMAR } from "./ficha";
import {
  ALERTAS_DA_FICHA,
  classificarFicha,
  FORA_DA_VENDA,
  SITUACOES_DA_FICHA,
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

/** O que o retrato guarda de cada lead lido: só o que a regra fixa devolve. */
export interface FichaNoRetrato {
  situacao: SituacaoDaFicha;
  temperatura: TemperaturaDaFicha;
  qualidade: QualidadeDaFicha;
  acao: AcaoDaFicha;
  alertas: AlertaDaFicha[];
  /** O tipo de lead que a conversa indica; nulo quando nada indica ou "a confirmar". */
  interesse: string | null;
  palavras_proprias: boolean;
  contou_o_caso: FichaDoLeitor["contou_o_caso"];
}

/** O que o banco junta para a régua v2: a ficha de cada lead e os cards duplicados. */
export interface EntradaPelaFicha {
  /** A ficha de cada lead (só as que passam no schema central). */
  fichas: Map<string, FichaDoLeitor>;
  /** Leads com outro card aberto do mesmo contato, criado antes. */
  duplicados: Set<string>;
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

/** A regra fixa aplicada a um lead lido. */
export function fichaNoRetrato(ficha: FichaDoLeitor, banco: FatosDoBanco, agora: Date): FichaNoRetrato {
  const c = classificarFicha({ ficha, banco }, agora);
  const interesse = ficha.interesse && ficha.interesse !== INTERESSE_A_CONFIRMAR ? ficha.interesse : null;
  return {
    situacao: c.situacao,
    temperatura: c.temperatura,
    qualidade: c.qualidade,
    acao: c.acao,
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
