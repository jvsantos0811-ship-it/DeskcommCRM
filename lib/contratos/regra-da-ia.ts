/**
 * QUANDO A IA PODE ENVIAR O CONTRATO (PC-030, item 4) — a regra, pura.
 *
 * A ferramenta `enviar_contrato` só gera e manda o contrato quando:
 *  - o escritório ligou o serviço de assinatura e tem um modelo APROVADO pelo
 *    advogado para o interesse do negócio (quem confere é `gerarContratoDoModelo`);
 *  - o card está na etapa configurada no funil ("Etapa em que a IA envia o
 *    contrato", ex.: "Aguardando assinatura");
 *  - o campo "já tem advogado ou processo sobre esse pedido?" está CONFIRMADO
 *    com NÃO (decisão do João, 10/11). Com SIM a IA não envia: passa para uma
 *    pessoa do time e o card vai para "Análise humana";
 *  - os campos obrigatórios do modelo estão CONFIRMADOS (conferidos ao gerar).
 *
 * Cada recusa volta à IA com o que fazer — nunca silêncio.
 */
import type { StatusDeCampo } from "@/lib/leads/status-dos-campos";

/** A chave do campo do funil "Já tem advogado ou processo sobre esse pedido?". */
export const CAMPO_ADVOGADO_OU_PROCESSO = "ja_tem_advogado_ou_processo";

/** A tag que o negócio ganha quando o contrato sai (a de assinado é `contrato-assinado`). */
export const TAG_CONTRATO_ENVIADO = "contrato-enviado";

export const CASO_CONTRATO_PRONTO_PARA_APROVAR = "Contrato pronto para aprovar";
export const CASO_CONTRATO_NAO_GERADO = "Contrato não gerado";

/** A etapa do funil em que a IA pode enviar o contrato (`settings.etapa_do_contrato`). */
export function etapaDoContrato(settings: unknown): string | null {
  const v = (settings as { etapa_do_contrato?: unknown } | null)?.etapa_do_contrato;
  return typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
}

function semAcento(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** O que o cliente respondeu sobre advogado/processo: sim, não, ou não dá para dizer. */
export function respostaSimNao(valor: unknown): "sim" | "nao" | null {
  if (valor === true) return "sim";
  if (valor === false) return "nao";
  if (typeof valor !== "string") return null;
  const t = semAcento(valor);
  if (!t) return null;
  if (/^(nao|n|nenhum|nenhuma|negativo|nunca)\b/.test(t)) return "nao";
  if (/^(sim|s|tem|tenho|ja tem|ja tenho|possui|possuo|positivo)\b/.test(t)) return "sim";
  return null;
}

export interface FatosDoEnvioPelaIa {
  etapaDoContrato: string | null;
  etapaAtual: string | null;
  nomeDaEtapaDoContrato: string | null;
  campoAdvogado: { existe: boolean; status: StatusDeCampo | null; valor: unknown };
}

export type DecisaoDoEnvioPelaIa =
  | { pode: true }
  | { pode: false; motivo: "sem_etapa_configurada" | "fora_da_etapa" | "falta_conferir_advogado"; mensagem: string }
  | { pode: false; motivo: "tem_advogado_ou_processo"; mensagem: string };

/** Pura: as travas que vêm ANTES de gerar o contrato. */
export function decidirEnvioPelaIa(f: FatosDoEnvioPelaIa): DecisaoDoEnvioPelaIa {
  if (!f.etapaDoContrato) {
    return {
      pode: false,
      motivo: "sem_etapa_configurada",
      mensagem:
        "o envio do contrato pela IA não está ligado neste funil. Não prometa o contrato: diga que a equipe vai mandar e siga a conversa.",
    };
  }
  // "Já tem advogado ou processo?" vem antes da etapa: SIM passa para a equipe
  // de qualquer etapa (decisão do João).
  const resposta = f.campoAdvogado.status === "CONFIRMADO" ? respostaSimNao(f.campoAdvogado.valor) : null;
  if (resposta === "sim") {
    return {
      pode: false,
      motivo: "tem_advogado_ou_processo",
      mensagem:
        "o cliente já tem advogado ou processo sobre este pedido: o contrato NÃO vai. A conversa passou para uma pessoa da equipe.",
    };
  }
  if (resposta !== "nao") {
    return {
      pode: false,
      motivo: "falta_conferir_advogado",
      mensagem:
        'antes do contrato, pergunte ao cliente se ele já tem advogado ou processo sobre esse pedido e registre a resposta confirmada no campo "' +
        CAMPO_ADVOGADO_OU_PROCESSO +
        '". Só com NÃO o contrato pode ir.',
    };
  }
  if (f.etapaAtual !== f.etapaDoContrato) {
    return {
      pode: false,
      motivo: "fora_da_etapa",
      mensagem: `o contrato só sai com o negócio na etapa "${f.nomeDaEtapaDoContrato ?? "do contrato"}". Siga a qualificação até lá; não prometa o contrato antes.`,
    };
  }
  return { pode: true };
}

export interface EtapaParaAnalise {
  id: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  is_archived?: boolean;
}

/**
 * Para onde o card vai quando o contrato pede uma pessoa (cliente com advogado
 * ou processo; reclamação do contrato): a "Etapa quando a equipe assume" do
 * funil — aqui SEM a trava de "só para frente" do PC-029 (o card sai de
 * "Aguardando assinatura"), mas nunca de um ganho ou perda. Pura.
 */
export function destinoDaAnaliseHumana(
  etapas: readonly EtapaParaAnalise[],
  etapaAtualId: string | null,
  destinoId: string | null,
): string | null {
  if (!destinoId || !etapaAtualId || destinoId === etapaAtualId) return null;
  const destino = etapas.find((e) => e.id === destinoId && e.is_archived !== true);
  const atual = etapas.find((e) => e.id === etapaAtualId);
  if (!destino || !atual) return null;
  if (destino.is_won || destino.is_lost || atual.is_won || atual.is_lost) return null;
  return destino.id;
}
