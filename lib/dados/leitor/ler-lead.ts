/**
 * UMA LEITURA DO LEITOR DA CONVERSA — PM-027 §1, §4 e §8.
 *
 * Lê a conversa transcrita de um lead e devolve a Ficha (fatos com prova),
 * validada pelo schema central. Ponto de IA `leitor_da_conversa` (tela
 * Provedores, papel "Entender a conversa"); custo e erro em `llm_calls`.
 *
 * Três travas antes de gastar:
 *   1. Sem modelo aprovado, não lê (quem chama já confere a configuração; aqui
 *      o resolvedor sem resposta também é "sem modelo").
 *   2. O modelo que vai rodar tem de ser O APROVADO na bateria. Se o resolvedor
 *      devolver outro (ex.: a escolha da tela foi descartada e caiu num padrão),
 *      não lê: ficha feita por modelo que não passou na bateria não entra nos
 *      painéis (§8: "só liga com 100%").
 *   3. O teto de gasto de IA da organização.
 *
 * Nunca lança: o resultado diz o que aconteceu.
 */
import { generateObject, type LanguageModel } from "ai";

import { podeGastarComIa } from "@/lib/ai/budget/pode-gastar";
import { computeCost } from "@/lib/ai/cost";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { registrarChamadaDeIa } from "@/lib/ai/usage/registrar-chamada";
import { fichaDoLeitorSchema, type FichaDoLeitor } from "@/lib/dados/ficha";
import type { createAdminClient } from "@/lib/supabase/admin";

import type { ModeloDoLeitor } from "./config";

export const PONTO_DO_LEITOR = "leitor_da_conversa";
const TEMPO_LIMITE_MS = 60_000;
const TOKENS_DE_SAIDA = 1_500;

export interface EntradaDaLeitura {
  organizationId: string;
  contactId: string | null;
  /** O prompt-molde já preenchido (`montarPromptDoLeitor`). */
  sistema: string;
  /** A conversa transcrita (`transcreverConversa`). */
  conversa: string;
  aprovado: ModeloDoLeitor;
}

export type ResultadoDaLeitura =
  | { tipo: "lida"; ficha: FichaDoLeitor; modelo: string; latenciaMs: number }
  | { tipo: "sem_modelo" }
  | { tipo: "modelo_diferente"; usado: string; aprovado: string }
  | { tipo: "teto" }
  | { tipo: "falhou"; modelo: string; erro: string };

export type Leitor = (e: EntradaDaLeitura) => Promise<ResultadoDaLeitura>;

export type Classificar = (
  model: LanguageModel,
  sistema: string,
  conversa: string,
) => Promise<{ ficha: FichaDoLeitor; promptTokens: number; completionTokens: number }>;

/** A leitura em si (também usada pela bateria, com o modelo que ela testa). */
export const lerComModelo: Classificar = async (model, sistema, conversa) => {
  const r = await generateObject({
    model,
    schema: fichaDoLeitorSchema,
    system: sistema,
    prompt: conversa,
    temperature: 0,
    maxOutputTokens: TOKENS_DE_SAIDA,
    abortSignal: AbortSignal.timeout(TEMPO_LIMITE_MS),
  });
  const usage = r.usage as { inputTokens?: number; outputTokens?: number } | undefined;
  return { ficha: r.object, promptTokens: usage?.inputTokens ?? 0, completionTokens: usage?.outputTokens ?? 0 };
};

/** "anthropic/claude-haiku-5-5" e "claude-haiku-5-5" são o mesmo modelo. */
export function mesmoModelo(a: string, b: string): boolean {
  const so = (x: string) => x.trim().toLowerCase().replace(/^[a-z0-9-]+\//, "");
  return so(a) === so(b);
}

/** O id do modelo aprovado como o resolvedor espera ("provedor/modelo"). */
export function idDoModeloAprovado(m: ModeloDoLeitor): string {
  return m.model_id.includes("/") ? m.model_id : `${m.provider}/${m.model_id}`;
}

/** O Leitor de produção. `classificar` existe para o teste. */
export function criarLeitor(admin: ReturnType<typeof createAdminClient>, classificar: Classificar = lerComModelo): Leitor {
  return async (e) => {
    const aprovado = idDoModeloAprovado(e.aprovado);
    const resolvido = await resolverModeloDoPonto(PONTO_DO_LEITOR, e.organizationId, aprovado);
    if (!resolvido) return { tipo: "sem_modelo" };
    if (!mesmoModelo(resolvido.modelId, aprovado)) {
      return { tipo: "modelo_diferente", usado: resolvido.modelId, aprovado };
    }

    const orcamento = await podeGastarComIa(e.organizationId, PONTO_DO_LEITOR);
    if (!orcamento.pode) return { tipo: "teto" };

    const t0 = Date.now();
    try {
      const c = await classificar(resolvido.model, e.sistema, e.conversa);
      const ficha = fichaDoLeitorSchema.parse(c.ficha);
      const latenciaMs = Date.now() - t0;
      const custo = await computeCost({
        model: resolvido.modelId,
        promptTokens: c.promptTokens,
        completionTokens: c.completionTokens,
      });
      await registrarChamadaDeIa(admin as never, {
        organization_id: e.organizationId,
        contact_id: e.contactId,
        purpose: "leitor_da_conversa",
        model: resolvido.modelId,
        input_tokens: c.promptTokens,
        output_tokens: c.completionTokens,
        cost_cents: custo,
        latency_ms: latenciaMs,
      });
      return { tipo: "lida", ficha, modelo: resolvido.modelId, latenciaMs };
    } catch (err) {
      const erro = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      await registrarChamadaDeIa(admin as never, {
        organization_id: e.organizationId,
        contact_id: e.contactId,
        purpose: "leitor_da_conversa",
        model: resolvido.modelId,
        input_tokens: 0,
        output_tokens: 0,
        cost_cents: 0,
        latency_ms: Date.now() - t0,
        erro: { message: erro },
      });
      return { tipo: "falhou", modelo: resolvido.modelId, erro };
    }
  };
}
