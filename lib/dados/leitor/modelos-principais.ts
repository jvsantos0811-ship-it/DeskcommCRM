/**
 * OS MODELOS PRINCIPAIS DO LEITOR — PM-027 §8: a lista que aparece no topo da
 * escolha ("Ver todos" abre o catálogo `ai_models` inteiro). Modelo que sai do
 * catálogo (`deprecated_at`) some sozinho: quem monta a lista cruza com o catálogo.
 * O preço NÃO mora aqui: vem do catálogo.
 */
export const MODELOS_PRINCIPAIS_DO_LEITOR: ReadonlyArray<{ provider: string; model_id: string }> = [
  { provider: "anthropic", model_id: "claude-haiku-5-5" },
  { provider: "anthropic", model_id: "claude-sonnet-5-5" },
  { provider: "anthropic", model_id: "claude-sonnet-4-6" },
  { provider: "anthropic", model_id: "claude-opus-5-5" },
  { provider: "openai", model_id: "gpt-6-luna" },
  { provider: "openai", model_id: "gpt-5.6-terra" },
  { provider: "openai", model_id: "gpt-6.1-sol" },
  { provider: "google", model_id: "gemini-3.1-flash-lite" },
  { provider: "google", model_id: "gemini-3.5-flash-lite" },
  { provider: "google", model_id: "gemini-3.8-flash" },
  { provider: "google", model_id: "gemini-3.1-pro-preview" },
  { provider: "google", model_id: "gemini-4-argon" },
];

/** Abaixo disto a bateria é "pequena": a nota vale, mas a tela avisa (decisão do dono, 06/11). */
export const CASOS_PARA_UMA_BATERIA_ROBUSTA = 150;

export interface ModeloDoCatalogo {
  provider: string;
  model_id: string;
  display_name: string | null;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
}

/** O nome do modelo para a tela: o do catálogo; sem ele, o id. */
export function nomeDoModelo(m: Pick<ModeloDoCatalogo, "display_name" | "model_id">): string {
  const doCatalogo = m.display_name;
  return doCatalogo !== null && doCatalogo.trim() !== "" ? doCatalogo : m.model_id;
}

/** Os principais que ainda estão no catálogo, na ordem da lista. */
export function principaisNoCatalogo(catalogo: ModeloDoCatalogo[]): ModeloDoCatalogo[] {
  const porChave = new Map(catalogo.map((m) => [`${m.provider}/${m.model_id}`, m]));
  return MODELOS_PRINCIPAIS_DO_LEITOR.map((p) => porChave.get(`${p.provider}/${p.model_id}`)).filter(
    (m): m is ModeloDoCatalogo => m !== undefined,
  );
}

/**
 * Custo estimado por mês (PM-027 §8): leituras dos últimos 30 dias × tokens
 * médios × preço do catálogo. Sem leitura ainda, usa a estimativa da ordem (§10):
 * 600 leituras, 2.300 tokens de entrada e 400 de saída. Em centavos de dólar.
 */
export function custoEstimadoPorMes(
  m: Pick<ModeloDoCatalogo, "input_price_per_million_cents" | "output_price_per_million_cents">,
  uso: { leituras: number; entradaMedia: number; saidaMedia: number } | null,
): number | null {
  if (m.input_price_per_million_cents === null || m.output_price_per_million_cents === null) return null;
  const u = uso && uso.leituras > 0 ? uso : { leituras: 600, entradaMedia: 2_300, saidaMedia: 400 };
  return (u.leituras * (u.entradaMedia * m.input_price_per_million_cents + u.saidaMedia * m.output_price_per_million_cents)) / 1_000_000;
}
