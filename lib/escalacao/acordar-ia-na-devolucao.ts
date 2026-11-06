/**
 * DEVOLVER À IA COM O CLIENTE ESPERANDO TEM DE ACORDAR A IA.
 *
 * ─── O defeito (PM-025 §0, medido na Bórbora em 06/11/2026) ─────────────────
 *
 * `devolverAtendimentoAoAgente` solta as três travas, re-autoriza o contato e
 * emite `ai.handoff_resolved` — mas nada disso pede um turno. O único que pede
 * turno é a ENTRADA de uma mensagem (`pedirDespachoDoAgente`, em
 * `lib/channels/pos-entrada.ts`). Então a mensagem que chegou enquanto a
 * conversa estava com uma pessoa (ou com a conta suspensa) teve o pedido de
 * turno consumido SEM job naquela hora — a IA não podia falar — e, quando a
 * conversa voltou para a IA, ninguém pediu de novo. A IA ficava esperando a
 * PRÓXIMA mensagem de um cliente que já estava esperando por ela.
 *
 * Medido: 12 devoluções em 21 dias com a última mensagem do cliente sem
 * resposta, nenhuma respondida. Dois leads de anúncio que escreveram de
 * madrugada com a conta suspensa, devolvidos à IA pela manhã; um laudo enviado
 * 25 s antes da devolução automática de 30 min.
 *
 * ─── O que este arquivo faz ─────────────────────────────────────────────────
 *
 * Depois da devolução, se a ÚLTIMA mensagem da conversa é do cliente, pede o
 * turno para ela — o mesmo evento, com o mesmo payload, da entrada de uma
 * mensagem. O consumidor é o de sempre (`lib/agent-engine/edge/crm/drain.ts`),
 * e todas as travas valem: organização operante, canal ligado, grupo, agente
 * publicado, elegibilidade, espera da transcrição, rajada e janela de resposta.
 * Nada aqui decide se a IA fala; só devolve a ela a pergunta que ficou no ar.
 *
 * Não acorda quando:
 *   - a última mensagem é nossa (IA ou equipe, inclusive pelo celular): não há
 *     ninguém esperando, e responder de novo seria falar por cima;
 *   - o contato é pessoal, bloqueado ou "sempre atendimento humano";
 *   - a conversa é de grupo;
 *   - já há um pedido vivo para a mesma mensagem (não pedir em dobro).
 *
 * Nunca lança: a devolução já aconteceu quando isto roda, e uma falha aqui vira
 * log — o pior desfecho é o de antes (a IA espera a próxima mensagem).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export type DesfechoDoDespertar =
  /** A última mensagem era do cliente e o turno foi pedido. */
  | "acordou"
  /** A última mensagem é nossa, ou a conversa não tem mensagem. */
  | "ninguem_esperando"
  /** Contato pessoal, bloqueado ou "sempre atendimento humano". */
  | "contato_parado"
  /** Conversa de grupo ou sem contato. */
  | "fora_do_alcance"
  /** Já existe um pedido de turno vivo para essa mensagem. */
  | "ja_pedido"
  /** Leitura ou emissão falhou (logado). */
  | "falhou";

export interface EntradaDoDespertar {
  organizationId: string;
  conversationId: string;
  requestId: string;
  /** Rótulo para o `metadata` do evento e o log. Não é decisão. */
  origem: string;
}

const ESTADOS_VIVOS_DO_PEDIDO = ["pending", "processing"];

export async function acordarIaSeOClienteEspera(
  supabase: SupabaseClient,
  entrada: EntradaDoDespertar,
): Promise<DesfechoDoDespertar> {
  const { organizationId, conversationId } = entrada;
  try {
    const { data: conversaData, error: conversaErr } = await supabase
      .from("conversations")
      .select("id, contact_id, channel_session_id, is_group")
      .eq("organization_id", organizationId)
      .eq("id", conversationId)
      .maybeSingle();
    if (conversaErr) return falhou(entrada, "conversa", conversaErr.message);
    const conversa = conversaData as {
      contact_id: string | null;
      channel_session_id: string | null;
      is_group: boolean | null;
    } | null;
    if (!conversa || conversa.is_group !== false || !conversa.contact_id || !conversa.channel_session_id) {
      return "fora_do_alcance";
    }

    const { data: ultimaData, error: ultimaErr } = await supabase
      .from("messages")
      .select("id, direction")
      .eq("organization_id", organizationId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ultimaErr) return falhou(entrada, "ultima_mensagem", ultimaErr.message);
    const ultima = ultimaData as { id: string; direction: string } | null;
    if (!ultima || ultima.direction !== "inbound") return "ninguem_esperando";

    const { data: contatoData, error: contatoErr } = await supabase
      .from("contacts")
      .select("is_personal, is_blocked, ai_opt_out")
      .eq("organization_id", organizationId)
      .eq("id", conversa.contact_id)
      .maybeSingle();
    if (contatoErr) return falhou(entrada, "contato", contatoErr.message);
    const contato = contatoData as {
      is_personal?: boolean | null;
      is_blocked?: boolean | null;
      ai_opt_out?: boolean | null;
    } | null;
    if (contato?.is_personal === true || contato?.is_blocked === true || contato?.ai_opt_out === true) {
      return "contato_parado";
    }

    // Pedido vivo para a mesma mensagem: o dreno ainda vai processá-lo. Falha
    // desta leitura (ex.: cliente de sessão sem acesso ao event_log) não
    // impede o pedido — um pedido em dobro é coalescido pela rajada do dreno.
    const { data: vivos } = await supabase
      .from("event_log")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("event_type", "ai_agent.dispatch_requested")
      .eq("entity_id", ultima.id)
      .in("status", ESTADOS_VIVOS_DO_PEDIDO)
      .limit(1);
    if (Array.isArray(vivos) && vivos.length > 0) return "ja_pedido";

    const { error: emitErr } = await supabase.rpc("emit_event", {
      p_event_type: "ai_agent.dispatch_requested",
      p_entity_kind: "message",
      p_entity_id: ultima.id,
      p_payload: {
        organization_id: organizationId,
        conversation_id: conversationId,
        contact_id: conversa.contact_id,
        channel_session_id: conversa.channel_session_id,
        inbound_message_id: ultima.id,
      },
      p_metadata: {
        source: "escalacao.retomada",
        origem: entrada.origem,
        motivo: "devolvida_com_cliente_esperando",
        request_id: entrada.requestId,
      },
      p_organization_id: organizationId,
    });
    if (emitErr) return falhou(entrada, "emit_event", emitErr.message);

    logger.info("[escalacao.retomada] IA acordada: o cliente esperava resposta", {
      organization_id: organizationId,
      conversation_id: conversationId,
      origem: entrada.origem,
    });
    return "acordou";
  } catch (err) {
    return falhou(entrada, "excecao", err instanceof Error ? err.message : String(err));
  }
}

function falhou(entrada: EntradaDoDespertar, passo: string, detalhe: string): DesfechoDoDespertar {
  logger.warn("[escalacao.retomada] não consegui acordar a IA (ela responde na próxima mensagem)", {
    organization_id: entrada.organizationId,
    conversation_id: entrada.conversationId,
    origem: entrada.origem,
    passo,
    detalhe: detalhe.slice(0, 160),
  });
  return "falhou";
}
