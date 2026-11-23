/**
 * PATCH /api/v1/admin/cobranca/creditos-ia/pacotes/[id] — editar, arquivar e
 * desarquivar um pacote de crédito de IA (PC-051). Arquivado sai da oferta; a
 * compra já feita segue com o preço e o crédito que tinha (a linha em
 * `ia_creditos` guarda os dois). Platform admin, scope full + MFA.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

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
import { edicaoDoPacoteDeCreditoSchema } from "@/lib/schemas/cobranca-plano";
import { createAdminClient } from "@/lib/supabase/admin";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const { id } = await params;
  if (!(await moduloLigado(admin, "cobranca")) || !z.string().uuid().safeParse(id).success) {
    return fail("not_found", "Pacote não encontrado", 404, { requestId });
  }

  const corpo = edicaoDoPacoteDeCreditoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", "Edição de pacote inválida", 400, { requestId, details: corpo.error.flatten() });
  }

  const { data: lido, error: erroDeLeitura } = await admin
    .from("cobranca_pacotes_credito_ia")
    .select("id, arquivado_em")
    .eq("id", id)
    .maybeSingle();
  if (erroDeLeitura) return fail("internal_error", "Não foi possível ler o pacote", 500, { requestId });
  const atual = lido as { id: string; arquivado_em: string | null } | null;
  if (!atual) return fail("not_found", "Pacote não encontrado", 404, { requestId });

  const { arquivado, ...campos } = corpo.data;
  const agora = new Date().toISOString();
  const arquivadoEm =
    arquivado === undefined ? {} : { arquivado_em: arquivado ? (atual.arquivado_em ?? agora) : null };
  const { data: pacote, error } = await admin
    .from("cobranca_pacotes_credito_ia")
    .update({ ...campos, ...arquivadoEm })
    .eq("id", id)
    .select(COLUNAS_DO_PACOTE)
    .single();
  if (error || !pacote) return fail("internal_error", "Não foi possível salvar o pacote", 500, { requestId });

  const arquivou = arquivado === true && atual.arquivado_em === null;
  void audit({
    action: arquivou ? "cobranca.credito_ia_pacote_arquivado" : "cobranca.credito_ia_pacote_salvo",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    resourceType: "cobranca_pacote_credito_ia",
    resourceId: id,
    requestId,
    metadata: { ...corpo.data },
  });
  return ok(pacote, { requestId });
}
