/**
 * SEM FONTE, NÃO AFIRMA (PC-020) — a parte com banco e modelo. A régua pura
 * mora em `./sem-fonte.ts`.
 *
 * Por candidata: as afirmações que precisam de fonte → a fonte de cada uma
 * (material do turno + busca na base com a própria frase; falas do cliente e
 * notas do contato) → UMA chamada barata → os vetos. Sem afirmação: nenhuma
 * consulta e nenhuma chamada. Falha (banco, provedor, resposta ilegível):
 * nenhum veto, e o resultado diz que falhou (fail-open com registro).
 */
import type { Queryable } from "../queue/queue";
import { consultaDaCandidata } from "./promise/recuperar-evidencias";
import {
  afirmacoesParaConferir,
  ESTADO_PADRAO_SEM_FONTE,
  lerEstadoSemFonte,
  montarPergunta,
  SISTEMA_DA_CONFERENCIA,
  vetosDaResposta,
  type EstadoSemFonte,
  type VetoSemFonte,
} from "./sem-fonte";

export interface DepsDaConferenciaSemFonte {
  db: Queryable;
  organizationId: string;
  contactId: string | null;
  /** As fontes de conhecimento do agente (vazio = todas as ativas da organização). */
  fontes: readonly string[];
  /** O material já consultado no turno (lido NA HORA: nasce no meio do turno). */
  lerMaterialDoTurno: () => readonly string[];
  /** A chamada barata: devolve o texto do modelo. */
  chamarModelo: (sistema: string, pergunta: string) => Promise<string>;
}

export interface ResultadoSemFonte {
  estado: EstadoSemFonte;
  /** Saiu chamada de modelo? (mensagem sem afirmação: não) */
  chamou: boolean;
  vetos: VetoSemFonte[];
  /** A conferência não chegou ao fim (fail-open). */
  falhou: boolean;
  quantidade: { regra: number; cliente: number };
}

/** Busca na base com a própria frase como consulta (texto, português). Nunca lança. */
export async function buscarNaBase(
  db: Queryable,
  args: { organizationId: string; fontes: readonly string[]; frase: string },
): Promise<string[]> {
  // A mesma consulta da revisão de promessa (palavras de 3+ letras, sem as
  // vazias, unidas por OR): o stemmer português trata consulta e conteúdo.
  const consulta = consultaDaCandidata(args.frase);
  if (!consulta) return [];
  try {
    const { rows } = await db.query<{ content: string }>(
      `select c.content
         from ai_chunks c
         join ai_knowledge_sources s
           on s.id = c.knowledge_source_id and s.organization_id = c.organization_id
        where c.organization_id = $1
          and (cardinality($2::uuid[]) = 0 or s.id = any($2::uuid[]))
          and s.is_active and s.status = 'ready'
          and c.kb_version_id = s.active_kb_version_id
          and to_tsvector('portuguese', c.content) @@ websearch_to_tsquery('portuguese', $3)
        order by ts_rank_cd(to_tsvector('portuguese', c.content), websearch_to_tsquery('portuguese', $3)) desc, c.id
        limit 4`,
      [args.organizationId, [...args.fontes], consulta],
    );
    return rows.map((r) => r.content);
  } catch {
    return [];
  }
}

/** O que o cliente disse (as últimas 40 falas, com a transcrição do áudio) e as notas do contato. */
export async function falasENotasDoCliente(
  db: Queryable,
  args: { organizationId: string; contactId: string },
): Promise<{ falas: string[]; notas: string[] }> {
  const { rows: falas } = await db.query<{ texto: string | null }>(
    `select texto from (
       select coalesce(body, media_derived_text) as texto, created_at
         from messages
        where organization_id = $1 and contact_id = $2 and direction = 'inbound'
          and coalesce(body, media_derived_text) is not null
        order by created_at desc
        limit 40
     ) t order by created_at asc`,
    [args.organizationId, args.contactId],
  );
  const { rows: notas } = await db.query<{ headline: string; body: string }>(
    `select headline, body from lead_notes where organization_id = $1 and contact_id = $2
      order by updated_at desc limit 20`,
    [args.organizationId, args.contactId],
  );
  return {
    falas: falas.map((f) => f.texto ?? "").filter(Boolean),
    notas: notas.map((n) => `${n.headline}: ${n.body}`),
  };
}

async function estadoDaOrganizacao(db: Queryable, organizationId: string): Promise<EstadoSemFonte> {
  try {
    const { rows } = await db.query<{ settings: unknown }>("select settings from organizations where id = $1", [
      organizationId,
    ]);
    return lerEstadoSemFonte(rows[0]?.settings ?? null);
  } catch {
    return ESTADO_PADRAO_SEM_FONTE;
  }
}

/** A conferência de UM turno: estado lido uma vez; memo por candidata (o mesmo texto não paga duas vezes). */
export function criarConferenciaSemFonte(deps: DepsDaConferenciaSemFonte): {
  conferir(candidata: string): Promise<ResultadoSemFonte>;
} {
  let estado: Promise<EstadoSemFonte> | null = null;
  const memo = new Map<string, Promise<ResultadoSemFonte>>();
  return {
    conferir(candidata) {
      const ja = memo.get(candidata);
      if (ja) return ja;
      const r = (async (): Promise<ResultadoSemFonte> => {
        estado ??= estadoDaOrganizacao(deps.db, deps.organizationId);
        const e = await estado;
        const afirmacoes = afirmacoesParaConferir(candidata);
        const quantidade = {
          regra: afirmacoes.filter((a) => a.tipo === "regra").length,
          cliente: afirmacoes.filter((a) => a.tipo === "cliente").length,
        };
        const vazio = { estado: e, chamou: false, vetos: [], falhou: false, quantidade };
        if (e === "desligada" || afirmacoes.length === 0) return vazio;
        // Fala do cliente sem contato não tem como ser conferida: fica de fora.
        const conferiveis = afirmacoes.filter((a) => a.tipo === "regra" || deps.contactId !== null);
        if (conferiveis.length === 0) return vazio;
        try {
          const material = new Set<string>(deps.lerMaterialDoTurno());
          for (const a of conferiveis.filter((x) => x.tipo === "regra")) {
            for (const t of await buscarNaBase(deps.db, { organizationId: deps.organizationId, fontes: deps.fontes, frase: a.frase })) {
              material.add(t);
            }
          }
          const doCliente =
            deps.contactId !== null && conferiveis.some((a) => a.tipo === "cliente")
              ? await falasENotasDoCliente(deps.db, { organizationId: deps.organizationId, contactId: deps.contactId })
              : { falas: [], notas: [] };
          const texto = await deps.chamarModelo(
            SISTEMA_DA_CONFERENCIA,
            montarPergunta(conferiveis, { material: [...material].slice(0, 10), falasDoCliente: doCliente.falas, notas: doCliente.notas }),
          );
          const vetos = vetosDaResposta(texto, conferiveis);
          if (vetos === null) return { ...vazio, chamou: true, falhou: true };
          return { estado: e, chamou: true, vetos, falhou: false, quantidade };
        } catch {
          return { ...vazio, chamou: true, falhou: true };
        }
      })();
      memo.set(candidata, r);
      return r;
    },
  };
}

export type ChaveDoContadorSemFonte =
  | "sem_fonte_vetos_regra"
  | "sem_fonte_vetos_cliente"
  | "sem_fonte_observados"
  | "sem_fonte_liberados";

/** Conta na conversa (sem chamada de modelo) — o mesmo jeito da trava de repetição. */
export async function contarSemFonteNaConversa(
  db: Queryable,
  organizationId: string,
  conversationId: string,
  chave: ChaveDoContadorSemFonte,
): Promise<void> {
  await db.query(
    `update conversations
        set metadata = coalesce(metadata, '{}'::jsonb)
          || jsonb_build_object($3::text, coalesce((metadata->>$3)::int, 0) + 1)
      where organization_id = $1 and id = $2`,
    [organizationId, conversationId, chave],
  );
}
