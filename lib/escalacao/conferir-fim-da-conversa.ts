/**
 * "A CONVERSA TERMINOU?" — a leitura curta do aviso Ninguém respondeu
 * (PM-027 §7, 2ª camada). Ponto de IA `conferir_fim_da_conversa`.
 *
 * Só roda quando a forma da última mensagem não decide (`decidirPelaForma`
 * devolveu "indeciso") e o lead já esperou 1 hora de expediente. Lê as últimas
 * 6 mensagens e responde se a conversa terminou e não precisa de resposta.
 *
 * NA DÚVIDA, AVISA: sem modelo, sem chave, com o teto de gasto atingido ou com
 * erro na chamada, a resposta é "não terminou" — um aviso a mais é barato; um
 * lead esperando sem ninguém saber é o defeito que este aviso existe para
 * pegar.
 *
 * O modelo vem da tela Provedores (o binding deste ponto); sem escolha própria,
 * HERDA o modelo aprovado do Leitor da conversa (PM-027 §8: "padrão: herda o
 * modelo do Leitor"); sem os dois, o classificador barato do produto ou o padrão
 * da organização. Custo e tokens em `llm_calls`, como toda chamada de IA, sempre
 * no ponto deste aviso.
 */
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

import { podeGastarComIa } from "@/lib/ai/budget/pode-gastar";
import { computeCost } from "@/lib/ai/cost";
import { DEFAULT_CLASSIFIER_MODEL } from "@/lib/ai/gateway";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { registrarChamadaDeIa } from "@/lib/ai/usage/registrar-chamada";
import { configDoLeitor } from "@/lib/dados/leitor/config";
import { idDoModeloAprovado, PONTO_DO_LEITOR } from "@/lib/dados/leitor/ler-lead";
import type { createAdminClient } from "@/lib/supabase/admin";

import type { MensagemDaConversa } from "./ninguem-respondeu";

export const PONTO_CONFERIR_FIM = "conferir_fim_da_conversa";

const TEMPO_LIMITE_MS = 20_000;

const SISTEMA = `Você confere conversas de WhatsApp entre um contato (lead) e uma empresa (a equipe ou a assistente virtual dela).
A última mensagem é do contato e ninguém da empresa respondeu ainda. Decida se a conversa TERMINOU e não precisa de resposta.

Terminou só quando a última fala do contato fecha o assunto: agradece, confirma que entendeu, se despede ou só reconhece o que a empresa disse, e não sobra pergunta, pedido, documento, áudio com dúvida ou pendência do lado da empresa.
NÃO terminou quando o contato pergunta, pede algo, manda informação ou documento para análise, reclama, cumprimenta abrindo conversa, ou quando a empresa ficou de fazer alguma coisa.

Na dúvida, responda que NÃO terminou.
Em "motivo", escreva uma frase curta (até 15 palavras), sem copiar dados pessoais.`;

const esquema = z.object({
  terminou: z.boolean().describe("true só se a conversa terminou e não precisa de resposta."),
  motivo: z.string().describe("Uma frase curta, sem dados pessoais."),
});

export interface VereditoDoFim {
  terminou: boolean;
  origem: "leitura" | "sem_modelo" | "teto" | "falhou";
  modelo: string | null;
}

/** O que a rodada injeta (o teste passa um dublê). */
export type ConferidorDoFim = (entrada: {
  organizationId: string;
  contactId: string | null;
  trecho: MensagemDaConversa[];
}) => Promise<VereditoDoFim>;

/** O trecho que o modelo lê: papel, tipo e texto, sem nome nem telefone. */
export function trechoParaLeitura(trecho: MensagemDaConversa[]): string {
  return trecho
    .map((m) => {
      const quem =
        m.direction === "inbound" ? "Contato" : m.sent_via === "ai" ? "Assistente virtual" : "Equipe";
      const texto = (m.body ?? m.media_derived_text ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
      const tipo = m.type === "text" ? "" : `[${m.type}] `;
      return `${quem}: ${tipo}${texto}`;
    })
    .join("\n");
}

type Classificar = (model: LanguageModel, trecho: string) => Promise<{
  terminou: boolean;
  promptTokens: number;
  completionTokens: number;
}>;

const classificarComModelo: Classificar = async (model, trecho) => {
  const r = await generateObject({
    model,
    schema: esquema,
    system: SISTEMA,
    prompt: trecho,
    temperature: 0,
    maxOutputTokens: 200,
    abortSignal: AbortSignal.timeout(TEMPO_LIMITE_MS),
  });
  const usage = r.usage as { inputTokens?: number; outputTokens?: number } | undefined;
  return {
    terminou: r.object.terminou === true,
    promptTokens: usage?.inputTokens ?? 0,
    completionTokens: usage?.outputTokens ?? 0,
  };
};

/**
 * O modelo herdado do Leitor: só quando este ponto NÃO tem escolha própria na
 * tela e o Leitor tem um modelo aprovado. Qualquer erro de leitura = sem herança
 * (o caminho de sempre).
 */
export async function modeloHerdadoDoLeitor(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<string | null> {
  try {
    const { data: proprio, error: e1 } = await admin
      .from("ai_purpose_bindings")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("purpose", PONTO_CONFERIR_FIM)
      .eq("is_enabled", true)
      .maybeSingle();
    if (e1 || proprio) return null;
    const { data: org, error: e2 } = await admin.from("organizations").select("settings").eq("id", organizationId).maybeSingle();
    if (e2 || !org) return null;
    const modelo = configDoLeitor((org as { settings?: unknown }).settings).modelo;
    return modelo ? idDoModeloAprovado(modelo) : null;
  } catch {
    return null;
  }
}

/** O conferidor de produção. `classificar` existe para o teste. */
export function criarConferidorDoFim(
  admin: ReturnType<typeof createAdminClient>,
  classificar: Classificar = classificarComModelo,
): ConferidorDoFim {
  return async ({ organizationId, contactId, trecho }) => {
    const herdado = await modeloHerdadoDoLeitor(admin, organizationId);
    const resolvido = herdado
      ? await resolverModeloDoPonto(PONTO_DO_LEITOR, organizationId, herdado)
      : await resolverModeloDoPonto(PONTO_CONFERIR_FIM, organizationId, DEFAULT_CLASSIFIER_MODEL, {
          naFaltaUsarOPadraoDaOrganizacao: true,
        });
    if (!resolvido) return { terminou: false, origem: "sem_modelo", modelo: null };

    const orcamento = await podeGastarComIa(organizationId, PONTO_CONFERIR_FIM);
    if (!orcamento.pode) return { terminou: false, origem: "teto", modelo: resolvido.modelId };

    const t0 = Date.now();
    try {
      const c = await classificar(resolvido.model, trechoParaLeitura(trecho));
      const custo = await computeCost({
        model: resolvido.modelId,
        promptTokens: c.promptTokens,
        completionTokens: c.completionTokens,
      });
      await registrarChamadaDeIa(admin as never, {
        organization_id: organizationId,
        contact_id: contactId,
        purpose: "conferir_fim_da_conversa",
        model: resolvido.modelId,
        input_tokens: c.promptTokens,
        output_tokens: c.completionTokens,
        cost_cents: custo,
        latency_ms: Date.now() - t0,
      });
      return { terminou: c.terminou, origem: "leitura", modelo: resolvido.modelId };
    } catch (err) {
      await registrarChamadaDeIa(admin as never, {
        organization_id: organizationId,
        contact_id: contactId,
        purpose: "conferir_fim_da_conversa",
        model: resolvido.modelId,
        input_tokens: 0,
        output_tokens: 0,
        cost_cents: 0,
        latency_ms: Date.now() - t0,
        erro: { message: err instanceof Error ? err.message : String(err) },
      });
      return { terminou: false, origem: "falhou", modelo: resolvido.modelId };
    }
  };
}
