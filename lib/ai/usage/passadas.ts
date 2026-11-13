/**
 * PC-035 (medição) — o que cada PASSADA de uma chamada ao modelo consumiu.
 *
 * `llm_calls` guardava só a soma da chamada. Uma resposta do agente é um laço
 * de várias passadas, e é o número delas que multiplica o custo: sem o detalhe,
 * o raio-X do turno era estimativa. Aqui fica, por passada, só NÚMERO e NOME de
 * ferramenta — nunca texto de mensagem, argumento ou resultado.
 *
 * Mora em `llm_calls.passadas` (jsonb). Este arquivo é o esquema: quem grava e
 * quem lê passa por aqui (a tela e a consulta do MCP não leem o jsonb à mão).
 */
import { z } from 'zod';

export const passadaSchema = z.object({
  /** Posição no laço, de 1 em diante. */
  n: z.number().int().positive(),
  /** Tokens de entrada da passada (total: sem cache + lidos + gravados). */
  entrada: z.number().int().nonnegative(),
  /** Tokens de entrada lidos do cache. */
  cache_lido: z.number().int().nonnegative(),
  /** Tokens de entrada gravados no cache. */
  cache_gravado: z.number().int().nonnegative(),
  /** Dos gravados, quantos no cache de 5 minutos e quantos no de 1 hora (quando o provedor informa). */
  cache_gravado_5m: z.number().int().nonnegative().nullable(),
  cache_gravado_1h: z.number().int().nonnegative().nullable(),
  /** Tokens de saída da passada. */
  saida: z.number().int().nonnegative(),
  /** Nomes das ferramentas pedidas na passada, na ordem. */
  ferramentas: z.array(z.string()),
  /** Caracteres de texto que o modelo escreveu FORA de ferramenta (o motor descarta, mas paga). */
  texto_descartado_chars: z.number().int().nonnegative(),
});
export type Passada = z.infer<typeof passadaSchema>;

export const passadasSchema = z.array(passadaSchema);

/** O que este módulo lê de um passo do AI SDK. */
export interface PassoDoSdk {
  usage?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    inputTokenDetails?: { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined } | undefined;
  };
  toolCalls?: ReadonlyArray<{ toolName: string }>;
  text?: string;
  providerMetadata?: Record<string, unknown> | undefined;
}

/**
 * A gravação de cache por validade, como a Anthropic devolve no uso cru
 * (`usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`,
 * que o `@ai-sdk/anthropic` repassa em `providerMetadata.anthropic.usage`).
 * `null` quando o provedor não informa a divisão.
 */
export function gravacaoPorValidade(
  providerMetadata: Record<string, unknown> | undefined,
): { em5m: number; em1h: number } | null {
  const usage = (providerMetadata?.['anthropic'] as { usage?: unknown } | undefined)?.usage;
  const criacao = (usage as { cache_creation?: unknown } | undefined)?.cache_creation;
  if (criacao === null || typeof criacao !== 'object') return null;
  const c = criacao as { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown };
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  const em5m = n(c.ephemeral_5m_input_tokens);
  const em1h = n(c.ephemeral_1h_input_tokens);
  if (em5m === null && em1h === null) return null;
  return { em5m: em5m ?? 0, em1h: em1h ?? 0 };
}

/** As passadas de uma chamada, a partir dos passos do AI SDK. Nunca lança. */
export function passadasDosPassos(steps: ReadonlyArray<PassoDoSdk> | undefined): Passada[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((s, i) => {
    const porValidade = gravacaoPorValidade(s.providerMetadata);
    return {
      n: i + 1,
      entrada: s.usage?.inputTokens ?? 0,
      cache_lido: s.usage?.inputTokenDetails?.cacheReadTokens ?? 0,
      cache_gravado: s.usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
      cache_gravado_5m: porValidade?.em5m ?? null,
      cache_gravado_1h: porValidade?.em1h ?? null,
      saida: s.usage?.outputTokens ?? 0,
      ferramentas: (s.toolCalls ?? []).map((c: { toolName: string }) => c.toolName),
      texto_descartado_chars: (s.text ?? '').length,
    };
  });
}

/**
 * A gravação de cache da chamada inteira, dividida por validade — a soma das
 * passadas. `null` quando alguma passada com gravação não trouxe a divisão: aí
 * o custo cai na regra de antes (a validade configurada na instalação).
 */
export function gravacaoDaChamadaPorValidade(passadas: readonly Passada[]): { em5m: number; em1h: number } | null {
  let em5m = 0;
  let em1h = 0;
  for (const p of passadas) {
    if (p.cache_gravado === 0) continue;
    if (p.cache_gravado_5m === null || p.cache_gravado_1h === null) return null;
    em5m += p.cache_gravado_5m;
    em1h += p.cache_gravado_1h;
  }
  return { em5m, em1h };
}

/** Lê `llm_calls.passadas` como veio do banco. Inválido ou ausente = lista vazia. */
export function lerPassadas(cru: unknown): Passada[] {
  const lido = passadasSchema.safeParse(cru);
  return lido.success ? lido.data : [];
}
