/**
 * POST /api/v1/admin/bateria-do-leitor/rodadas — "Testar na bateria" (PM-027 §8):
 * pede uma rodada de um modelo contra a bateria ativa, com o juiz (nunca o mesmo
 * modelo; §9.1) e a organização cuja chave paga as chamadas. A rodada roda no
 * cron `bateria-do-leitor`, caso a caso. Só o dono da plataforma, com escrita.
 */
import { requireSupportWrite } from "@/lib/impersonate/support";

import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { pedirRodada, PedidoDeRodadaRecusado } from "@/lib/dados/leitor/bateria-admin";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const modelo = z.object({ provider: z.string().trim().min(1).max(40), model_id: z.string().trim().min(1).max(120) });
const corpoSchema = z.strictObject({
  testado: modelo,
  juiz: modelo.nullable().optional(),
  credencial_organization_id: z.string().uuid(),
});

const MENSAGEM: Record<PedidoDeRodadaRecusado["codigo"], string> = {
  juiz_igual_ao_testado: "O juiz não pode ser o modelo que está sendo testado.",
  sem_casos: "A bateria ainda não tem casos. Carregue os casos antes de testar.",
  ja_rodando: "Este modelo já tem uma rodada em andamento.",
};

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Invalid request body", 400, { requestId });

  const admin = createAdminClient();
  const { data: org } = await admin.from("organizations").select("id").eq("id", parsed.data.credencial_organization_id).maybeSingle();
  if (!org) return fail("not_found", "Organization not found", 404, { requestId });

  try {
    const rodada = await pedirRodada(admin, {
      testado: parsed.data.testado,
      juiz: parsed.data.juiz ?? null,
      credencialOrganizationId: parsed.data.credencial_organization_id,
      pedidaPor: adminCtx.user.id,
    });
    await audit({
      action: "leitor.bateria_pedida",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: parsed.data.credencial_organization_id,
      resourceType: "leitor_bateria_rodadas",
      resourceId: rodada.id,
      requestId,
      metadata: {
        modelo: `${rodada.provider}/${rodada.model_id}`,
        juiz: `${rodada.juiz_provider}/${rodada.juiz_model_id}`,
        casos: rodada.casos_total,
      },
    });
    return ok({ rodada }, { status: 201, requestId });
  } catch (err) {
    if (err instanceof PedidoDeRodadaRecusado) {
      return fail(err.codigo === "ja_rodando" ? "state_conflict" : "validation_failed", MENSAGEM[err.codigo], err.codigo === "ja_rodando" ? 409 : 422, {
        requestId,
        details: { codigo: err.codigo },
      });
    }
    return fail("internal_error", err instanceof Error ? err.message : "Insert failed", 500, { requestId });
  }
}
