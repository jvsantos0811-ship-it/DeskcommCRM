import { serviceFromMessage } from "@/lib/atendimento/origem-mensagem";
/**
 * Handler: ai-handoff-from-sentiment.v1
 *
 * Consume `ai.sentiment_alert` (emitido por `ai-sentiment-worker` quando
 * sentiment_score < threshold) e dispara handoff via orquestrador central
 * com reason='low_sentiment' (gate G2 do EPIC-06).
 *
 * Service-role bypassa RLS → toda query filtra `organization_id` programático.
 */

import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { CHAVES_DO_CLIMA } from "@/lib/ai/decisao/metadados-do-clima";
import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { acaoDaIrritacao } from "@/lib/escalacao/irritacao";

export const AI_HANDOFF_FROM_SENTIMENT_KEY = "ai-handoff-from-sentiment.v1";

export const aiHandoffFromSentimentHandler: EventHandler = {
  key: AI_HANDOFF_FROM_SENTIMENT_KEY,
  naOrgParada: "pula",
  events: ["ai.sentiment_alert"],
  async handle(row): Promise<HandlerResult> {
    const messageId =
      (row.payload?.["message_id"] as string | undefined) ?? row.entity_id ?? null;
    const conversationIdHint =
      (row.payload?.["conversation_id"] as string | undefined) ?? null;
    const sentimentScore =
      (row.payload?.["sentiment_score"] as number | undefined) ?? null;
    /** Qual motor mediu — a passagem marca "(percebido pelo Jev)" quando foi ele. */
    const sentimentEngine =
      (row.payload?.[CHAVES_DO_CLIMA.motor] as string | undefined) ?? null;

    if (!messageId && !conversationIdHint) {
      return {
        consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY,
        status: "skipped",
        detail: "missing_ids",
      };
    }

    const admin = createAdminClient();

    const boundary = messageId ? await serviceFromMessage(admin, row.organization_id, messageId) : null;
    if (!boundary || (conversationIdHint && boundary.conversation_id !== conversationIdHint)) {
      return { consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY, status: "skipped", detail: "service_boundary_stale" };
    }
    const conversationId = boundary.conversation_id;
    const contactId = boundary.contact_id;

    // Best-effort: resolve the most recent open lead for this contact so the
    // orchestrator can write a timeline activity. If unavailable we still
    // proceed — handoff itself doesn't depend on having a lead.
    let leadId: string | null = null;
    if (contactId) {
      const { data: lead } = await admin
        .from("crm_leads")
        .select("id, organization_id, status, created_at")
        .eq("organization_id", row.organization_id)
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lead) leadId = (lead as { id: string }).id;
    }

    // PC-002b (item 6, F1-o): o detector de irritação SÓ ANOTA, por padrão.
    // Medido em 28/10/2026 (07:29): um falso positivo numa mensagem calma
    // mandou um lead quente para uma fila vazia e tirou a IA da conversa. Um
    // sinal de UMA mensagem não decide sozinho quem atende: vira anotação no
    // histórico (com a nota e o trecho), e o atendimento segue com quem estava.
    // A organização que quiser o comportamento antigo escolhe "Passar para a
    // equipe" em Configurações › Distribuição de atendimento.
    const { data: org } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", row.organization_id)
      .maybeSingle();
    if (acaoDaIrritacao((org as { settings?: unknown } | null)?.settings ?? null) === "anotar") {
      let trecho: string | null = null;
      if (messageId) {
        const { data: msg } = await admin
          .from("messages")
          .select("body")
          .eq("organization_id", row.organization_id)
          .eq("id", messageId)
          .maybeSingle();
        const corpo = (msg as { body?: string | null } | null)?.body ?? null;
        trecho = corpo ? corpo.slice(0, 300) : null;
      }
      const nota = typeof sentimentScore === "number" ? sentimentScore.toFixed(2) : "?";
      if (leadId) {
        await emitLeadActivity(admin, {
          organizationId: row.organization_id,
          leadId,
          contactId,
          type: "note",
          sourceModule: "ai_sentiment",
          sourceId: messageId,
          actor: { type: "webhook_source", id: "clima-da-conversa" },
          reason:
            `A IA percebeu possível irritação nesta mensagem (nota ${nota}). Só anotado: ` +
            "o atendimento seguiu com quem estava.",
          payload: {
            sentiment_score: sentimentScore,
            [CHAVES_DO_CLIMA.motor]: sentimentEngine,
            message_id: messageId,
            trecho,
          },
        });
      } else {
        await admin.from("agent_inbox_items").insert({
          organization_id: row.organization_id,
          kind: "other",
          severity: "info",
          title: "A IA percebeu possível irritação — só anotado",
          body: `Nota ${nota}. O atendimento seguiu com quem estava.${trecho ? ` Trecho: "${trecho}"` : ""}`,
          ref_kind: "conversation",
          ref_id: conversationId,
        });
      }
      return {
        consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY,
        status: "ok",
        detail: "irritacao_anotada_sem_passagem",
      };
    }

    const result = await triggerHandoff({
      serviceBoundary: boundary,
      conversationId,
      organizationId: row.organization_id,
      reason: "low_sentiment",
      origem: "sentimento",
      leadId,
      metadata: {
        sentiment_score: sentimentScore,
        [CHAVES_DO_CLIMA.motor]: sentimentEngine,
        message_id: messageId,
        source: "ai.sentiment_alert",
      },
    });

    if (!result.triggered) {
      logger.info("[ai-handoff-from-sentiment] handoff not triggered", {
        conversation_id: conversationId,
        reason: result.reason,
      });
      return {
        consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY,
        status: "skipped",
        detail: result.reason,
      };
    }

    return {
      consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY,
      status: "ok",
      detail: result.reason,
    };
  },
};
