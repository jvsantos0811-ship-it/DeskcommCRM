import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/admin/chaves-da-agencia/[id]/revogar — desliga a chave na hora.
 * Idempotente: revogar a revogada devolve a mesma linha, sem nova auditoria.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { revogarChaveDaAgencia } from "@/lib/mcp/agencia/chaves";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return fail("not_found", "Key not found", 404, { requestId });

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const admin = createAdminClient();
  try {
    const revogacao = await revogarChaveDaAgencia(admin, id, adminCtx.user.id);
    if (!revogacao) return fail("not_found", "Key not found", 404, { requestId });
    const { chave } = revogacao;
    if (!revogacao.jaEstavaRevogada) {
      await audit({
        action: "agencia.chave_revogada",
        actorUserId: adminCtx.user.id,
        actingAsPlatformAdmin: true,
        bypassedRls: true,
        organizationId: chave.organization_id,
        resourceType: "api_token",
        resourceId: chave.id,
        requestId,
        metadata: { porta: chave.porta, prefix: chave.prefix },
      });
    }
    return ok({ chave }, { requestId });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "Update failed", 500, { requestId });
  }
}
