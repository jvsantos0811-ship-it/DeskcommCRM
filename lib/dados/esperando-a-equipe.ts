/**
 * "ESPERANDO A EQUIPE" — PM-027 §6. Quem está esperando uma PESSOA da equipe, desde
 * quando, e quando entra no painel (mais de 2 dias úteis, no horário da equipe).
 *
 * Está esperando quando qualquer destas fontes está aberta:
 *   1. a ficha do Leitor diz `esperando_a_equipe` (a IA disse que a equipe chama,
 *      o lead pediu pessoa, a equipe prometeu retorno);
 *   2. houve passagem para humano, ou há caso humano aberto;
 *   3. o lead está numa etapa "só atendimento humano" (`requires_human`).
 * O "desde" é o mais antigo entre as fontes ainda abertas.
 *
 * Passagem "atendimento manual pelo canal" quer dizer que uma pessoa JÁ respondeu:
 * a espera só começa com a primeira mensagem do lead depois da última fala de
 * pessoa (casos EQ6 e EQ7).
 *
 * Uma fonte FECHA só quando uma pessoa manda mensagem depois do "desde" dela —
 * pelo CRM ou pelo celular do escritório (que na Bórbora é quase tudo).
 * Resposta da IA não fecha (decisão do João). Mensagem automática do celular
 * (saudação do WhatsApp Business, robô do histórico importado — marcada por
 * `marcarRespostasAutomaticas`) e envio que falhou não contam.
 *
 * Função pura: as fontes e as mensagens chegam prontas.
 */
import { msDeExpedienteEntre, jornadaMaisLongaMs, passouDeDiasUteis, type Expediente } from "@/lib/dados/expediente";
import type { MOTIVOS_DA_ESPERA } from "@/lib/dados/ficha";
import { ehMensagemAutomatica } from "@/lib/messaging/textos-automaticos";

export const DIAS_UTEIS_ATE_O_PAINEL = 2;

export type MotivoDaEspera =
  | (typeof MOTIVOS_DA_ESPERA)[number]
  | "passagem_para_humano"
  | "caso_humano_aberto"
  | "etapa_so_humano";

export interface FontesDaEspera {
  /** A espera que a ficha do Leitor leu. */
  ficha: { motivo: (typeof MOTIVOS_DA_ESPERA)[number]; desde: Date } | null;
  /** A última passagem para humano; `manualPeloCanal` = uma pessoa já respondeu fora do CRM. */
  passagem: { em: Date; manualPeloCanal: boolean } | null;
  casoAberto: { desde: Date } | null;
  /** Desde quando o lead está numa etapa que exige humano. */
  etapaSoHumano: { desde: Date } | null;
}

export interface FalaDaConversa {
  direction: "inbound" | "outbound";
  sent_via: string | null;
  status: string | null;
  created_at: string;
  /** Resposta automática do WhatsApp Business (marcada por quem chama). */
  automatica?: boolean;
}

export type QuemFalouPorUltimo = "lead" | "ia" | "pessoa" | "automacao" | null;

export type Espera =
  | { esperando: false }
  | {
      esperando: true;
      motivo: MotivoDaEspera;
      desde: Date;
      /** Dias úteis esperando (horas de expediente ÷ a jornada mais longa). */
      diasUteis: number;
      /** Mais de 2 dias úteis: entra no painel. */
      noPainel: boolean;
      quemFalouPorUltimo: QuemFalouPorUltimo;
    };

/** Fala de PESSOA da equipe: pelo CRM ou pelo celular, entregue, e não a automática. */
export function ehFalaDePessoa(m: FalaDaConversa): boolean {
  if (m.direction !== "outbound" || m.status === "failed" || m.automatica) return false;
  return m.sent_via === "user" || m.sent_via === "crm" || m.sent_via === "external_device";
}

function quemFalou(m: FalaDaConversa | undefined): QuemFalouPorUltimo {
  if (!m) return null;
  if (m.direction === "inbound") return "lead";
  if (m.sent_via === "ai") return "ia";
  // Envio que falhou não chegou ao lead: não é "a pessoa respondeu".
  if (m.status === "failed") return null;
  return ehFalaDePessoa(m) ? "pessoa" : "automacao";
}

/* ------------------------------------------------------------------ */
/* Mensagem automática do celular                                      */
/* ------------------------------------------------------------------ */

/**
 * Marca `automatica` nas saídas do celular cujo TEXTO a organização usa como
 * automático (`lib/messaging/textos-automaticos.ts`: igual em 3+ conversas e
 * 80% das vezes até 60 s depois do lead). Vale para TODA mensagem com esse
 * texto, mesmo a que saiu atrasada; "[Unsupported message]" nunca é pessoa.
 */
export function marcarRespostasAutomaticas<F extends FalaDaConversa & { body?: string | null }>(
  falas: F[],
  automaticos: ReadonlySet<string>,
): F[] {
  return [...falas]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((m) => (ehMensagemAutomatica(m, automaticos) ? { ...m, automatica: true } : m));
}

export function avaliarEspera(
  f: FontesDaEspera,
  falas: FalaDaConversa[],
  agora: Date,
  expediente: Pick<Expediente, "timezone" | "windows">,
): Espera {
  const ordenadas = [...falas].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const pessoaDepois = (desde: Date) => ordenadas.some((m) => ehFalaDePessoa(m) && Date.parse(m.created_at) > desde.getTime());

  const abertas: Array<{ motivo: MotivoDaEspera; desde: Date }> = [];
  if (f.ficha) abertas.push({ motivo: f.ficha.motivo, desde: f.ficha.desde });
  if (f.passagem) {
    if (f.passagem.manualPeloCanal) {
      // Uma pessoa já respondeu: a espera é a do lead que escreveu DEPOIS da última fala de pessoa.
      const ultimaDePessoa = [...ordenadas].reverse().find(ehFalaDePessoa);
      const marco = Math.max(f.passagem.em.getTime(), ultimaDePessoa ? Date.parse(ultimaDePessoa.created_at) : 0);
      const doLead = ordenadas.find((m) => m.direction === "inbound" && Date.parse(m.created_at) > marco);
      if (doLead) abertas.push({ motivo: "passagem_para_humano", desde: new Date(doLead.created_at) });
    } else {
      abertas.push({ motivo: "passagem_para_humano", desde: f.passagem.em });
    }
  }
  if (f.casoAberto) abertas.push({ motivo: "caso_humano_aberto", desde: f.casoAberto.desde });
  if (f.etapaSoHumano) abertas.push({ motivo: "etapa_so_humano", desde: f.etapaSoHumano.desde });

  const vivas = abertas.filter((a) => !pessoaDepois(a.desde));
  if (vivas.length === 0) return { esperando: false };
  const primeira = vivas.reduce((a, b) => (b.desde < a.desde ? b : a));
  const jornada = jornadaMaisLongaMs(expediente);
  const diasUteis = jornada > 0 ? msDeExpedienteEntre(primeira.desde, agora, expediente) / jornada : 0;
  return {
    esperando: true,
    motivo: primeira.motivo,
    desde: primeira.desde,
    diasUteis,
    noPainel: passouDeDiasUteis(primeira.desde, agora, DIAS_UTEIS_ATE_O_PAINEL, expediente),
    quemFalouPorUltimo: quemFalou(ordenadas[ordenadas.length - 1]),
  };
}
