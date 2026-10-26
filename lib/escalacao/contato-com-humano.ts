/**
 * ═══ QUEM CHEGA POR TOKEN NÃO FALA POR CIMA DE UMA PESSOA DA EQUIPE ═══
 *
 * Quando a conversa vai para humano, o agent-engine cala de verdade
 * (`isLeadInHandoff` no começo do turno; `stopGate` na cadeia de envio). Mas a
 * porta de saída do sistema, `sendMessageHandler`, só recusava contato
 * bloqueado e pessoal: um agente EXTERNO pelo MCP (`crm_send_whatsapp_message`,
 * `crm_start_conversation_and_send`) ou uma integração por `Bearer dsk_…`
 * mandava mensagem no meio do atendimento humano. Medido no código em
 * 26/10/2026 (briefing do Operador, item 2.1).
 *
 * ─── Quem é barrado, e quem não é ──────────────────────────────────────────
 *
 * Só quem chega POR TOKEN: `api_token`, e `ai_agent` com `api_token_id` (o
 * token do MCP e o efêmero das ferramentas do runtime). O mesmo recorte da
 * janela de 24 h, um pouco mais estreito:
 *
 *  - pessoa pela tela (`user`) segue podendo — é ela que atende;
 *  - mensagem agendada (`user`) e proposta enviada (`user`) seguem: foram
 *    escritas por uma pessoa;
 *  - envios internos do motor (`ai_agent` SEM token) — o aviso ao cliente que
 *    sai ANTES do silêncio, o link de reunião que uma pessoa autorizou, a
 *    resposta aprovada — seguem, porque cada um já passa pela própria régua e
 *    barrá-los aqui apagaria justamente o aviso de que uma pessoa vem aí;
 *  - automação e campanha (`webhook_source`) não entram neste recorte.
 *
 * ─── O predicado ───────────────────────────────────────────────────────────
 *
 * O MESMO de `isLeadInHandoff` (lib/agent-engine/agent/human-handoff.ts):
 * `force_human`, `ai_opt_out`, ou QUALQUER conversa do contato silenciada.
 * Duas réguas para "está com uma pessoa" divergiriam no primeiro ajuste.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";

/** O ator chegou por token (MCP externo, runtime com token, REST por Bearer)? */
export function chegouPorToken(actor: Actor): boolean {
  return actor.type === "api_token" || (actor.type === "ai_agent" && !!actor.api_token_id);
}

/**
 * O contato está com uma pessoa da equipe? Lança em erro de leitura: na dúvida,
 * a mensagem por token não sai (o chamador re-tenta; o cliente não recebe nada
 * por cima de quem o atende).
 */
export async function contatoEstaComHumano(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<boolean> {
  const { data: contato, error: erroDoContato } = await supabase
    .from("contacts")
    .select("force_human, ai_opt_out")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  if (erroDoContato) throw new Error(erroDoContato.message);
  const c = contato as { force_human?: boolean | null; ai_opt_out?: boolean | null } | null;
  if (c?.force_human === true || c?.ai_opt_out === true) return true;

  const { count, error: erroDaConversa } = await supabase
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .gt("bot_silenced_until", new Date().toISOString());
  if (erroDaConversa) throw new Error(erroDaConversa.message);
  return (count ?? 0) > 0;
}
