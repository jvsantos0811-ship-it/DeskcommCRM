/**
 * GET/POST /api/v1/dados/paineis — os painéis de dados da organização
 * (migration 9004). Ver é de todos (`viewer`); montar é de gestor (`manager`),
 * a mesma régua de quem mexe na operação. Os widgets são validados pelo
 * catálogo fechado de `lib/dados/widgets.ts`.
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
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "dados" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("data_dashboards")
    .select(COLUNAS_DO_PAINEL)
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: true });
  if (error) {
    return fail("internal_error", t("Não foi possível carregar os painéis. Verifique se o banco está atualizado."), 500, {
      requestId,
    });
  }
  return ok((data ?? []) as Painel[], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "dados" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = painelSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Confira o nome e os gráficos do painel."), 422, { requestId });

  const { data, error } = await createAdminClient()
    .from("data_dashboards")
    .insert({
      organization_id: authz.org.orgId,
      nome: parsed.data.nome,
      descricao: parsed.data.descricao ?? null,
      widgets: parsed.data.widgets,
      created_by_user_id: authz.user.id,
    })
    .select(COLUNAS_DO_PAINEL)
    .maybeSingle();
  if (error || !data) {
    return fail("internal_error", t("Não foi possível salvar o painel. Verifique se o banco está atualizado."), 500, {
      requestId,
    });
  }
  const painel = data as Painel;
  void audit({
    action: "dados.painel_created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "data_dashboard",
    resourceId: painel.id,
    requestId,
    metadata: { nome: painel.nome, widgets: painel.widgets.length },
  });
  return ok(painel, { requestId, status: 201 });
}
