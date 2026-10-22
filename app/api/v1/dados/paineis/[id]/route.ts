/**
 * PATCH/DELETE /api/v1/dados/paineis/:id — editar ou apagar um painel
 * (migration 9004). Gestor ou acima. Apagar um painel não apaga dado nenhum:
 * ele só guarda a escolha do que mostrar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DO_PAINEL, painelSchema, type Painel } from "@/lib/dados/widgets";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "dados" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const parsed = painelSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Confira o nome e os gráficos do painel."), 422, { requestId });

  const { data, error } = await createAdminClient()
    .from("data_dashboards")
    .update({
      nome: parsed.data.nome,
      descricao: parsed.data.descricao ?? null,
      widgets: parsed.data.widgets,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS_DO_PAINEL)
    .maybeSingle();
  if (error) return fail("internal_error", t("Não foi possível salvar o painel."), 500, { requestId });
  if (!data) return fail("not_found", t("Painel não encontrado."), 404, { requestId });
  const painel = data as Painel;
  void audit({
    action: "dados.painel_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "data_dashboard",
    resourceId: painel.id,
    requestId,
    metadata: { nome: painel.nome, widgets: painel.widgets.length },
  });
  return ok(painel, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "dados" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const { data, error } = await createAdminClient()
    .from("data_dashboards")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select("id, nome")
    .maybeSingle();
  if (error) return fail("internal_error", t("Não foi possível apagar o painel."), 500, { requestId });
  if (!data) return fail("not_found", t("Painel não encontrado."), 404, { requestId });
  void audit({
    action: "dados.painel_deleted",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "data_dashboard",
    resourceId: id,
    requestId,
    metadata: { nome: (data as { nome: string }).nome },
  });
  return ok({ id }, { requestId });
}
