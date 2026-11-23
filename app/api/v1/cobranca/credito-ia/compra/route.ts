/**
 * POST /api/v1/cobranca/credito-ia/compra — o botão "Comprar" do crédito de IA
 * (PC-051), em Configurações › Plano e cobrança. Só admin da empresa compra; a
 * organização vem da sessão. Cria a compra pendente e devolve o link do
 * provedor da assinatura (Pix, cartão ou boleto). O crédito só entra quando o
 * pagamento é relido no provedor (`lib/cobranca/credito-ia.ts`).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { iniciarCompraDeCredito } from "@/lib/cobranca/credito-ia";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z.strictObject({ pacote_id: z.string().uuid() });

export async function POST(req: NextRequest) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ia_creditos", permiteOrgSuspensa: true });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca"))) return fail("not_found", "Not found", 404, { requestId });

  const corpo = corpoSchema.safeParse(await req.json().catch(() => ({})));
  if (!corpo.success) return fail("validation_failed", "Pedido inválido.", 400, { requestId, details: corpo.error.flatten() });

  try {
    const r = await iniciarCompraDeCredito(admin, {
      orgId: authz.org.orgId,
      pacoteId: corpo.data.pacote_id,
      actorUserId: authz.user.id,
      requestId,
    });
    if (r.ok) return ok({ url: r.url, id: r.creditoId }, { requestId });
    return fail(r.code, r.message, r.status, { requestId });
  } catch (e) {
    logger.error("cobranca: compra de crédito de IA falhou", {
      requestId,
      organizationId: authz.org.orgId,
      motivo: e instanceof Error ? e.message : "desconhecido",
    });
    return fail("internal_error", "Não foi possível iniciar a compra.", 500, { requestId });
  }
}
