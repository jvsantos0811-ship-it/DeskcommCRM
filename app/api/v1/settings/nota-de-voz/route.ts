/**
 * GET   /api/v1/settings/nota-de-voz — a chave "nota de voz no formato do WhatsApp" (PC-043).
 * PATCH /api/v1/settings/nota-de-voz — grava (manager+).
 *
 * Mora em `organizations.settings.nota_de_voz` e nasce DESLIGADA (ausente =
 * desligada = a gravação do browser só troca de container). Ligada, a rota de
 * upload (`conversations/[id]/media`) reencoda a nota de voz no formato do
 * WhatsApp antes de guardar. Regra em `lib/messaging/media/voice-transcode.ts`.
 *
 * Mesma forma de `settings/assinatura`: merge NÃO destrutivo do jsonb, e a
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
  notaDeVozNoFormatoWhatsapp,
  notaDeVozSchema,
} from "@/lib/messaging/media/nota-de-voz-config";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function lerSettings(orgId: string) {
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (error) return { error };
  return {
    settings: ((data as { settings?: Record<string, unknown> | null } | null)?.settings ??
      {}) as Record<string, unknown>,
  };
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "voice_note_settings" });
  if (!authz.ok) return authz.response;

  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });
  return ok({ formato_whatsapp: notaDeVozNoFormatoWhatsapp(lido.settings) }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "voice_note_settings" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = notaDeVozSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const nova = parsed.data;

  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });

  // Cliente admin: a RLS de `organizations` só deixa platform admin escrever.
  const { error } = await createAdminClient()
    .from("organizations")
    .update({ settings: { ...lido.settings, nota_de_voz: nova } })
    .eq("id", authz.org.orgId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "settings.nota_de_voz_atualizada",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    // Liga/desliga é o que se cruza com a medição do tamanho dos áudios.
    metadata: { formato_whatsapp: nova.formato_whatsapp },
  });

  return ok(nova, { requestId });
}
