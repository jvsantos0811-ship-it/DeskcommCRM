import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { gravarFunilDoNumero, retratoDoFunilDoNumero } from "@/lib/channels/funil-do-numero";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/**
 * O funil de UM número (Conexões › cada número › Funil, migration 9025): se a
 * conversa nova abre card e em qual funil/etapa. A regra mora em
 * `lib/channels/funil-do-numero.ts`, a mesma que a porta Admin usa.
 */
const ajusteSchema = z
  .object({
    abre_card: z.boolean(),
    funil_id: z.uuid().nullable(),
    etapa_id: z.uuid().nullable(),
  })
  .strict()
  .refine((v) => v.etapa_id === null || v.funil_id !== null, {
    message: "Etapa só com funil escolhido.",
    path: ["etapa_id"],
  });

/** Mesma régua da tela de Conexões: só administradores (e o suporte, para ler). */
export async function GET(_req: NextRequest, { params }: Context): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: "leitura" });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  try {
    const retrato = await retratoDoFunilDoNumero(createAdminClient(), auth.org.orgId, id);
    if (!retrato) return fail("not_found", "Canal não encontrado.", 404, { requestId });
    return ok(retrato, { requestId });
  } catch {
    return fail("internal_error", "Não foi possível carregar o funil deste número.", 500, { requestId });
  }
}

export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  const parsed = ajusteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Escolha se o número abre card e, se abrir, o funil.", 422, { requestId });

  const db = createAdminClient();
  const gravado = await gravarFunilDoNumero(db, auth.org.orgId, id, parsed.data);
  if (!gravado.ok) {
    if (gravado.codigo === "nao_encontrado") return fail("not_found", "Canal não encontrado.", 404, { requestId });
    if (gravado.codigo === "funil_invalido" || gravado.codigo === "etapa_invalida") {
      return fail("validation_failed", gravado.mensagem, 422, { requestId, details: { campo: gravado.codigo } });
    }
    return fail("internal_error", "Não foi possível salvar o funil deste número. Verifique se o banco está atualizado.", 500, { requestId });
  }

  void audit({
    action: "channel.entry_funnel_updated",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: { antes: gravado.antes, depois: gravado.depois },
  });

  const retrato = await retratoDoFunilDoNumero(db, auth.org.orgId, id).catch(() => null);
  return ok(retrato ?? gravado.depois, { requestId });
}
