/**
 * GET   /api/v1/settings/frase-segura — a frase segura da organização (PC-002b).
 * PATCH /api/v1/settings/frase-segura — grava (manager+).
 *
 * A frase que o cliente recebe quando uma trava barra a mensagem inteira da IA
 * e o turno terminaria em silêncio (regra em `lib/messaging/frase-segura.ts`).
 * Mora em `organizations.settings.frase_segura`; vazio = a padrão do idioma.
 * Mesma forma de `settings/assinatura`: merge NÃO destrutivo do jsonb, e
 * leitura que falhou PARA a gravação (tratá-la como `{}` regravaria o settings
 * inteiro só com esta chave).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  fraseSeguraConfigurada,
  fraseSeguraEntradaSchema,
  fraseSeguraPadrao,
} from "@/lib/messaging/frase-segura";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function lerOrg(orgId: string) {
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings, locale")
    .eq("id", orgId)
    .maybeSingle();
  if (error) return { error };
  const linha = data as { settings?: Record<string, unknown> | null; locale?: string | null } | null;
  return {
    settings: (linha?.settings ?? {}) as Record<string, unknown>,
    locale: linha?.locale ?? null,
  };
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "safe_phrase" });
  if (!authz.ok) return authz.response;

  const lido = await lerOrg(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });
  return ok(
    { frase: fraseSeguraConfigurada(lido.settings) ?? "", padrao: fraseSeguraPadrao(lido.locale) },
    { requestId },
  );
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "safe_phrase" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = fraseSeguraEntradaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const nova = parsed.data.frase;

  const lido = await lerOrg(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });

  // Vazio apaga a chave: volta a valer a frase padrão do idioma.
  const { frase_segura: _anterior, ...resto } = lido.settings;
  const settings = nova === "" ? resto : { ...resto, frase_segura: nova };

  // Cliente admin: a RLS de `organizations` só deixa platform admin escrever.
  const { error } = await createAdminClient()
    .from("organizations")
    .update({ settings })
    .eq("id", authz.org.orgId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "settings.safe_phrase_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { personalizada: nova !== "" },
  });

  return ok({ frase: nova, padrao: fraseSeguraPadrao(lido.locale) }, { requestId });
}
