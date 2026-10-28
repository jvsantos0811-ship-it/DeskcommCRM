/**
 * GET   /api/v1/settings/horario-da-equipe — o horário em que a equipe atende (PC-002b, item 4).
 * PATCH /api/v1/settings/horario-da-equipe — grava (manager+). Janelas vazias apagam.
 *
 * Mora em `organizations.settings.horario_da_equipe` (fuso + janelas por dia,
 * o mesmo formato da jornada de atendente). Com ele, a trava de promessa deixa
 * a IA dizer QUANDO a equipe assume ("ainda hoje", "a partir das 8h de
 * amanhã") quando isso bate com o horário — regra em
 * `lib/escalacao/horario-da-equipe.ts`. Merge NÃO destrutivo do jsonb, como
 * `settings/assinatura`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { horarioDaEquipeDaOrg, horarioDaEquipeEntradaSchema } from "@/lib/escalacao/horario-da-equipe";
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
  const authz = await requireRole("manager", { requestId, resource: "team_hours" });
  if (!authz.ok) return authz.response;
  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });
  return ok({ horario: horarioDaEquipeDaOrg(lido.settings) }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "team_hours" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = horarioDaEquipeEntradaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Horário inválido: confira o fuso e se cada início vem antes do fim."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });

  const { horario_da_equipe: _anterior, ...resto } = lido.settings;
  const novo = parsed.data.horario;
  const settings = novo.windows.length === 0 ? resto : { ...resto, horario_da_equipe: novo };
  const { error } = await createAdminClient()
    .from("organizations")
    .update({ settings })
    .eq("id", authz.org.orgId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "settings.team_hours_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { janelas: novo.windows.length, fuso: novo.timezone },
  });
  return ok({ horario: novo.windows.length === 0 ? null : novo }, { requestId });
}
