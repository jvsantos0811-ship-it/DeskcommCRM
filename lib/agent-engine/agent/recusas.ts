/**
 * O REGISTRO DE RECUSAS E BLOQUEIOS DA IA (migration 9010, PC-002b e PC-003).
 *
 * Toda vez que o sistema barra a IA — a mensagem inteira vetada por uma trava
 * de envio, uma etapa recusada por campo obrigatório vazio, um ganho recusado —
 * uma linha vai para `recusas_da_ia`, e a aba Execuções do agente a mostra.
 * Antes disso o rastro existia só em `before_send_traces` e numa atividade da
 * linha do tempo, e a aba que o dono abre para investigar ("por que o cliente
 * ficou sem resposta?") dizia que nada tinha acontecido.
 *
 * ⚠️ NUNCA texto de conversa aqui: só ids, nomes técnicos e o motivo que a
 * regra escreveu. O texto bloqueado vai para o caso humano, que a LGPD já
 * alcança; esta tabela sobrevive à anonimização sem carregar o que o cliente
 * disse.
 *
 * Melhor-esforço: o registro nunca derruba a operação que ele descreve. Uma
 * recusa que não ficou registrada é ruim; um turno que caiu porque o registro
 * falhou é pior (o cliente ficaria sem resposta por causa do diário de bordo).
 */
import type pg from 'pg';

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

/** Grava pelo pool do worker (turno do agente). Nunca lança. */
export async function registrarRecusaDaIa(
  db: Pick<pg.Pool, 'query'>,
  r: RecusaDaIa,
  log?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<void> {
  const l = linhaDaRecusa(r);
  try {
    await db.query(
      `insert into recusas_da_ia
         (organization_id, tipo, agent_id, agent_version_id, contact_id, lead_id, conversation_id,
          ferramenta, trava, codigo, etapa_pedida, campos_faltantes, motivo)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
      [
        l.organization_id,
        l.tipo,
        l.agent_id,
        l.agent_version_id,
        l.contact_id,
        l.lead_id,
        l.conversation_id,
        l.ferramenta,
        l.trava,
        l.codigo,
        l.etapa_pedida,
        JSON.stringify(l.campos_faltantes),
        l.motivo,
      ],
    );
  } catch (err) {
    log?.warn('não foi possível registrar a recusa da IA', {
      tipo: r.tipo,
      codigo: r.codigo ?? null,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
  }
}
