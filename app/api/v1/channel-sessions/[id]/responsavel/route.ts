/**
 * O RESPONSÁVEL DO NÚMERO (PC-029, migration 9026) — quem fica com a conversa
 * quando alguém da equipe responde pelo CELULAR deste número (coexistência) e o
 * eco não diz quem foi. Sem responsável, a conversa fica sem dono, marcada
 * "Equipe (celular)" — a IA cala do mesmo jeito.
 *
 * Mesma régua da tela de Conexões: admin (o suporte só lê).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { roleAtLeast } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

const corpoSchema = z.object({ responsavel_user_id: z.uuid().nullable() }).strict();

export async function GET(_req: NextRequest, { params }: Context): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: "leitura",
  });
  if (!auth.ok) return auth.response;
  const t = (texto: string) => traduzir(texto, auth.user.idioma);
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return fail("validation_failed", t("Canal inválido."), 422, { requestId });
  const { data, error } = await createAdminClient()
    .from("channel_sessions")
    .select("id, responsavel_user_id")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", t("Canal não encontrado."), 404, { requestId });
  return ok(
    { responsavel_user_id: (data as { responsavel_user_id: string | null }).responsavel_user_id },
    { requestId },
  );
}

export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!auth.ok) return auth.response;
  const t = (texto: string) => traduzir(texto, auth.user.idioma);
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return fail("validation_failed", t("Canal inválido."), 422, { requestId });
  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_failed", t("Escolha uma pessoa da equipe ou nenhuma."), 422, {
      requestId,
    });
  const orgId = auth.org.orgId;
  const db = createAdminClient();

  const novo = parsed.data.responsavel_user_id;
  if (novo) {
    // Atendente ativo DESTA organização — a mesma régua do "Assumir".
    const { data: membro } = await db
      .from("user_organizations")
      .select("role, revoked_at")
      .eq("organization_id", orgId)
      .eq("user_id", novo)
      .is("revoked_at", null)
      .maybeSingle();
    const papel = (membro as { role?: string } | null)?.role;
    if (!papel || !roleAtLeast(papel, "agent")) {
      return fail(
        "validation_failed",
        t("O responsável precisa ser um atendente ativo da equipe."),
        422,
        { requestId },
      );
    }
  }

  const { data: antes } = await db
    .from("channel_sessions")
    .select("responsavel_user_id")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!antes) return fail("not_found", t("Canal não encontrado."), 404, { requestId });

  const { error } = await db
    .from("channel_sessions")
    .update({ responsavel_user_id: novo })
    .eq("organization_id", orgId)
    .eq("id", id);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  await audit({
    action: "channel.responsavel_atualizado",
    actorUserId: auth.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: {
      antes: (antes as { responsavel_user_id: string | null }).responsavel_user_id,
      depois: novo,
    },
  });
  return ok({ responsavel_user_id: novo }, { requestId });
}
