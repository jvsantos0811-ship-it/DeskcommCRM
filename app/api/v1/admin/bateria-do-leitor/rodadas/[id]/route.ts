/**
 * GET /api/v1/admin/bateria-do-leitor/rodadas/:id — caso a caso de uma rodada da
 * bateria do Leitor, com a decisão do juiz (para a conferência do Gestor, PM-027
 * §9.1: 5 de cada 20 decisões, às cegas). Só o dono da plataforma.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { resultadosDaRodada } from "@/lib/dados/leitor/bateria-admin";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }
  const id = z.string().uuid().safeParse((await ctx.params).id);
  if (!id.success) return fail("validation_failed", "Invalid id", 400, { requestId });
  try {
    const r = await resultadosDaRodada(createAdminClient(), id.data);
    if (!r.rodada) return fail("not_found", "Round not found", 404, { requestId });
    return ok(r, { requestId });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "Query failed", 500, { requestId });
  }
}
