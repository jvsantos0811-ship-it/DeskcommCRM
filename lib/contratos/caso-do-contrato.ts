/**
 * O CASO DA EQUIPE SOBRE UM CONTRATO (PC-030).
 *
 * "Conferir processo e advogado pelo CPF antes de dar entrada" (assinado),
 * "Cliente recusou o contrato", "Prazo do contrato venceu", "Contrato não
 * gerado". Entra na mesma fila de Casos que a IA usa (`agent_cases`, tipo
 * `contrato`), com o evento `opened` de autoria do sistema.
 *
 * Um caso aberto por conversa é a regra da fila (`openCase`): se já há um
 * aberto, o assunto vira uma nota NESSE caso em vez de um segundo caso — a
 * equipe não perde o aviso e a fila não duplica. Nunca lança.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { TipoDeCaso } from "@/lib/ai/case-copy";
import { CASO_CONTRATO_PRONTO_PARA_APROVAR } from "@/lib/contratos/regra-da-ia";
import { logger } from "@/lib/logger";

/** O assunto do caso na fila (vocabulário de `TIPOS_DE_CASO`, nunca literal solto). */
const TIPO_DO_CASO: TipoDeCaso = "contrato";

export interface CasoDoContrato {
  orgId: string;
  conversationId: string | null;
  leadId: string | null;
  contratoId: string;
  titulo: string;
  resumo: string;
  /** O que a pessoa precisa fazer. */
  bloqueio: string;
}

export async function abrirCasoDoContrato(
  admin: SupabaseClient,
  c: CasoDoContrato,
): Promise<{ caseId: string | null; jaHaviaAberto: boolean }> {
  if (!c.conversationId) return { caseId: null, jaHaviaAberto: false };
  try {
    const { data: aberto } = await admin
      .from("agent_cases")
      .select("id")
      .eq("organization_id", c.orgId)
      .eq("conversation_id", c.conversationId)
      .in("status", ["awaiting_human", "awaiting_lead"])
      .limit(1)
      .maybeSingle();
    const existente = (aberto as { id: string } | null)?.id ?? null;
    if (existente) {
      // `agent_noted` é a nota que não muda o estado do caso (0292).
      await admin.from("agent_case_events").insert({
        organization_id: c.orgId,
        case_id: existente,
        kind: "agent_noted",
        actor_kind: "system",
        body: `${c.titulo}: ${c.bloqueio}`.slice(0, 2000),
        metadata: { contrato_id: c.contratoId },
      });
      return { caseId: existente, jaHaviaAberto: true };
    }
    const { data: criado, error } = await admin
      .from("agent_cases")
      .insert({
        organization_id: c.orgId,
        conversation_id: c.conversationId,
        lead_id: c.leadId,
        title: c.titulo.slice(0, 200),
        summary: c.resumo.slice(0, 2000),
        blocker: c.bloqueio.slice(0, 1000),
        context_snapshot: { contrato_id: c.contratoId, origem: "assinatura_eletronica" },
        source: "agent",
        kind: TIPO_DO_CASO,
      })
      .select("id")
      .single();
    if (error || !criado) throw new Error(error?.message ?? "sem linha");
    const caseId = (criado as { id: string }).id;
    await admin.from("agent_case_events").insert({
      organization_id: c.orgId,
      case_id: caseId,
      kind: "opened",
      actor_kind: "system",
    });
    return { caseId, jaHaviaAberto: false };
  } catch (err) {
    logger.warn("[contrato] caso não aberto", {
      organization_id: c.orgId,
      contrato_id: c.contratoId,
      detalhe: err instanceof Error ? err.message.slice(0, 160) : "erro",
    });
    return { caseId: null, jaHaviaAberto: false };
  }
}

/**
 * Fecha o caso "Contrato pronto para aprovar" do contrato quando a equipe já
 * decidiu pelo card: aprovou (o contrato saiu) ou descartou o rascunho para
 * corrigir. Sem isso o caso ficava aberto na fila depois de resolvido. Só o
 * caso DESTE contrato e com ESTE título; nota em caso alheio não fecha nada.
 * Fechar emite `ai.case_closed`, que tira o aviso da Central. Nunca lança.
 */
export async function fecharCasoDeAprovacao(
  admin: SupabaseClient,
  f: { orgId: string; contratoId: string; userId: string | null; nota: string },
): Promise<number> {
  try {
    const { data } = await admin
      .from("agent_cases")
      .select("id, context_snapshot")
      .eq("organization_id", f.orgId)
      .eq("kind", TIPO_DO_CASO)
      .eq("title", CASO_CONTRATO_PRONTO_PARA_APROVAR)
      .in("status", ["awaiting_human", "awaiting_lead"])
      .limit(50);
    const ids = ((data ?? []) as { id: string; context_snapshot: { contrato_id?: unknown } | null }[])
      .filter((c) => c.context_snapshot?.contrato_id === f.contratoId)
      .map((c) => c.id);
    let fechados = 0;
    for (const id of ids) {
      const agora = new Date().toISOString();
      const { data: fechado } = await admin
        .from("agent_cases")
        .update({ status: "resolved", closed_at: agora, updated_at: agora })
        .eq("organization_id", f.orgId)
        .eq("id", id)
        .in("status", ["awaiting_human", "awaiting_lead"])
        .select("id");
      if ((fechado ?? []).length === 0) continue;
      fechados += 1;
      await admin.from("agent_case_events").insert({
        organization_id: f.orgId,
        case_id: id,
        kind: "resolved",
        actor_kind: f.userId ? "human" : "system",
        actor_user_id: f.userId,
        body: f.nota.slice(0, 2000),
        metadata: { contrato_id: f.contratoId },
      });
    }
    return fechados;
  } catch (err) {
    logger.warn("[contrato] caso de aprovação não fechado", {
      organization_id: f.orgId,
      contrato_id: f.contratoId,
      detalhe: err instanceof Error ? err.message.slice(0, 160) : "erro",
    });
    return 0;
  }
}
