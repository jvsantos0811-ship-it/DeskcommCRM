/**
 * O MODELO QUE A BATERIA TESTA — montado a partir do provedor e do id escolhidos,
 * sem passar pela escolha do ponto na tela (PM-027 §8: "Testar na bateria" roda
 * AQUELE modelo; uma escolha da tela que vencesse o pedido mediria outro).
 *
 * A chave: a credencial ativa e validada daquele provedor na organização dada
 * (a de origem dos casos, por padrão); sem ela, a chave da instalação
 * (`resolveLanguageModel`, que cobre gateway, OpenRouter, Anthropic e OpenAI).
 * Sem nenhuma das duas, `null`: a rodada para com "sem chave", nunca troca de modelo.
 *
 * `modeloDaInstalacao` é o degrau da instalação, num lugar só: a tela Provedores
 * pergunta "tem chave?" com ele (`instalacaoAtendeOModelo`), e a leitura monta o
 * modelo com ele. Assim a tela nunca diz "tem chave" para um modelo que a
 * leitura não consegue montar, nem o contrário.
 */
import type { LanguageModel } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveLanguageModel } from "@/lib/ai/gateway";
import { decifrarChave, idParaOProvider, instanciar } from "@/lib/ai/gateway-binding";

export interface EscolhaDeModelo {
  provider: string;
  model_id: string;
}

export interface ModeloMontado {
  model: LanguageModel;
  /** "provedor/modelo", como vai para `llm_calls`. */
  modelId: string;
  origem: "credencial_da_organizacao" | "instalacao";
}

export function idDaEscolha(e: EscolhaDeModelo): string {
  return e.model_id.includes("/") ? e.model_id : `${e.provider}/${e.model_id}`;
}

/** O modelo pela chave da INSTALAÇÃO (gateway, OpenRouter, Anthropic ou OpenAI do `.env`). `null` = nenhuma atende. */
export function modeloDaInstalacao(escolha: EscolhaDeModelo): LanguageModel | null {
  try {
    return resolveLanguageModel(idDaEscolha(escolha));
  } catch {
    return null;
  }
}

/** A instalação tem chave para este modelo? A mesma pergunta que a leitura faz. */
export function instalacaoAtendeOModelo(escolha: EscolhaDeModelo): boolean {
  return modeloDaInstalacao(escolha) !== null;
}

export async function montarModeloEscolhido(
  admin: SupabaseClient,
  escolha: EscolhaDeModelo,
  organizationId: string | null,
): Promise<ModeloMontado | null> {
  const completo = idDaEscolha(escolha);
  if (organizationId) {
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("provider", escolha.provider)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const credId = (data as { id?: string } | null)?.id ?? null;
    if (credId) {
      const chave = await decifrarChave(credId, organizationId);
      const id = idParaOProvider(escolha.provider, completo);
      const model = chave && id ? instanciar(escolha.provider, chave, id, null) : null;
      if (model) return { model, modelId: completo, origem: "credencial_da_organizacao" };
    }
  }
  const model = modeloDaInstalacao(escolha);
  return model ? { model, modelId: completo, origem: "instalacao" } : null;
}
