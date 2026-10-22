/**
 * GET/POST /api/v1/team/cargos — os cargos da organização (migration 9003).
 *
 * Cargo = nome de função + papel concedido + telas visíveis. Criar é `admin`
 * (a mesma régua de trocar papel e interface de um membro, que é o que aplicar
 * um cargo faz). Ler é `manager`, como a lista da equipe.
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

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("team_cargos")
    .select(COLUNAS_DO_CARGO)
    .eq("organization_id", authz.org.orgId)
    .order("nome", { ascending: true });
  if (error) {
    return fail("internal_error", t("Não foi possível carregar os cargos. Verifique se o banco está atualizado."), 500, {
      requestId,
    });
  }
  return ok((data ?? []) as Cargo[], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = cargoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Confira o nome, o papel e as telas do cargo."), 422, { requestId });
  const recusa = motivoParaRecusarCargo(parsed.data, t);
  if (recusa) return fail("validation_failed", recusa, 422, { requestId });

  const { data, error } = await createAdminClient()
    .from("team_cargos")
    .insert({
      organization_id: authz.org.orgId,
      nome: parsed.data.nome,
      descricao: parsed.data.descricao ?? null,
      papel: parsed.data.papel,
      interface_settings: parsed.data.interface_settings,
    })
    .select(COLUNAS_DO_CARGO)
    .maybeSingle();
  if (error?.code === "23505") {
    return fail("state_conflict", t("Já existe um cargo com esse nome."), 409, { requestId });
  }
  if (error || !data) {
    return fail("internal_error", t("Não foi possível salvar o cargo. Verifique se o banco está atualizado."), 500, {
      requestId,
    });
  }
  const cargo = data as Cargo;
  void audit({
    action: "team.cargo_created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "team_cargo",
    resourceId: cargo.id,
    requestId,
    metadata: { nome: cargo.nome, papel: cargo.papel, interface_settings: cargo.interface_settings },
  });
  return ok(cargo, { requestId, status: 201 });
}
