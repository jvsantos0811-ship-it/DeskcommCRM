/**
 * PATCH/DELETE /api/v1/team/cargos/:id — editar ou apagar um cargo (migration 9003).
 *
 * EDITAR PROPAGA: quem tem o cargo recebe o papel e as telas novos na hora — é
 * para isso que o cargo existe ("mudei o que o SDR vê" vale para todos os
 * SDRs). A propagação NUNCA toca administrador (`role <> 'admin'`): um membro
 * promovido a admin depois de receber o cargo não é rebaixado por uma edição
 * de cargo — e a troca de papel manual já solta o vínculo com o cargo.
 *
 * APAGAR NÃO TIRA ACESSO: o vínculo vira `null` (FK `on delete set null`) e
 * cada pessoa fica com o papel e as telas que tinha.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { cargoSchema, COLUNAS_DO_CARGO, motivoParaRecusarCargo, type Cargo } from "@/lib/team/cargos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;
  const orgId = authz.org.orgId;

  const parsed = cargoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Confira o nome, o papel e as telas do cargo."), 422, { requestId });
  const recusa = motivoParaRecusarCargo(parsed.data, t);
  if (recusa) return fail("validation_failed", recusa, 422, { requestId });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("team_cargos")
    .update({
      nome: parsed.data.nome,
      descricao: parsed.data.descricao ?? null,
      papel: parsed.data.papel,
      interface_settings: parsed.data.interface_settings,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", orgId)
    .select(COLUNAS_DO_CARGO)
    .maybeSingle();
  if (error?.code === "23505") {
    return fail("state_conflict", t("Já existe um cargo com esse nome."), 409, { requestId });
  }
  if (error) return fail("internal_error", t("Não foi possível salvar o cargo."), 500, { requestId });
  if (!data) return fail("not_found", t("Cargo não encontrado."), 404, { requestId });
  const cargo = data as Cargo;

  // Propaga a quem tem o cargo — pelo client de RLS de quem é admin, a mesma
  // escrita da troca de papel (`team/[user_id]/_shared.ts`).
  const supabase = await createClient();
  const { data: atualizados, error: erroPropagar } = await supabase
    .from("user_organizations")
    .update({ role: cargo.papel, interface_settings: cargo.interface_settings, updated_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("cargo_id", cargo.id)
    .neq("role", "admin")
    .is("revoked_at", null)
    .select("user_id");
  if (erroPropagar) {
    return fail("internal_error", t("O cargo foi salvo, mas não foi possível aplicá-lo aos membros. Tente salvar de novo."), 500, {
      requestId,
    });
  }

  void audit({
    action: "team.cargo_updated",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "team_cargo",
    resourceId: cargo.id,
    requestId,
    metadata: {
      nome: cargo.nome,
      papel: cargo.papel,
      interface_settings: cargo.interface_settings,
      membros_atualizados: (atualizados ?? []).length,
    },
  });
  return ok({ cargo, membros_atualizados: (atualizados ?? []).length }, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const { data, error } = await createAdminClient()
    .from("team_cargos")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select("id, nome")
    .maybeSingle();
  if (error) return fail("internal_error", t("Não foi possível apagar o cargo."), 500, { requestId });
  if (!data) return fail("not_found", t("Cargo não encontrado."), 404, { requestId });

  void audit({
    action: "team.cargo_deleted",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "team_cargo",
    resourceId: id,
    requestId,
    metadata: { nome: (data as { nome: string }).nome },
  });
  return ok({ id }, { requestId });
}
