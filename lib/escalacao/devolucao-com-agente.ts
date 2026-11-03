/**
 * DEVOLVER PARA A IA ESCOLHENDO O AGENTE (PC-014, ampliação M7).
 *
 * Regra do João (03/11/2026): a conversa que foi passada para a equipe fica com
 * a pessoa — ela só volta para um agente quando alguém clica "Devolver para a
 * IA". Num número com roteador (vários agentes), quem devolve escolhe PARA QUAL
 * agente e escreve em uma linha o que fez; essa linha entra no bloco de chegada
 * do agente (`blocoDeChegada`, `lib/agent-engine/agent/passagem-entre-agentes.ts`).
 *
 * A devolução em si continua sendo `devolverAtendimentoAoAgente` (as três
 * travas, o checkpoint, o sinal de retomada). Este módulo só faz o que vem
 * DEPOIS: põe a conversa com o agente escolhido e grava a passagem com origem
 * `equipe`. A escrita é do servidor (a tabela da passagem só tem SELECT para
 * quem está logado), sempre filtrada pela organização da sessão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Até quantos caracteres a linha "o que você fez" guarda. */
export const TETO_DA_NOTA_DA_DEVOLUCAO = 200;
/** Menos que isto não diz nada ao agente. */
export const PISO_DA_NOTA_DA_DEVOLUCAO = 3;

export interface AgenteDoRoteador {
  id: string;
  nome: string;
  /** `null` para o agente de reserva do roteador. */
  intencao: string | null;
}

export interface RoteadorDaConversa {
  roteadorId: string | null;
  agentes: AgenteDoRoteador[];
}

/**
 * O roteador ativo do número desta conversa e seus agentes PUBLICADOS (membros
 * e reserva). Sem roteador ativo, `roteadorId` é `null` e a lista vem vazia: a
 * devolução segue de um clique, como sempre foi.
 */
export async function agentesDoRoteadorDaConversa(
  admin: SupabaseClient,
  organizationId: string,
  conversationId: string,
): Promise<RoteadorDaConversa> {
  const { data: conv } = await admin
    .from("conversations")
    .select("channel_session_id")
    .eq("organization_id", organizationId)
    .eq("id", conversationId)
    .maybeSingle();
  const sessao = (conv as { channel_session_id: string | null } | null)?.channel_session_id ?? null;
  if (sessao === null) return { roteadorId: null, agentes: [] };

  const { data: roteador } = await admin
    .from("ai_routers")
    .select("id, fallback_agent_id")
    .eq("organization_id", organizationId)
    .eq("channel_session_id", sessao)
    .eq("is_active", true)
    .maybeSingle();
  const r = roteador as { id: string; fallback_agent_id: string | null } | null;
  if (r === null) return { roteadorId: null, agentes: [] };

  const { data: membros } = await admin
    .from("ai_router_members")
    .select("agent_id, intent_name, position")
    .eq("organization_id", organizationId)
    .eq("router_id", r.id)
    .order("position", { ascending: true });
  const lista = ((membros ?? []) as Array<{ agent_id: string; intent_name: string }>).map((m) => ({
    id: m.agent_id,
    intencao: m.intent_name as string | null,
  }));
  if (r.fallback_agent_id !== null && !lista.some((m) => m.id === r.fallback_agent_id)) {
    lista.push({ id: r.fallback_agent_id, intencao: null });
  }
  if (lista.length === 0) return { roteadorId: r.id, agentes: [] };

  const { data: agentes } = await admin
    .from("ai_agents")
    .select("id, name, published_version_id, archived_at")
    .eq("organization_id", organizationId)
    .in("id", lista.map((m) => m.id));
  const publicados = new Map(
    ((agentes ?? []) as Array<{ id: string; name: string; published_version_id: string | null; archived_at: string | null }>)
      .filter((a) => a.published_version_id !== null && a.archived_at === null)
      .map((a) => [a.id, a.name]),
  );
  return {
    roteadorId: r.id,
    agentes: lista
      .filter((m) => publicados.has(m.id))
      .map((m) => ({ id: m.id, nome: publicados.get(m.id)!, intencao: m.intencao })),
  };
}

export type ValidacaoDaDevolucao =
  | { ok: true; agente: AgenteDoRoteador | null; nota: string | null }
  | { ok: false; erro: "agente_obrigatorio" | "agente_fora_do_roteador" | "nota_obrigatoria" };

/**
 * Com roteador: agente e nota são obrigatórios, e o agente tem de ser do
 * roteador. Sem roteador: nada é exigido (o clique de sempre). Puro.
 */
export function validarDevolucao(
  roteador: RoteadorDaConversa,
  pedido: { agenteId?: string | null; nota?: string | null },
): ValidacaoDaDevolucao {
  const nota = (pedido.nota ?? "").trim().slice(0, TETO_DA_NOTA_DA_DEVOLUCAO);
  if (roteador.roteadorId === null || roteador.agentes.length === 0) {
    return { ok: true, agente: null, nota: nota === "" ? null : nota };
  }
  if (!pedido.agenteId) return { ok: false, erro: "agente_obrigatorio" };
  const agente = roteador.agentes.find((a) => a.id === pedido.agenteId);
  if (agente === undefined) return { ok: false, erro: "agente_fora_do_roteador" };
  if (nota.length < PISO_DA_NOTA_DA_DEVOLUCAO) return { ok: false, erro: "nota_obrigatoria" };
  return { ok: true, agente, nota };
}

/**
 * Depois de devolvida, a conversa fica com o agente escolhido e a passagem com
 * origem `equipe` é gravada (a linha da pessoa vira o "cartão" da chegada).
 */
export async function aplicarAgenteEscolhido(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    conversationId: string;
    roteadorId: string;
    agente: AgenteDoRoteador;
    nota: string;
    userId: string;
  },
): Promise<{ ok: true; passagemId: string } | { ok: false; detalhe: string }> {
  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .update({
      active_ai_agent_id: args.agente.id,
      active_intent: args.agente.intencao,
      active_agent_set_at: new Date().toISOString(),
    })
    .eq("organization_id", args.organizationId)
    .eq("id", args.conversationId)
    .select("contact_id")
    .maybeSingle();
  if (convErr || !conv) return { ok: false, detalhe: convErr?.message ?? "conversa não encontrada" };

  const { data: passagem, error: passErr } = await admin
    .from("passagens_entre_agentes")
    .insert({
      organization_id: args.organizationId,
      conversation_id: args.conversationId,
      contact_id: (conv as { contact_id: string | null }).contact_id,
      router_id: args.roteadorId,
      de_agente_id: null,
      para_agente_id: args.agente.id,
      intencao: args.agente.intencao,
      origem: "equipe",
      desfecho: "passou",
      cartao: args.nota.slice(0, TETO_DA_NOTA_DA_DEVOLUCAO),
      por_user_id: args.userId,
    })
    .select("id")
    .single();
  if (passErr || !passagem) return { ok: false, detalhe: passErr?.message ?? "passagem não gravada" };
  return { ok: true, passagemId: (passagem as { id: string }).id };
}
