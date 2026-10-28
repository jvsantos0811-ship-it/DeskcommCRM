/**
 * O QUE FAZER QUANDO A IA PERCEBE IRRITAÇÃO (PC-002b, item 6).
 *
 * `organizations.settings.irritacao`:
 *  - `"anotar"` (PADRÃO): o sinal vira anotação no histórico do negócio, com a
 *    nota e o trecho; ninguém é transferido e a IA continua na conversa;
 *  - `"passar"`: o comportamento anterior — passagem para a equipe
 *    (`triggerHandoff` com `low_sentiment`).
 *
 * O padrão mudou por medida: em 28/10/2026 às 07:29 um falso positivo numa
 * mensagem calma, no meio da qualificação, mandou um lead quente para uma fila
 * vazia. Um classificador sobre UMA mensagem não decide sozinho quem atende.
 */
import { z } from "zod";

export type AcaoDaIrritacao = "anotar" | "passar";

export const irritacaoEntradaSchema = z.object({ acao: z.enum(["anotar", "passar"]) }).strict();

/** O corpo do PATCH de Configurações › Atendimento: frase da fila + irritação. */
export const filaEIrritacaoEntradaSchema = z
  .object({
    frase_da_fila: z.string().max(300).transform((v) => v.replace(/\s+/g, " ").trim()),
    irritacao: z.enum(["anotar", "passar"]),
  })
  .strict();

export function acaoDaIrritacao(settings: unknown): AcaoDaIrritacao {
  if (settings && typeof settings === "object" && !Array.isArray(settings)) {
    if ((settings as Record<string, unknown>).irritacao === "passar") return "passar";
  }
  return "anotar";
}
