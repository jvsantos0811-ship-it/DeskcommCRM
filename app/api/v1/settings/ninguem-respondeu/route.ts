/**
 * GET   /api/v1/settings/ninguem-respondeu — o aviso "Um lead escreveu e ninguém respondeu" está ligado?
 * PATCH /api/v1/settings/ninguem-respondeu — liga ou desliga (manager+).
 *
 * Mora em `organizations.settings.ninguem_respondeu` ({ ligado, ligado_em }).
 * SEM RETROATIVO (PM-025 §7): só mensagem do lead que chega depois de ligado
 * conta; religar depois de desligar volta a contar dali. A regra da data está
 * em `proximaConfig` (`lib/escalacao/ninguem-respondeu.ts`). Merge NÃO
 * destrutivo do jsonb, como `settings/horario-da-equipe`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { CHAVE_DO_AVISO, configDoAviso, proximaConfig } from "@/lib/escalacao/ninguem-respondeu";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const entradaSchema = z.strictObject({ ligado: z.boolean() });

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
  const authz = await requireRole("viewer", { requestId, resource: "ninguem_respondeu" });
  if (!authz.ok) return authz.response;
  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });
  return ok({ aviso: configDoAviso(lido.settings) }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ninguem_respondeu" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = entradaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Pedido inválido."), 422, { requestId });
  }
  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });

  const atual = configDoAviso(lido.settings);
  const novo = proximaConfig(atual, parsed.data.ligado, new Date());
  const settings = { ...lido.settings, [CHAVE_DO_AVISO]: novo };
  const { error } = await createAdminClient()
    .from("organizations")
    .update({ settings })
    .eq("id", authz.org.orgId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  if (atual.ligado !== novo.ligado) {
    void audit({
      action: "settings.ninguem_respondeu_atualizado",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "organization",
      resourceId: authz.org.orgId,
      requestId,
      metadata: { antes: atual.ligado, depois: novo.ligado, ligado_em: novo.ligado_em },
    });
  }
  return ok({ aviso: novo }, { requestId });
}
