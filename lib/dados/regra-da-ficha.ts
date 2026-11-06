/**
 * A REGRA FIXA DA QUALIDADE DO LEAD — Regra v2 §2.3, com a mudança da PM-027 §5
 * ("Já tem advogado" passa a "Já atendido por outro", para servir clínica e
 * consultório).
 *
 * Lê a FICHA (fatos da conversa, `lib/dados/ficha.ts`) e os fatos do banco e
 * devolve Situação, Temperatura, Qualidade, Ação e Alertas. Código puro, sem IA,
 * sem nome de etapa, de funil ou de cliente: é a MESMA regra para todo mundo.
 * Nada de contar mensagem.
 *
 * É a tradução linha a linha do Python que o Gestor rodou nos 48 casos reais
 * (48/48). A bateria (`regra-da-ficha.test.ts`, fixture
 * `tests/fixtures/leitor/bateria-48.json`) prova que a tradução não desviou.
 *
 * Os prazos aqui são de RELÓGIO (72 h, 7 dias…), como no original — não de
 * expediente. Quem usa dias úteis é a seleção do Leitor e o painel "Esperando a
 * equipe".
 */
import type { FatosDoBanco, FichaDoLeitor } from "./ficha";

export const SITUACOES_DA_FICHA = [
  "Não é lead",
  "Já é cliente",
  "Duplicado",
  "Fora da área",
  "Sem caso",
  "Sem requisito",
  "Recusou",
  "Já atendido por outro",
  "Aguardando evento",
  "Fechado",
  "Contrato enviado",
  "Proposta feita",
  "Qualificado",
  "Em qualificação",
  "Sem leitura",
  "Só chegou",
] as const;
export type SituacaoDaFicha = (typeof SITUACOES_DA_FICHA)[number];

/** Saem da contagem de leads de venda e vão para o bloco "Fora do funil de venda". */
export const FORA_DA_VENDA: ReadonlySet<SituacaoDaFicha> = new Set<SituacaoDaFicha>([
  "Não é lead",
  "Já é cliente",
  "Duplicado",
  "Fora da área",
  "Sem caso",
  "Sem requisito",
  "Recusou",
  "Já atendido por outro",
  "Fechado",
]);
const AVANCADO: ReadonlySet<SituacaoDaFicha> = new Set<SituacaoDaFicha>(["Contrato enviado", "Proposta feita", "Qualificado"]);

export const TEMPERATURAS_DA_FICHA = ["Quente", "Morno", "Agendado", "Frio", "—"] as const;
export type TemperaturaDaFicha = (typeof TEMPERATURAS_DA_FICHA)[number];

export const QUALIDADES_DA_FICHA = ["A", "B", "C", "D", "—"] as const;
export type QualidadeDaFicha = (typeof QUALIDADES_DA_FICHA)[number];

export type AcaoDaFicha =
  | { tipo: "mover_para_clientes"; confirmarAssinatura: boolean }
  | { tipo: "arquivar" }
  | { tipo: "juntar_ao_card_aberto" }
  | { tipo: "indicar_outro_profissional" }
  | { tipo: "orientar_e_encerrar" }
  | { tipo: "chamar_depois"; evento: string }
  | { tipo: "ligar_hoje" }
  | { tipo: "equipe_responder_hoje" }
  | { tipo: "retomar"; oQueFalta: string | null }
  | { tipo: "reaquecer" }
  | { tipo: "followup_automatico" };

export const ALERTAS_DA_FICHA = ["equipe_deve_resposta", "nunca_respondido", "midia_nao_entendida", "confirmar_assinatura"] as const;
export type AlertaDaFicha = (typeof ALERTAS_DA_FICHA)[number];

export interface ClassificacaoDaFicha {
  situacao: SituacaoDaFicha;
  temperatura: TemperaturaDaFicha;
  qualidade: QualidadeDaFicha;
  acao: AcaoDaFicha;
  alertas: AlertaDaFicha[];
}

/** O que a regra lê: a ficha do Leitor mais os fatos do banco. */
export interface EntradaDaRegra {
  ficha: FichaDoLeitor;
  banco: FatosDoBanco;
}

const HORA_MS = 3_600_000;

function horasDesde(d: Date | null, agora: Date): number | null {
  if (!d) return null;
  return (agora.getTime() - d.getTime()) / HORA_MS;
}

/** O texto do evento esperado ("perícia do INSS", "alta médica · 04/12"). */
function textoDoAguardando(a: NonNullable<FichaDoLeitor["aguardando"]>): string {
  return a.data ? `${a.evento} · ${a.data}` : a.evento;
}

export function situacaoDaFicha(e: EntradaDaRegra): SituacaoDaFicha {
  const f = e.ficha;
  if (f.contato === "interno") return "Não é lead";
  if (f.contato === "cliente") return "Já é cliente";
  if (e.banco.duplicado) return "Duplicado";
  if (f.fora_da_area) return "Fora da área";
  if (f.sem_caso) return "Sem caso";
  if (f.requisitos === "nao_atende") return "Sem requisito";
  if (f.recusou) return "Recusou";
  if (f.ja_atendido_por_outro) return "Já atendido por outro";
  if (f.aguardando) return "Aguardando evento";
  if (f.negociacao === "assinado") return "Fechado";
  if (f.negociacao === "contrato_enviado") return "Contrato enviado";
  if (f.negociacao === "proposta") return "Proposta feita";
  if (f.requisitos === "atende") return "Qualificado";
  if (f.contou_o_caso === "sim" || f.contou_o_caso === "parcial") return "Em qualificação";
  if (f.contato === "ilegivel") return "Sem leitura";
  return "Só chegou";
}

export function temperaturaDaFicha(e: EntradaDaRegra, s: SituacaoDaFicha, agora: Date): TemperaturaDaFicha {
  if (FORA_DA_VENDA.has(s)) return "—";
  if (s === "Aguardando evento") return "Agendado";
  const h = horasDesde(e.banco.ultima_fala_do_lead, agora);
  const devendo = e.ficha.proximo_passo_com === "escritorio";
  if (AVANCADO.has(s)) {
    if ((h !== null && h <= 72) || (devendo && h !== null && h <= 240)) return "Quente";
    if (h !== null && h <= 240) return "Morno";
    return "Frio";
  }
  if (s === "Em qualificação") {
    if ((h !== null && h <= 168) || (devendo && h !== null && h <= 336)) return "Morno";
    return "Frio";
  }
  if (s === "Só chegou") {
    if (e.ficha.palavras_proprias && h !== null && h <= 48) return "Morno";
    return "Frio";
  }
  return "Frio"; // Sem leitura
}

export function qualidadeDaFicha(e: EntradaDaRegra, s: SituacaoDaFicha): QualidadeDaFicha {
  if (FORA_DA_VENDA.has(s)) return "—";
  const f = e.ficha;
  if (AVANCADO.has(s) || f.requisitos === "atende") return "A";
  if (f.contou_o_caso === "sim" && !f.requisito_em_risco) return "B";
  if (f.contou_o_caso === "sim" || f.contou_o_caso === "parcial") return "C";
  return "D";
}

export function acaoDaFicha(e: EntradaDaRegra, s: SituacaoDaFicha, t: TemperaturaDaFicha): AcaoDaFicha {
  const f = e.ficha;
  if (s === "Já é cliente") return { tipo: "mover_para_clientes", confirmarAssinatura: f.confirmar_assinatura };
  if (s === "Não é lead") return { tipo: "arquivar" };
  if (s === "Duplicado") return { tipo: "juntar_ao_card_aberto" };
  if (s === "Fora da área") return { tipo: "indicar_outro_profissional" };
  if (s === "Sem caso" || s === "Sem requisito" || s === "Recusou" || s === "Já atendido por outro") {
    return { tipo: "orientar_e_encerrar" };
  }
  if (s === "Aguardando evento" && f.aguardando) return { tipo: "chamar_depois", evento: textoDoAguardando(f.aguardando) };
  if (t === "Quente") return { tipo: "ligar_hoje" };
  if (f.proximo_passo_com === "escritorio") return { tipo: "equipe_responder_hoje" };
  if (t === "Morno") {
    const falta = f.requisitos_faltando.join(", ");
    return { tipo: "retomar", oQueFalta: falta === "" ? null : falta };
  }
  if (s === "Em qualificação") return { tipo: "reaquecer" };
  return { tipo: "followup_automatico" };
}

export function alertasDaFicha(e: EntradaDaRegra): AlertaDaFicha[] {
  const f = e.ficha;
  const a: AlertaDaFicha[] = [];
  if (f.proximo_passo_com === "escritorio" && f.contato === "lead" && !e.banco.duplicado) a.push("equipe_deve_resposta");
  if (e.banco.nunca_respondido) a.push("nunca_respondido");
  if (f.contato === "ilegivel" || f.midia_nao_entendida || e.banco.midia_nao_entendida) a.push("midia_nao_entendida");
  if (f.confirmar_assinatura) a.push("confirmar_assinatura");
  return a;
}

export function classificarFicha(e: EntradaDaRegra, agora: Date): ClassificacaoDaFicha {
  const situacao = situacaoDaFicha(e);
  const temperatura = temperaturaDaFicha(e, situacao, agora);
  return {
    situacao,
    temperatura,
    qualidade: qualidadeDaFicha(e, situacao),
    acao: acaoDaFicha(e, situacao, temperatura),
    alertas: alertasDaFicha(e),
  };
}

// ─── Lead sem ficha (PM-027 §3, exceção 3) ─────────────────────────────────

/**
 * Enquanto um lead com potencial não foi lido, a regra NÃO inventa ficha. Ele
 * aparece como "Sem leitura" — ou "Frio · sem leitura" quando está sem conversa
 * há mais de 3 dias úteis — para ninguém confundir "não lido" com "lido e frio".
 * Quem decide se passou dos 3 dias úteis é o chamador (`passouDeDiasUteis`).
 */
export type EstadoSemFicha = "sem_leitura" | "frio_sem_leitura";

export function estadoSemFicha(paradoHaMaisDe3DiasUteis: boolean): EstadoSemFicha {
  return paradoHaMaisDe3DiasUteis ? "frio_sem_leitura" : "sem_leitura";
}

// ─── Os textos ──────────────────────────────────────────────────────────────

/**
 * O texto da ação, como a ordem escreveu. `t` traduz (a tela passa o `t` do
 * idioma da organização); `funilDeClientes` é o nome do funil de quem já é
 * cliente nesta organização, quando ela tem um — a regra não sabe nomes.
 */
export function textoDaAcao(
  acao: AcaoDaFicha,
  t: (s: string) => string,
  funilDeClientes: string | null = null,
): string {
  switch (acao.tipo) {
    case "mover_para_clientes": {
      const base = funilDeClientes
        ? t("Mover para o {funil}").replace("{funil}", funilDeClientes)
        : t("Mover para o funil de clientes");
      return acao.confirmarAssinatura ? `${base} ${t("(confirmar assinatura)")}` : base;
    }
    case "arquivar":
      return t("Arquivar");
    case "juntar_ao_card_aberto":
      return t("Juntar ao card aberto");
    case "indicar_outro_profissional":
      return t("Responder e indicar outro profissional");
    case "orientar_e_encerrar":
      return t("Responder com orientação e encerrar");
    case "chamar_depois":
      return `${t("Chamar depois:")} ${acao.evento}`;
    case "ligar_hoje":
      return t("Ligar hoje");
    case "equipe_responder_hoje":
      return t("Escritório responder hoje");
    case "retomar":
      return `${t("Retomar:")} ${acao.oQueFalta ?? t("pedir o caso")}`;
    case "reaquecer":
      return t("Reaquecer com o que o lead já contou");
    case "followup_automatico":
      return t("Follow-up automático");
  }
}

const TEXTO_DO_ALERTA: Record<AlertaDaFicha, string> = {
  equipe_deve_resposta: "escritório deve resposta",
  nunca_respondido: "nunca respondido",
  midia_nao_entendida: "áudio não entendido",
  confirmar_assinatura: "confirmar se assinou",
};

export function textoDoAlerta(a: AlertaDaFicha, t: (s: string) => string): string {
  return t(TEXTO_DO_ALERTA[a]);
}
