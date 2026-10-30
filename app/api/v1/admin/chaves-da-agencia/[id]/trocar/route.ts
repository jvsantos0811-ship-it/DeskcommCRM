import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/admin/chaves-da-agencia/[id]/trocar — troca a chave em um clique:
 * revoga a atual e cria outra da mesma porta, na mesma organização e com os
 * mesmos IPs. O texto da nova volta UMA vez. Só troca chave viva (a revogada se
 * substitui criando outra).
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
import { criarChaveDaAgencia, lerChaveDaAgencia, revogarChaveDaAgencia } from "@/lib/mcp/agencia/chaves";
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
    const atual = await lerChaveDaAgencia(admin, id);
    if (!atual) return fail("not_found", "Key not found", 404, { requestId });
    if (atual.revoked_at) return fail("state_conflict", "Key already revoked; create a new one", 409, { requestId });

    await revogarChaveDaAgencia(admin, atual.id, adminCtx.user.id);
    const nova = await criarChaveDaAgencia(admin, {
      porta: atual.porta,
      organizationId: atual.organization_id,
      criadaPor: adminCtx.user.id,
      ips: atual.ips_permitidos,
    });
    await audit({
      action: "agencia.chave_trocada",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: atual.organization_id,
      resourceType: "api_token",
      resourceId: nova.chave.id,
      requestId,
      metadata: { porta: atual.porta, prefix_antigo: atual.prefix, prefix_novo: nova.chave.prefix },
    });
    return ok({ chave: nova.chave, texto: nova.texto }, { status: 201, requestId });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "Rotation failed", 500, { requestId });
  }
}
