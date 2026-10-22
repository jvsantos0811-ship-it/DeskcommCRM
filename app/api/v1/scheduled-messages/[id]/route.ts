/**
 * DELETE /api/v1/scheduled-messages/:id — cancela uma mensagem agendada
 * (migration 9001).
 *
 * Só o que ainda está `scheduled` cancela: o UPDATE leva o filtro de estado,
 * então cancelar no exato segundo em que o cron pegou a linha devolve 409 em
 * vez de fingir que segurou uma mensagem que já está saindo.
 *
 * A conversa é conferida pelo client de RLS do usuário — o mesmo escopo da
 * criação: quem não enxerga a conversa não cancela o que há nela.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { COLUNAS_DO_AGENDAMENTO, type MensagemAgendada } from "@/lib/inbox/mensagens-agendadas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const supabase = await createClient();
  const { data: linha } = await supabase
    .from("scheduled_messages")
    .select("id, conversation_id, status")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!linha) return fail("not_found", t("Mensagem agendada não encontrada."), 404, { requestId });
  const { data: conversa } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", (linha as { conversation_id: string }).conversation_id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!conversa) return fail("not_found", t("Mensagem agendada não encontrada."), 404, { requestId });

  const db = createAdminClient();
  const agora = new Date().toISOString();
  const { data, error } = await db
    .from("scheduled_messages")
    .update({
      status: "cancelled",
      cancelled_at: agora,
      cancelled_by_user_id: authz.user.id,
      updated_at: agora,
    })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .eq("status", "scheduled")
    .select(COLUNAS_DO_AGENDAMENTO)
    .maybeSingle();
  if (error) {
    return fail("internal_error", t("Não foi possível cancelar a mensagem agendada."), 500, { requestId });
  }
  if (!data) {
    return fail(
      "state_conflict",
      t("Esta mensagem já saiu, falhou ou foi cancelada — não há mais o que cancelar."),
      409,
      { requestId },
    );
  }

  void audit({
    action: "message.schedule_cancelled",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "scheduled_message",
    resourceId: id,
    requestId,
    metadata: { conversation_id: (linha as { conversation_id: string }).conversation_id },
  });

  return ok(data as MensagemAgendada, { requestId });
}
