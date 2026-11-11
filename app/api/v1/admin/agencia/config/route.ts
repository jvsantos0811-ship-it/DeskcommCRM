/**
 * PUT /api/v1/admin/agencia/config — a cotação do dólar, a tabela de preço do
 * WhatsApp (centavos de real por mensagem de modelo, por categoria) e o limiar
 * do alerta de custo sobre a mensalidade (PC-028). Auditoria `agencia.config_salva`.
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

const preco = z.number().int().min(0).max(100_000);
const corpoSchema = z.object({
  cotacao_usd_brl: z.number().positive().max(1000),
  precos_whatsapp: z.object({ marketing: preco, utilidade: preco, autenticacao: preco }),
  alerta_custo_pct: z.number().positive().max(100),
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
    return fail("validation_failed", "Configuração inválida", 400, {
      requestId,
      details: corpo.error.flatten(),
    });
  const { data, error } = await createAdminClient()
    .from("agencia_config")
    .upsert({ id: true, ...corpo.data, updated_by: adminCtx.user.id }, { onConflict: "id" })
    .select("cotacao_usd_brl, precos_whatsapp, alerta_custo_pct")
    .single();
  if (error || !data)
    return fail("internal_error", "Não foi possível salvar a configuração", 500, { requestId });
  limparCacheDaAgencia();
  void audit({
    action: "agencia.config_salva",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    resourceType: "agencia_config",
    requestId,
    metadata: corpo.data,
  });
  return ok(data, { requestId });
}
