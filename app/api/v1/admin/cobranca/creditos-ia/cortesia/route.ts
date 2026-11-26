/**
 * POST /api/v1/admin/cobranca/creditos-ia/cortesia — o dono da instalação dá
 * crédito de IA de cortesia a uma empresa, com motivo (PC-051). Nasce pago e
 * vence no fim do mês seguinte, como a compra. Platform admin, scope full + MFA;
 * a empresa vem do corpo (é o dono quem escolhe) e é conferida no banco.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { darCortesiaDeCredito } from "@/lib/cobranca/credito-ia";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { cortesiaDeCreditoSchema } from "@/lib/schemas/cobranca-plano";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();

  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca"))) return fail("not_found", "Not found", 404, { requestId });

  const corpo = cortesiaDeCreditoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", "Cortesia inválida", 400, { requestId, details: corpo.error.flatten() });
  }

  const r = await darCortesiaDeCredito(admin, {
    orgId: corpo.data.organization_id,
    iaUsdCents: corpo.data.ia_usd_cents,
    motivo: corpo.data.motivo,
    actorUserId: adminCtx.user.id,
    requestId,
  });
  if (!r.ok) return fail(r.code, r.message, r.status, { requestId });
  return ok({ id: r.creditoId }, { status: 201, requestId });
}
