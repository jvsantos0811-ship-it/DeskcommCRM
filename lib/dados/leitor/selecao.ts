/**
 * QUEM O LEITOR LÊ NA RODADA — PM-027 §3 (substitui o §2.1 da Regra v2).
 *
 * Um lead com potencial é lido só quando houve, desde a leitura anterior (ou,
 * sem leitura, desde que o Leitor foi ligado):
 *   - chat novo;
 *   - mensagem nova do lead;
 *   - mensagem nova da IA ou da equipe (inclusive pelo celular) em CONVERSA
 *     ATIVA — o lead escreveu nos 3 dias úteis antes dela. Follow-up para lead
 *     calado há mais tempo não dispara (caso GT1).
 * Não disparam: mudança de etapa, de marcador, prazo vencido (GT3). Quem não
 * olha essas coisas não pode ser enganado por elas: a seleção só recebe as
 * datas das mensagens.
 *
 * Exceções:
 *   1. Lead que voltou: fora do alcance por etapa perdida ou por marcador que
 *      desqualifica, e mandou mensagem nova → é lido (gatilho `lead_voltou`).
 *   2. Sem carga inicial: nada anterior a `ligadoEm` conta. Ligar o Leitor numa
 *      base de 500 leads parados lê zero (GT4).
 *
 * Função pura: as datas chegam prontas (as conversas do contato, agregadas).
 */
import { passouDeDiasUteis, type Expediente } from "@/lib/dados/expediente";
import type { PosicaoNoAlcance } from "@/lib/dados/alcance-do-leitor";
import type { Gatilho } from "@/lib/dados/ficha";

/** Conversa ativa = o lead escreveu nos últimos 3 dias úteis (PM-027 §3). */
export const DIAS_UTEIS_DA_CONVERSA_ATIVA = 3;

export interface CandidatoAoLeitor {
  posicao: PosicaoNoAlcance;
  /** A leitura anterior; `null` = o lead nunca foi lido. */
  leituraAnterior: { mensagensAte: Date | null } | null;
  /** As conversas do contato (sem grupo), agregadas. */
  conversa: {
    /** A conversa mais nova do contato nasceu em… */
    criadaEm: Date | null;
    ultimaEntrada: Date | null;
    ultimaSaida: Date | null;
  };
}

export type DecisaoDoLeitor =
  | { ler: true; gatilho: Gatilho }
  | { ler: false; motivo: "fora_do_alcance" | "sem_novidade" | "conversa_parada" | "nao_voltou" };

export function decidirLeitura(
  c: CandidatoAoLeitor,
  ctx: { ligadoEm: Date; expediente: Pick<Expediente, "timezone" | "windows"> },
): DecisaoDoLeitor {
  if (c.posicao === "fora") return { ler: false, motivo: "fora_do_alcance" };

  const marco = Math.max(ctx.ligadoEm.getTime(), c.leituraAnterior?.mensagensAte?.getTime() ?? -Infinity);
  const depoisDoMarco = (d: Date | null) => d !== null && d.getTime() > marco;
  const entradaNova = depoisDoMarco(c.conversa.ultimaEntrada);

  if (c.posicao === "pode_voltar") {
    return entradaNova ? { ler: true, gatilho: "lead_voltou" } : { ler: false, motivo: "nao_voltou" };
  }

  const chatNovo = c.leituraAnterior === null && depoisDoMarco(c.conversa.criadaEm);
  if (entradaNova) return { ler: true, gatilho: chatNovo ? "chat_novo" : "mensagem_do_lead" };

  if (depoisDoMarco(c.conversa.ultimaSaida)) {
    const ativa =
      c.conversa.ultimaEntrada !== null &&
      !passouDeDiasUteis(c.conversa.ultimaEntrada, c.conversa.ultimaSaida!, DIAS_UTEIS_DA_CONVERSA_ATIVA, ctx.expediente);
    if (!ativa) return { ler: false, motivo: "conversa_parada" };
    return { ler: true, gatilho: chatNovo ? "chat_novo" : "mensagem_da_equipe" };
  }

  return { ler: false, motivo: "sem_novidade" };
}
