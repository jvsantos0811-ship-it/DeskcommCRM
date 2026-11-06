/**
 * POST /api/v1/admin/bateria-do-leitor/casos — carrega os casos da bateria a partir
 * do arquivo do Gestor (PM-027 §9): o da Regra v2 (`bateria_48.json`) ou o dos
 * casos novos (`Casos_Novos_Gestor.json`). Os casos reais acham o lead na
 * organização de ORIGEM e copiam a conversa congelada; o arquivo fica fora do
 * repositório. Só o dono da plataforma, com escrita. Teto de 2 MB.
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
import { carregarCasos } from "@/lib/dados/leitor/carregar-casos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const TAMANHO_MAXIMO = 2 * 1024 * 1024;

const corpoSchema = z.strictObject({
  formato: z.enum(["regra_v2", "gestor"]),
  origem_organization_id: z.string().uuid().nullable(),
  arquivo: z.unknown(),
  substituir: z.boolean().default(false),
});

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

  const texto = await req.text();
  if (texto.length > TAMANHO_MAXIMO) return fail("payload_too_large", "File too large (2 MB max)", 413, { requestId });
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    return fail("validation_failed", "Invalid JSON", 400, { requestId });
  }
  const parsed = corpoSchema.safeParse(bruto);
  if (!parsed.success) return fail("validation_failed", "Invalid request body", 400, { requestId });

  try {
    const r = await carregarCasos(createAdminClient(), {
      formato: parsed.data.formato,
      origemOrganizationId: parsed.data.origem_organization_id,
      arquivo: parsed.data.arquivo,
      substituir: parsed.data.substituir,
    });
    await audit({
      action: "leitor.bateria_casos_carregados",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: parsed.data.origem_organization_id,
      resourceType: "leitor_bateria_casos",
      requestId,
      metadata: { formato: parsed.data.formato, criados: r.criados.length, ignorados: r.ignorados.length, substituir: parsed.data.substituir },
    });
    return ok(r, { requestId });
  } catch (err) {
    if (err instanceof z.ZodError) return fail("validation_failed", "O arquivo não está no formato esperado.", 422, { requestId });
    if (err instanceof Error && err.message === "origem_obrigatoria") {
      return fail("validation_failed", "Escolha a organização de onde vêm as conversas.", 422, { requestId });
    }
    return fail("internal_error", err instanceof Error ? err.message : "Load failed", 500, { requestId });
  }
}
