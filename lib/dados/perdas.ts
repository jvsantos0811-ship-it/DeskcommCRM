/**
 * MOTIVO DE PERDA EM EXPLORAR › MEDIR (PC-025, item 1) — a regra, pura.
 *
 * Quantos cards foram perdidos por motivo no período (pela DATA DA PERDA),
 * com o percentual sobre o total perdido, incluindo "sem motivo". Filtros:
 * funil (na consulta), etapa de onde o card saiu, quem marcou (IA ou pessoa),
 * agente de IA, origem/anúncio. Clicar no número lista os cards do motivo.
 *
 * "Quem marcou" e "de onde saiu" vêm da linha da linha do tempo que encerrou o
 * card (`demand_closed` com desfecho perdido, ou `stage_changed` para a etapa
 * de perda): o mesmo registro que a tela do card mostra. O "agente de IA" é o
 * que marcou, quando foi a IA; senão, o que atendia o contato por último.
 */

export type QuemMarcou = "ia" | "pessoa" | "outro";

export interface PerdaNoPeriodo {
  id: string;
  titulo: string;
  pipeline_id: string;
  /** O motivo gravado no card; vazio/nulo = "sem motivo". */
  motivo: string | null;
  perdido_em: string;
  etapa_de_onde_saiu: string | null;
  marcou: QuemMarcou;
  agente_id: string | null;
  origem: string | null;
  anuncio_id: string | null;
}

export interface FiltrosDasPerdas {
  etapa?: string | null;
  marcou?: QuemMarcou | null;
  agente?: string | null;
  /** `anuncio:<id>` para um anúncio; senão o `source` do card. */
  origem?: string | null;
}

export interface MotivoNoPeriodo {
  /** Vazio = "sem motivo". */
  motivo: string;
  leads: number;
  pct: number;
  ids: string[];
}

export interface ResultadoDasPerdas {
  total: number;
  motivos: MotivoNoPeriodo[];
}

export const SEM_MOTIVO = "";

export function chaveDaOrigem(p: Pick<PerdaNoPeriodo, "origem" | "anuncio_id">): string {
  return p.anuncio_id ? `anuncio:${p.anuncio_id}` : (p.origem ?? "");
}

export function filtrarPerdas(
  perdas: readonly PerdaNoPeriodo[],
  f: FiltrosDasPerdas,
): PerdaNoPeriodo[] {
  return perdas.filter(
    (p) =>
      (!f.etapa || p.etapa_de_onde_saiu === f.etapa) &&
      (!f.marcou || p.marcou === f.marcou) &&
      (!f.agente || p.agente_id === f.agente) &&
      (!f.origem || chaveDaOrigem(p) === f.origem),
  );
}

export function contarPorMotivo(perdas: readonly PerdaNoPeriodo[]): ResultadoDasPerdas {
  const grupos = new Map<string, string[]>();
  for (const p of perdas) {
    const k = p.motivo?.trim() || SEM_MOTIVO;
    grupos.set(k, [...(grupos.get(k) ?? []), p.id]);
  }
  const total = perdas.length;
  const motivos = [...grupos.entries()]
    .map(([motivo, ids]) => ({
      motivo,
      leads: ids.length,
      pct: total > 0 ? Math.round((ids.length / total) * 1000) / 10 : 0,
      ids,
    }))
    // Maior primeiro; "sem motivo" por último no empate, para não esconder os nomeados.
    .sort(
      (a, b) =>
        b.leads - a.leads ||
        Number(a.motivo === SEM_MOTIVO) - Number(b.motivo === SEM_MOTIVO) ||
        a.motivo.localeCompare(b.motivo),
    );
  return { total, motivos };
}

/** O tipo do ator da linha do tempo → "quem marcou". */
export function quemMarcou(actorKind: string | null | undefined): QuemMarcou {
  if (actorKind === "ai") return "ia";
  if (actorKind === "user") return "pessoa";
  return "outro";
}
