import type { PipelineVocabulary } from "./types";

const DEFAULTS: Required<PipelineVocabulary> = {
  lead: "Lead",
  deal: "Negócio",
  won: "Ganho",
  lost: "Perdido",
  interesse: "Interesse",
};

/** O padrão do rótulo do interesse — o texto que a tela passa pelo `t()`. */
export const ROTULO_PADRAO_DO_INTERESSE = "Interesse";

/**
 * O nome da coluna "Interesse" deste funil: o que o dono escreveu em
 * `vocabulary.interesse`, ou `null` quando não escreveu — e aí a tela mostra
 * `t(ROTULO_PADRAO_DO_INTERESSE)`. Nome escrito pelo dono não passa pelo `t()`:
 * é texto dele, no idioma dele.
 */
export function rotuloDoInteresse(v: PipelineVocabulary | null | undefined): string | null {
  const escrito = typeof v?.interesse === "string" ? v.interesse.trim() : "";
  return escrito === "" ? null : escrito;
}

export function resolveVocabulary(
  v: PipelineVocabulary | null | undefined,
): Required<PipelineVocabulary> {
  return { ...DEFAULTS, ...(v ?? {}) };
}
