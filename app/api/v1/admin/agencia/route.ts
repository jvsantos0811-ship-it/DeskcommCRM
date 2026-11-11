/**
 * GET /api/v1/admin/agencia — o painel da agência (PC-028).
 *
 * Só o dono da instalação (`requirePlatformAdmin`); organização cliente nunca
 * chega aqui. Só números agregados (`lib/agencia/painel.ts` diz de onde vem
 * cada um). Período: o mesmo seletor do painel de Dados (`periodo`, `de`,
 * `ate`); sem ele, o mês atual. `org` filtra uma organização.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { montarPainelDaAgencia } from "@/lib/agencia/ler";
import { periodoDaAgencia } from "@/lib/agencia/periodo-da-agencia";
import { createAdminClient } from "@/lib/supabase/admin";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }
  const p = req.nextUrl.searchParams;
  const { periodo, hoje } = periodoDaAgencia(p);
  const org = p.get("org");
  try {
    const painel = await montarPainelDaAgencia(createAdminClient(), {
      periodo,
      hoje,
      agora: new Date(),
      orgId: org && UUID.test(org) ? org : null,
      nomes: nomesDosAtendentes,
    });
    void audit({
      action: "platform_admin.agencia_viewed",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      metadata: { de: periodo.de, ate: periodo.ate, org: org ?? null },
      requestId,
    });
    return ok({ ...painel, periodo }, { requestId });
  } catch (e) {
    return fail(
      "internal_error",
      e instanceof Error ? e.message : "Erro ao montar o painel da agência",
      500,
      { requestId },
    );
  }
}
