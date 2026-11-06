/**
 * O JUIZ DA BATERIA — PM-027 §9.1. Ponto de IA `juiz_da_bateria` (papel
 * "Melhorar e testar"). Só roda quando o modelo testado e o gabarito discordam.
 *
 * Recebe a conversa congelada, as instruções do Leitor e as duas respostas,
 * sorteadas como "A" e "B", SEM saber qual é o gabarito. Devolve "A", "B", "as
 * duas erradas" ou "dúvida", com uma frase de motivo e o trecho que prova. O
 * efeito da decisão é de `aplicarDecisao` (bateria.ts), não daqui.
 */
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

import { DECISOES_DO_JUIZ, type DecisaoDoJuiz, type Divergencia, type LadoDoGabarito } from "./bateria";

export const PONTO_DO_JUIZ = "juiz_da_bateria";
const TEMPO_LIMITE_MS = 60_000;

const esquema = z.object({
  decisao: z.enum(DECISOES_DO_JUIZ),
  motivo: z.string().max(300),
  trecho: z.string().max(400),
});

export interface VeredictoDoJuiz {
  decisao: DecisaoDoJuiz;
  motivo: string;
  trecho: string;
  promptTokens: number;
  completionTokens: number;
}

export type Julgar = (model: LanguageModel, sistema: string, pergunta: string) => Promise<VeredictoDoJuiz>;

export const julgarComModelo: Julgar = async (model, sistema, pergunta) => {
  const r = await generateObject({
    model,
    schema: esquema,
    system: sistema,
    prompt: pergunta,
    temperature: 0,
    maxOutputTokens: 500,
    abortSignal: AbortSignal.timeout(TEMPO_LIMITE_MS),
  });
  const usage = r.usage as { inputTokens?: number; outputTokens?: number } | undefined;
  return { ...r.object, promptTokens: usage?.inputTokens ?? 0, completionTokens: usage?.outputTokens ?? 0 };
};

/** Sorteia de que lado fica o gabarito. `aleatorio` existe para o teste. */
export function sortearLado(aleatorio: () => number = Math.random): LadoDoGabarito {
  return aleatorio() < 0.5 ? "A" : "B";
}

function valor(v: unknown): string {
  if (v === null || v === undefined) return "(vazio)";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * O que o juiz lê. O sistema é o mesmo prompt do Leitor (as regras de cada campo);
 * a pergunta traz a conversa e, campo a campo, as duas respostas.
 */
export function montarJulgamento(e: {
  instrucoesDoLeitor: string;
  conversa: string;
  divergencias: Divergencia[];
  ladoDoGabarito: LadoDoGabarito;
}): { sistema: string; pergunta: string } {
  const sistema = `Você é o juiz de uma bateria de testes. Duas leituras da MESMA conversa discordam em alguns campos da ficha do lead.
Decida qual leitura segue as instruções abaixo, usando só o que está escrito na conversa.
Responda "A", "B", "as_duas_erradas" (nenhuma segue as instruções) ou "duvida" (a conversa não basta para decidir).
Em "motivo", uma frase curta. Em "trecho", copie o trecho curto da conversa que prova a decisão (vazio se for dúvida).

INSTRUÇÕES DO LEITOR:
${e.instrucoesDoLeitor}`;
  const linhas = e.divergencias.map((d) => {
    const doGabarito = valor(d.esperado);
    const doModelo = valor(d.obtido);
    const [a, b] = e.ladoDoGabarito === "A" ? [doGabarito, doModelo] : [doModelo, doGabarito];
    return `- ${d.campo}: A = ${a} | B = ${b}`;
  });
  const pergunta = `CONVERSA:\n${e.conversa}\n\nONDE AS LEITURAS DISCORDAM:\n${linhas.join("\n")}`;
  return { sistema, pergunta };
}
