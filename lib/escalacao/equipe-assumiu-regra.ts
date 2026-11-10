/**
 * A REGRA PURA de "a equipe assumiu respondendo" (PC-029): motivos, frase da
 * linha do tempo e para qual etapa o card vai. Sem banco, sem servidor — a tela
 * de Configurações › Funis importa daqui. O serviço com banco é
 * `lib/escalacao/equipe-assumiu.ts`.
 */

/** Espelho de `MOTIVO_ATENDIMENTO_MANUAL` (`atendimento-manual.ts`): o texto que a tela e os painéis já reconhecem. */
const MOTIVO_ATENDIMENTO_MANUAL = "Atendimento manual pelo canal (resposta fora do CRM)";

/** O motivo gravado quando a pessoa respondeu pela tela do CRM. */
export const MOTIVO_EQUIPE_RESPONDEU_PELO_CRM = "Equipe assumiu respondendo pelo CRM";

/** O motivo do celular é o de sempre: a tela e os painéis já o reconhecem. */
export const MOTIVO_EQUIPE_RESPONDEU_PELO_CELULAR = MOTIVO_ATENDIMENTO_MANUAL;

export type OrigemDaResposta = "crm" | "celular";

/** A frase da linha do tempo. Pura. */
export function fraseDaLinhaDoTempo(origem: OrigemDaResposta, nome: string | null): string {
  const base =
    origem === "crm" ? MOTIVO_EQUIPE_RESPONDEU_PELO_CRM : "Equipe assumiu respondendo pelo celular";
  return nome ? `${base} (${nome})` : base;
}

export interface EtapaDoFunil {
  id: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  is_archived?: boolean;
}

/**
 * O card vai para a etapa de destino? Só quando ela existe, está ativa, e a
 * etapa atual vem ANTES dela na ordem do funil e não é de ganho nem de perda.
 * Card em "Aguardando assinatura", "Falta documento", "Fechado" ou
 * "Desqualificado" (depois do destino, ou ganho/perda) fica onde está. Pura.
 */
export function destinoQuandoAEquipeAssume(
  etapas: readonly EtapaDoFunil[],
  etapaAtualId: string | null,
  destinoId: string | null | undefined,
): string | null {
  if (!destinoId || !etapaAtualId || destinoId === etapaAtualId) return null;
  const destino = etapas.find((e) => e.id === destinoId && e.is_archived !== true);
  const atual = etapas.find((e) => e.id === etapaAtualId);
  if (!destino || !atual) return null;
  if (destino.is_won || destino.is_lost || atual.is_won || atual.is_lost) return null;
  return Number(atual.position) < Number(destino.position) ? destino.id : null;
}

/** Lê `crm_pipelines.settings.etapa_quando_equipe_assume` sem lançar. */
export function etapaQuandoAEquipeAssume(settings: unknown): string | null {
  const v = (settings as { etapa_quando_equipe_assume?: unknown } | null)
    ?.etapa_quando_equipe_assume;
  return typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
}
