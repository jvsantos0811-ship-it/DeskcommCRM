/**
 * Em que filtro da linha do tempo cada registro do negócio cai (PC-013).
 *
 * A linha do tempo virou um painel com filtros por tipo — Etapas, Conversa,
 * Tarefas, Contratos e propostas, Sistema. O vocabulário de tipos é ABERTO
 * (`crm_lead_activities.type` não tem CHECK; ver `activity-vocabulary.ts`),
 * então a regra é por prefixo e lista, e tudo o que ela não reconhece cai em
 * "Sistema": um tipo novo nunca some da linha do tempo, no máximo aparece no
 * filtro mais genérico.
 */

export type CategoriaDoRegistro = "etapas" | "conversa" | "tarefas" | "contratos" | "sistema";

export const CATEGORIAS_DO_REGISTRO: readonly CategoriaDoRegistro[] = [
  "etapas",
  "conversa",
  "tarefas",
  "contratos",
  "sistema",
] as const;

const ETAPAS = new Set([
  "lead_created",
  "stage_changed",
  "agent_move_corrected",
  "moved_from_pipeline",
  "lead_disqualified",
  "lead_needs_review",
  "lead_won",
  "lead_lost",
  "lead_reopened",
]);

const CONVERSA = new Set([
  "ai_turn",
  "send_vetoed",
  "handoff_triggered",
  "handoff_resolved",
  "consent_declined",
  "demand_closed",
  "contact_marked_personal",
  "contact_unmarked_personal",
]);

const TAREFAS = new Set(["note", "next_action_approved", "next_action_dismissed"]);

export function categoriaDoRegistro(tipo: string): CategoriaDoRegistro {
  if (ETAPAS.has(tipo)) return "etapas";
  if (CONVERSA.has(tipo) || tipo.startsWith("conversation_") || tipo.startsWith("voice_call")) {
    return "conversa";
  }
  if (
    TAREFAS.has(tipo) ||
    tipo.startsWith("task_") ||
    tipo.startsWith("appointment_") ||
    tipo.startsWith("followup_")
  ) {
    return "tarefas";
  }
  if (tipo.startsWith("contract_") || tipo.startsWith("proposal_")) return "contratos";
  return "sistema";
}
