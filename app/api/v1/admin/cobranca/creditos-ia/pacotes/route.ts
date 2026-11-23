/**
 * POST /api/v1/admin/cobranca/creditos-ia/pacotes — o dono da instalação cria um
 * pacote de crédito de IA (PC-051). Pacote é da INSTALAÇÃO (sem
 * `organization_id`): preço em centavos de real e quanto de IA libera em
 * centavos de dólar. Escrita de platform admin (scope full + MFA); 404 com a
 * chave `cobranca` desligada. Sem pacote ativo, ninguém vê a compra.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { COLUNAS_DO_PACOTE } from "@/lib/cobranca/credito-ia";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { novoPacoteDeCreditoSchema } from "@/lib/schemas/cobranca-plano";
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

  const corpo = novoPacoteDeCreditoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", "Pacote inválido", 400, { requestId, details: corpo.error.flatten() });
  }

  const { data: pacote, error } = await admin
    .from("cobranca_pacotes_credito_ia")
    .insert(corpo.data)
    .select(COLUNAS_DO_PACOTE)
    .single();
  if (error || !pacote) return fail("internal_error", "Não foi possível salvar o pacote", 500, { requestId });

  void audit({
    action: "cobranca.credito_ia_pacote_salvo",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    resourceType: "cobranca_pacote_credito_ia",
    resourceId: (pacote as { id: string }).id,
    requestId,
    metadata: { criado: true, ...corpo.data },
  });
  return ok(pacote, { status: 201, requestId });
}
