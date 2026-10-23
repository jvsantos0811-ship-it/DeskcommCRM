/**
 * PUT /api/v1/team/:user_id/cargo — aplica um cargo a um membro, ou o solta
 * (`cargo_id: null`) (migration 9003).
 *
 * Aplicar grava no vínculo, de uma vez, o PAPEL e as TELAS do cargo, e o
 * `cargo_id` — que é o que faz as edições futuras do cargo chegarem a ele.
 * Soltar só apaga o vínculo: a pessoa fica com o que tinha.
 *
 * As travas da troca de papel valem aqui também: membro revogado não recebe
 * cargo, e o ÚLTIMO admin não pode virar cargo (cargo nunca é admin, então
 * aplicá-lo a um admin é rebaixá-lo).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { COLUNAS_DO_CARGO, type Cargo } from "@/lib/team/cargos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const schema = z.object({ cargo_id: z.string().uuid().nullable() }).strict();

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user_id } = await params;
  const orgId = authz.org.orgId;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!z.string().uuid().safeParse(user_id).success || !parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }

  const supabase = await createClient();
  const { data: membro, error: erroMembro } = await supabase
    .from("user_organizations")
    .select("id, role, revoked_at, cargo_id")
    .eq("organization_id", orgId)
    .eq("user_id", user_id)
    .maybeSingle();
  if (erroMembro) return fail("internal_error", t("Não foi possível ler o membro."), 500, { requestId });
  if (!membro) return fail("not_found", t("Membro não encontrado."), 404, { requestId });
  if (membro.revoked_at) return fail("state_conflict", t("Membro está revogado."), 409, { requestId });

  if (parsed.data.cargo_id === null) {
    const { error } = await supabase.from("user_organizations").update({ cargo_id: null }).eq("id", membro.id);
    if (error) return fail("internal_error", t("Não foi possível soltar o cargo."), 500, { requestId });
    void audit({
      action: "team.cargo_assigned",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "membership",
      resourceId: membro.id,
      requestId,
      metadata: { target_user_id: user_id, cargo_id: null, cargo_anterior: membro.cargo_id },
    });
    return ok({ user_id, cargo_id: null }, { requestId });
  }

  const { data: cargoData } = await supabase
    .from("team_cargos")
    .select(COLUNAS_DO_CARGO)
    .eq("id", parsed.data.cargo_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!cargoData) return fail("not_found", t("Cargo não encontrado."), 404, { requestId });
  const cargo = cargoData as Cargo;

  if (membro.role === "admin") {
    const { count, error: erroConta } = await supabase
      .from("user_organizations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("role", "admin")
      .is("revoked_at", null);
    if (erroConta) return fail("internal_error", t("Não foi possível conferir os administradores."), 500, { requestId });
    if ((count ?? 0) <= 1) {
      return fail("state_conflict", t("Não é possível rebaixar o último admin do tenant."), 409, { requestId });
    }
  }

  const { error } = await supabase
    .from("user_organizations")
    .update({
      role: cargo.papel,
      interface_settings: cargo.interface_settings,
      cargo_id: cargo.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", membro.id)
    .is("revoked_at", null);
  if (error) return fail("internal_error", t("Não foi possível aplicar o cargo."), 500, { requestId });

  void audit({
    action: "team.cargo_assigned",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "membership",
    resourceId: membro.id,
    requestId,
    metadata: {
      target_user_id: user_id,
      cargo_id: cargo.id,
      cargo_nome: cargo.nome,
      old_role: membro.role,
      new_role: cargo.papel,
    },
  });
  return ok({ user_id, cargo_id: cargo.id, role: cargo.papel }, { requestId });
}
