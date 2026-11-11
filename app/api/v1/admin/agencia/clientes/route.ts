/**
 * PUT /api/v1/admin/agencia/clientes — o cadastro manual de uma organização
 * cliente no painel da agência (PC-028): plano, implantação (e se foi paga),
 * mensalidade, início, próximo vencimento, fim do teste, cancelamento.
 *
 * Só o dono da instalação com escrita. Não muda plano da cobrança do produto,
 * não suspende ninguém: é o registro da agência. Auditoria `agencia.cliente_salvo`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { limparCacheDaAgencia } from "@/lib/agencia/ler";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const dia = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional();
const corpoSchema = z.object({
  organization_id: z.string().uuid(),
  plano: z.string().trim().min(1).max(60).nullable().optional(),
  implantacao_cents: z.number().int().min(0).max(1e10).optional(),
  implantacao_paga: z.boolean().optional(),
  mensalidade_cents: z.number().int().min(0).max(1e10).optional(),
  inicio: dia,
  proximo_vencimento: dia,
  teste_ate: dia,
  cancelada_em: dia,
  observacao: z.string().trim().max(1000).nullable().optional(),
});

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdminEscrita>>;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success)
    return fail("validation_failed", "Cadastro inválido", 400, {
      requestId,
      details: corpo.error.flatten(),
    });
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agencia_clientes")
    .upsert({ ...corpo.data, updated_by: adminCtx.user.id }, { onConflict: "organization_id" })
    .select("*")
    .single();
  if (error || !data)
    return fail("internal_error", "Não foi possível salvar o cadastro", 500, { requestId });
  limparCacheDaAgencia();
  void audit({
    action: "agencia.cliente_salvo",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: corpo.data.organization_id,
    resourceType: "agencia_cliente",
    resourceId: corpo.data.organization_id,
    requestId,
    metadata: corpo.data,
  });
  return ok(data, { requestId });
}
