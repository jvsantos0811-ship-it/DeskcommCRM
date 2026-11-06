/**
 * GET   /api/v1/settings/alcance-do-leitor — quem conta como "lead com potencial".
 * PATCH /api/v1/settings/alcance-do-leitor — grava (manager+).
 *
 * Mora em `organizations.settings.leitor` (`funis` e
 * `marcadores_que_desqualificam`), e vale para o Leitor da conversa, o painel
 * "Esperando a equipe" e o aviso "Ninguém respondeu" (PM-025 §2). A regra:
 * `lib/dados/alcance-do-leitor.ts`. Os outros campos de `settings.leitor` (o
 * Leitor ganha os dele) são preservados: merge NÃO destrutivo.
 *
 * Funil escolhido tem de ser desta organização: um id de outra é recusado —
 * nunca do body sem conferir.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { alcanceDaOrg, alcanceDoLeitorSchema, CHAVE_DO_ALCANCE } from "@/lib/dados/alcance-do-leitor";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function lerSettings(orgId: string) {
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (error) return { error };
  return { settings: ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown> };
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "alcance_do_leitor" });
  if (!authz.ok) return authz.response;
  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });
  return ok({ alcance: alcanceDaOrg(lido.settings) }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "alcance_do_leitor" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = alcanceDoLeitorSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Pedido inválido."), 422, { requestId });
  }
  const novo = {
    funis: parsed.data.funis === null ? null : [...new Set(parsed.data.funis)],
    marcadores_que_desqualificam: [...new Set(parsed.data.marcadores_que_desqualificam.map((m) => m.trim()))],
  };

  const admin = createAdminClient();
  if (novo.funis !== null && novo.funis.length > 0) {
    const { data: funis, error: funisErr } = await admin
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .in("id", novo.funis);
    if (funisErr) return fail("internal_error", funisErr.message, 500, { requestId });
    if ((funis ?? []).length !== novo.funis.length) {
      return fail("validation_failed", t("Um dos funis escolhidos não existe nesta empresa."), 422, { requestId });
    }
  }

  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });
  const anterior = lido.settings[CHAVE_DO_ALCANCE];
  const outros = anterior && typeof anterior === "object" && !Array.isArray(anterior) ? (anterior as Record<string, unknown>) : {};
  const settings = { ...lido.settings, [CHAVE_DO_ALCANCE]: { ...outros, ...novo } };
  const { error } = await admin.from("organizations").update({ settings }).eq("id", authz.org.orgId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "settings.alcance_do_leitor_atualizado",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: {
      antes: alcanceDaOrg(lido.settings),
      depois: novo,
    },
  });
  return ok({ alcance: novo }, { requestId });
}
