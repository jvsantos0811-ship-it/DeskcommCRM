/**
 * GET  /api/v1/settings/assinatura-webhook — a porta do aviso de assinatura
 *      desta organização está configurada? (admin)
 * POST /api/v1/settings/assinatura-webhook — cria (ou troca) o endereço e o
 *      segredo. O segredo aparece UMA vez, nesta resposta; o banco guarda só o
 *      hash SHA-256 (PC-003, item 3 (a)).
 *
 * Sem tela por ora: o pedido manda deixar o provedor de assinatura desligado
 * ("só o endpoint e a validação"). Quando um provedor for escolhido, esta rota
 * gera o endereço que vai no painel dele.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashDoSegredo } from "@/lib/leads/assinatura-webhook";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "signature_webhook" });
  if (!authz.ok) return authz.response;
  const { data } = await createAdminClient()
    .from("assinatura_webhook_chaves")
    .select("path_token, ativo, created_at")
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const c = data as { path_token: string; ativo: boolean; created_at: string } | null;
  return ok(
    c
      ? { configurado: true, ativo: c.ativo, caminho: `/api/v1/webhooks/assinatura/${c.path_token}`, criado_em: c.created_at }
      : { configurado: false },
    { requestId },
  );
}

export async function POST(): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "signature_webhook" });
  if (!authz.ok) return authz.response;

  const token = randomBytes(24).toString("base64url");
  const segredo = randomBytes(32).toString("base64url");
  const { error } = await createAdminClient()
    .from("assinatura_webhook_chaves")
    .upsert(
      {
        organization_id: authz.org.orgId,
        path_token: token,
        segredo_sha256: hashDoSegredo(segredo),
        ativo: true,
        created_by: authz.user.id,
        created_at: new Date().toISOString(),
      },
      { onConflict: "organization_id" },
    );
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "settings.signature_webhook_key_created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: {},
  });
  return ok(
    { caminho: `/api/v1/webhooks/assinatura/${token}`, segredo, cabecalho: "x-assinatura-segredo" },
    { requestId },
  );
}
