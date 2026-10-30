import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * Chaves da agência (migration 9014) — só o dono da instalação.
 *
 * GET  /api/v1/admin/chaves-da-agencia — as chaves (vivas e revogadas) e as
 *      organizações onde uma chave pode ficar guardada.
 * POST /api/v1/admin/chaves-da-agencia — cria a chave de uma porta. O texto da
 *      chave volta UMA vez; depois só o prefixo.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { ChaveDaAgenciaErro, criarChaveDaAgencia, listarChavesDaAgencia } from "@/lib/mcp/agencia/chaves";
import { normalizarListaDeIps } from "@/lib/mcp/agencia/ip-permitido";
import { IPS_DE_SAIDA_DA_ANTHROPIC, PORTAS_DA_AGENCIA } from "@/lib/mcp/agencia/portas";
import { createAdminClient } from "@/lib/supabase/admin";

const corpoSchema = z.object({
  porta: z.enum(["leitura", "admin"]),
  organization_id: z.string().uuid(),
  ips: z.array(z.string().max(64)).max(20).optional(),
});

export async function GET(_req: NextRequest) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const admin = createAdminClient();
  try {
    const [chaves, orgs] = await Promise.all([
      listarChavesDaAgencia(admin),
      admin
        .from("organizations")
        .select("id, display_name")
        .in("status", ["active", "suspended"])
        .order("display_name", { ascending: true }),
    ]);
    if (orgs.error) throw new Error(orgs.error.message);
    return ok(
      {
        chaves,
        organizacoes: (orgs.data ?? []).map((o) => ({ id: o.id as string, nome: o.display_name as string })),
        portas: Object.values(PORTAS_DA_AGENCIA).map((p) => ({ porta: p.porta, nome: p.nome, caminho: p.caminho })),
        ips_padrao: IPS_DE_SAIDA_DA_ANTHROPIC,
      },
      { requestId },
    );
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "Query failed", 500, { requestId });
  }
}

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

  let corpo: z.infer<typeof corpoSchema>;
  try {
    corpo = corpoSchema.parse(await req.json());
  } catch {
    return fail("validation_failed", "Invalid request body", 400, { requestId });
  }

  const ips = normalizarListaDeIps(corpo.ips ?? IPS_DE_SAIDA_DA_ANTHROPIC);
  if ("invalido" in ips) {
    return fail("validation_failed", `Invalid IP or range: ${ips.invalido || "(empty list)"}`, 400, { requestId });
  }

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("id")
    .eq("id", corpo.organization_id)
    .in("status", ["active", "suspended"])
    .maybeSingle();
  if (!org) return fail("not_found", "Organization not found", 404, { requestId });

  try {
    const nova = await criarChaveDaAgencia(admin, {
      porta: corpo.porta,
      organizationId: corpo.organization_id,
      criadaPor: adminCtx.user.id,
      ips: ips.ok,
    });
    await audit({
      action: "agencia.chave_criada",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: corpo.organization_id,
      resourceType: "api_token",
      resourceId: nova.chave.id,
      requestId,
      metadata: { porta: corpo.porta, prefix: nova.chave.prefix, ips_permitidos: nova.chave.ips_permitidos },
    });
    return ok({ chave: nova.chave, texto: nova.texto }, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ChaveDaAgenciaErro && err.codigo === "ja_existe") {
      return fail("state_conflict", err.message, 409, { requestId });
    }
    return fail("internal_error", err instanceof Error ? err.message : "Insert failed", 500, { requestId });
  }
}
