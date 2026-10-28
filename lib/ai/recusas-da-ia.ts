/**
 * O registro de recusas e bloqueios da IA — a forma da linha (migration 9010).
 * Compartilhado pelo worker (`lib/agent-engine/agent/recusas.ts`, via pg) e
 * pelas rotas/ferramentas MCP (`lib/leads/trava-da-ia.ts`, via PostgREST).
 * Ver o cabeçalho de `lib/agent-engine/agent/recusas.ts`.
 */
export const TIPOS_DE_RECUSA = [
  'envio_bloqueado',
  'etapa_recusada',
  'ganho_recusado',
  'assinatura_recusada',
] as const;
export type TipoDeRecusa = (typeof TIPOS_DE_RECUSA)[number];

export interface RecusaDaIa {
  organizationId: string;
  tipo: TipoDeRecusa;
  agentId?: string | null;
  agentVersionId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  conversationId?: string | null;
  ferramenta?: string | null;
  trava?: string | null;
  codigo?: string | null;
  etapaPedida?: string | null;
  camposFaltantes?: ReadonlyArray<{ chave: string; rotulo: string }>;
  motivo?: string | null;
}

/** Ids vazios viram `null` — o turno de teste usa `''` como "sem contato". */
function idOuNulo(v: string | null | undefined): string | null {
  return v && v.trim() !== '' ? v : null;
}

/** As colunas na ordem do INSERT — uma lista só para o caminho pg e o do PostgREST. */
export function linhaDaRecusa(r: RecusaDaIa): Record<string, unknown> {
  return {
    organization_id: r.organizationId,
    tipo: r.tipo,
    agent_id: idOuNulo(r.agentId),
    agent_version_id: idOuNulo(r.agentVersionId),
    contact_id: idOuNulo(r.contactId),
    lead_id: idOuNulo(r.leadId),
    conversation_id: idOuNulo(r.conversationId),
    ferramenta: r.ferramenta ?? null,
    trava: r.trava ?? null,
    codigo: r.codigo ?? null,
    etapa_pedida: r.etapaPedida ?? null,
    campos_faltantes: (r.camposFaltantes ?? []).map((c) => ({ chave: c.chave, rotulo: c.rotulo })),
    // O motivo é a frase da regra; o teto evita que um texto longo de ensino
    // vire coluna gigante. Nada de conteúdo do cliente passa por aqui.
    motivo: r.motivo ? r.motivo.slice(0, 1000) : null,
  };
}

