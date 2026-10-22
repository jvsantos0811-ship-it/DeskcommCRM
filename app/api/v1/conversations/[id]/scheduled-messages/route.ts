/**
 * GET/POST /api/v1/conversations/:id/scheduled-messages — mensagens agendadas
 * de UMA conversa (migration 9001).
 *
 * - GET devolve as agendadas, enviadas, com falha e canceladas, da mais próxima
 *   para a mais distante — a tela mostra as pendentes em cima do campo de texto.
 * - POST agenda um texto. Nada sai agora: o cron `scheduled-messages` envia na
 *   hora marcada, pela mesma porta de saída de toda mensagem.
 *
 * A conversa é conferida pelo client de RLS do USUÁRIO (o mesmo de
 * `notes/route.ts`): atendente com escopo `own*` não agenda em conversa que não
 * enxerga. A escrita vai pelo admin com `organization_id` vindo da sessão,
 * nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  COLUNAS_DO_AGENDAMENTO,
  motivoParaRecusarAgendamento,
  type MensagemAgendada,
} from "@/lib/inbox/mensagens-agendadas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const criarSchema = z
  .object({
    body: z.string(),
    send_at: z.string().min(1),
  })
  .strict();

async function conversaVisivel(id: string, orgId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  return !!data;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  if (!(await conversaVisivel(id, authz.org.orgId))) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("scheduled_messages")
    .select(COLUNAS_DO_AGENDAMENTO)
    .eq("organization_id", authz.org.orgId)
    .eq("conversation_id", id)
    .order("send_at", { ascending: true })
    .limit(100);
  if (error) {
    return fail(
      "internal_error",
      t("Não foi possível carregar as mensagens agendadas. Verifique se o banco está atualizado."),
      500,
      { requestId },
    );
  }
  return ok((data ?? []) as MensagemAgendada[], { requestId });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const parsed = criarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Informe o texto e a data e hora do envio."), 422, {
      requestId,
    });
  }
  const quando = new Date(parsed.data.send_at);
  const recusa = motivoParaRecusarAgendamento(parsed.data.body, quando, new Date(), t);
  if (recusa) return fail("validation_failed", recusa, 422, { requestId });

  if (!(await conversaVisivel(id, authz.org.orgId))) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }

  const db = createAdminClient();
  const { data, error } = await db
    .from("scheduled_messages")
    .insert({
      organization_id: authz.org.orgId,
      conversation_id: id,
      body: parsed.data.body.trim(),
      send_at: quando.toISOString(),
      status: "scheduled",
      created_by_user_id: authz.user.id,
    })
    .select(COLUNAS_DO_AGENDAMENTO)
    .maybeSingle();
  if (error || !data) {
    return fail(
      "internal_error",
      t("Não foi possível agendar a mensagem. Verifique se o banco está atualizado."),
      500,
      { requestId },
    );
  }
  const agendada = data as MensagemAgendada;

  void audit({
    action: "message.schedule_created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "scheduled_message",
    resourceId: agendada.id,
    requestId,
    metadata: { conversation_id: id, send_at: agendada.send_at },
  });

  return ok(agendada, { requestId, status: 201 });
}
