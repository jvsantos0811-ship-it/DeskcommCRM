/**
 * A TRAVA DE ETAPA E DE GANHO PARA A IA (PC-003).
 *
 * Antes, o prompt era a única coisa que impedia a IA de levar um negócio a
 * "Qualificado", "Fechado" ou ganho com a qualificação incompleta. Agora a
 * regra mora no código, e vale para TODA ferramenta que a IA chama:
 *
 *  1. **Ganho só por evento.** Nenhuma ferramenta da IA marca ganho — nem
 *     `update_lead_state` com `won`, nem `crm_move_lead_stage` para a etapa de
 *     ganho, nem `crm_close_demand` com `won`. O ganho acontece quando o
 *     contrato é assinado: aviso `contrato.assinado` de um provedor de
 *     assinatura ou uma pessoa gerente confirmando ("Assinatura confirmada").
 *  2. **Campo obrigatório vazio barra a etapa**, com a régua da IA: campo com
 *     status só conta com CONFIRMADO, NEGADO ou NAO_SE_APLICA.
 *  3. **Modo conservador**: com ele ligado no agente, a IA não move para etapa
 *     marcada "só pessoa move".
 *
 * Toda recusa volta ao modelo como frase legível (ele pergunta o que falta em
 * vez de inventar) e fica registrada em `recusas_da_ia` (aba Execuções).
 *
 * Pessoas movendo pela tela NÃO passam por aqui — o pedido manda não mudar o
 * comportamento delas.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CampoFaltando } from "@/lib/leads/campos-exigidos";
import { linhaDaRecusa, type RecusaDaIa } from "@/lib/ai/recusas-da-ia";

/** O código da recusa de ganho — o mesmo em todas as ferramentas. */
export const CODIGO_GANHO_SO_POR_ASSINATURA = "ganho_so_por_assinatura";
export const CODIGO_ETAPA_SO_PESSOA_MOVE = "etapa_so_pessoa_move";
export const CODIGO_CAMPOS_DA_ETAPA = "required_fields_missing";

/** A frase que o modelo lê quando tenta marcar ganho. */
export const RECUSA_DE_GANHO_PELA_IA =
  "Você não pode marcar o negócio como ganho/fechado. O ganho só é registrado quando o contrato é " +
  "assinado (aviso do serviço de assinatura ou uma pessoa da equipe confirma a assinatura). " +
  "Continue o atendimento normalmente e não diga ao cliente que o contrato está fechado.";

/** "Não dá para mover para "Qualificado": faltam os campos X, Y." — critério do pedido. */
export function recusaDeEtapaParaAIa(nomeDaEtapa: string, faltando: readonly CampoFaltando[]): string {
  const nomes = faltando.map((c) => c.rotulo).join(", ");
  return (
    `Não dá para mover para "${nomeDaEtapa}": faltam os campos ${nomes}. ` +
    "Pergunte ao cliente o que falta, sem inventar nem supor a resposta, e registre o que ele disser " +
    "antes de tentar de novo."
  );
}

/** A frase do modo conservador. */
export function recusaDeEtapaSoPessoa(nomeDaEtapa: string): string {
  return (
    `Não dá para mover para "${nomeDaEtapa}": neste atendimento só uma pessoa da equipe move o ` +
    "negócio para essa etapa. Continue qualificando e, quando estiver pronto, passe para a equipe."
  );
}

/**
 * O modo conservador do agente — lido da versão PUBLICADA (é ela que roda no
 * atendimento). Falha de leitura = desligado: a trava de campos e a de ganho
 * continuam valendo; o modo conservador é uma camada a mais, opt-in.
 */
export async function modoConservadorDoAgente(
  supabase: SupabaseClient,
  organizationId: string,
  agentId: string | null | undefined,
): Promise<{ ligado: boolean; versaoId: string | null }> {
  if (!agentId) return { ligado: false, versaoId: null };
  try {
    const { data } = await supabase
      .from("ai_agents")
      .select("published_version_id")
      .eq("organization_id", organizationId)
      .eq("id", agentId)
      .maybeSingle();
    const versaoId = (data as { published_version_id?: string | null } | null)?.published_version_id ?? null;
    if (!versaoId) return { ligado: false, versaoId: null };
    const { data: v } = await supabase
      .from("ai_agent_versions")
      .select("modo_conservador")
      .eq("organization_id", organizationId)
      .eq("id", versaoId)
      .maybeSingle();
    return { ligado: (v as { modo_conservador?: boolean } | null)?.modo_conservador === true, versaoId };
  } catch {
    return { ligado: false, versaoId: null };
  }
}

/**
 * Grava a recusa pelo cliente do PostgREST (rotas e ferramentas MCP). Nunca
 * lança: o registro não pode derrubar a recusa que ele descreve.
 */
export async function registrarRecusaPeloSupabase(
  supabase: SupabaseClient,
  r: RecusaDaIa,
): Promise<void> {
  try {
    await supabase.from("recusas_da_ia").insert(linhaDaRecusa(r));
  } catch {
    /* melhor-esforço — ver lib/agent-engine/agent/recusas.ts */
  }
}
