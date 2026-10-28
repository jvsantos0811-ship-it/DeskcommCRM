/**
 * Tempo de resposta da IA por turno (PC-002, Fase 1, item 5).
 *
 * Uma linha em `tempos_de_resposta_da_ia` (migration 9009) por turno de
 * resposta: da última mensagem do cliente (chegada ao CRM) até a 1ª bolha, e
 * quantas mensagens do cliente o turno respondeu. Só horários e contagens —
 * nada do que foi dito.
 *
 * A hora da última mensagem do cliente é lida do banco no próprio INSERT: a
 * mais nova inbound da conversa até a 1ª bolha (ou até agora, quando nada saiu).
 * Idempotente por job: um turno re-executado não duplica a medida.
 */
import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

export interface TempoDoTurno {
  organizationId: string;
  conversationId: string;
  agentId: string | null;
  jobId: string;
  primeiraBolhaEm: Date | null;
  mensagensRespondidas: number;
  bolhasRetidas: number;
  ferramentasQueFalharam: number;
}

const limitar = (n: number): number => Math.max(0, Math.min(32_767, Math.trunc(n)));

export async function gravarTempoDoTurno(db: Queryable, t: TempoDoTurno): Promise<void> {
  await db.query(
    `with ultima as (
       select max(m.created_at) as em from messages m
        where m.organization_id = $1 and m.conversation_id = $2 and m.direction = 'inbound'
          and m.created_at <= coalesce($5::timestamptz, now())
     )
     insert into tempos_de_resposta_da_ia
       (organization_id, conversation_id, agent_id, job_id, ultima_msg_cliente_em,
        primeira_bolha_em, espera_ms, mensagens_respondidas, bolhas_retidas, ferramentas_falharam)
     select $1, $2, $3, $4, u.em, $5::timestamptz,
            case when $5::timestamptz is null or u.em is null then null
                 else greatest(0, round(extract(epoch from ($5::timestamptz - u.em)) * 1000))::int end,
            $6, $7, $8
       from ultima u
     on conflict (organization_id, job_id) do update
        set primeira_bolha_em = excluded.primeira_bolha_em,
            ultima_msg_cliente_em = excluded.ultima_msg_cliente_em,
            espera_ms = excluded.espera_ms,
            mensagens_respondidas = excluded.mensagens_respondidas,
            bolhas_retidas = excluded.bolhas_retidas,
            ferramentas_falharam = excluded.ferramentas_falharam`,
    [
      t.organizationId,
      t.conversationId,
      t.agentId,
      t.jobId,
      t.primeiraBolhaEm?.toISOString() ?? null,
      limitar(t.mensagensRespondidas),
      limitar(t.bolhasRetidas),
      limitar(t.ferramentasQueFalharam),
    ],
  );
}
