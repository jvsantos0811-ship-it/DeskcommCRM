/**
 * PC-062 — O DESFECHO DA LIGAÇÃO PELA COR DO GOOGLE (regra pura, sem rede nem banco).
 *
 * Numa operação em que a equipe não entra no CRM, o "Realizado / Faltou" de um
 * compromisso nunca era registrado, e as etapas que dependem dele (e o
 * follow-up de falta) nunca andavam. A equipe já usa o Google Agenda: depois da
 * ligação, pinta o evento com a cor combinada, e o sync lê a cor de volta.
 *
 * ─── Por que isto não abre a porta para a IA ──────────────────────────────
 *
 * O desfecho é declaração HUMANA (migration 0224): o banco recusa `completed` e
 * `no_show` vindos de quem não é pessoa da equipe, e a IA não registra o fato
 * pelo que leu (`crm_set_appointment_outcome`). A cor pintada à mão no Google é
 * declaração da equipe. A exceção mora numa porta única do banco
 * (`fn_appointment_outcome_from_google`, só service_role, só com a cor
 * configurada no tipo), e a autoria fica gravada como `google_color`.
 *
 * ─── As cores ─────────────────────────────────────────────────────────────
 *
 * Ids de cor de evento do Google (`colors.get`). As três da presença do lead
 * (5, 10, 11, `presenca-cor.ts`) ficam de fora: é o próprio CRM que as pinta, e
 * lê-las como desfecho faria o CRM decidir sozinho o que a equipe declara.
 */
import { COR_DA_PRESENCA } from "./presenca-cor";

export const CORES_DE_DESFECHO = ["1", "2", "3", "4", "6", "7", "8", "9"] as const;
export type CorDeDesfecho = (typeof CORES_DE_DESFECHO)[number];

/** O nome que o Google mostra para cada cor (o que a equipe vê ao pintar). */
export const NOME_DA_COR: Record<CorDeDesfecho, string> = {
  "1": "Lavanda",
  "2": "Sálvia",
  "3": "Uva",
  "4": "Flamingo",
  "6": "Tangerina",
  "7": "Pavão",
  "8": "Grafite",
  "9": "Mirtilo",
};

export function ehCorDeDesfecho(v: unknown): v is CorDeDesfecho {
  return typeof v === "string" && (CORES_DE_DESFECHO as readonly string[]).includes(v);
}

export type Desfecho = "completed" | "no_show";

export interface CoresDoTipo {
  realizado: string | null;
  faltou: string | null;
}

/**
 * A cor do evento é um desfecho? `null` = não (desligado, cor nenhuma, cor da
 * presença ou outra cor). Pura.
 */
export function desfechoDaCor(colorId: unknown, cores: CoresDoTipo): Desfecho | null {
  if (typeof colorId !== "string" || colorId === "") return null;
  if ((Object.values(COR_DA_PRESENCA) as string[]).includes(colorId)) return null;
  if (ehCorDeDesfecho(cores.realizado) && colorId === cores.realizado) return "completed";
  if (ehCorDeDesfecho(cores.faltou) && colorId === cores.faltou) return "no_show";
  return null;
}

/**
 * Este compromisso recebe o desfecho agora? Pura.
 *
 * - só depois do início (desfecho é sobre o passado; o banco recusa o resto);
 * - cancelado não volta;
 * - o mesmo desfecho de novo não refaz nada; trocar de Faltou para Realizado
 *   (ou o contrário) corrige.
 */
export function aplicaDesfecho(
  compromisso: { status: string; starts_at: string },
  desfecho: Desfecho,
  agora: Date,
): boolean {
  if (compromisso.status === desfecho) return false;
  if (!["pending", "confirmed", "completed", "no_show"].includes(compromisso.status)) return false;
  const inicio = Date.parse(compromisso.starts_at);
  return Number.isFinite(inicio) && inicio <= agora.getTime();
}
