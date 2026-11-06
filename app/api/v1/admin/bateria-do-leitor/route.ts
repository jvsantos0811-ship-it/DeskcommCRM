/**
 * GET /api/v1/admin/bateria-do-leitor — o resumo da bateria do Leitor da conversa
 * para a página do dono (PM-027 §8–§9): os casos (quantos, de onde, se a bateria
 * ainda é pequena), as rodadas recentes com o placar, os modelos principais com o
 * preço do catálogo e as organizações (para escolher a da chave e a da origem).
 * Só o dono da plataforma.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { resumoDaBateria } from "@/lib/dados/leitor/bateria-admin";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }
  try {
    return ok(await resumoDaBateria(createAdminClient()), { requestId });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "Query failed", 500, { requestId });
  }
}
