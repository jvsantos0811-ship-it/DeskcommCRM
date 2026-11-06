/**
 * GET/POST /api/v1/cron/bateria-do-leitor — a bateria do Leitor da conversa
 * (PM-027 §8–§9), a cada minuto (`docker/scheduler/entrypoint.sh`).
 *
 * Pega UMA rodada pendente (ou parada há 3 minutos) e avança caso a caso dentro
 * do orçamento (`lib/dados/leitor/bateria-rodada.ts`). Sem rodada, sai sem
 * efeito e sem auditar; quando uma rodada termina, audita o placar.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { passadaDaBateria } from "@/lib/dados/leitor/bateria-rodada";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** O agendador dá 60 s; a passada não começa caso novo depois disto. */
const ORCAMENTO_MS = 45_000;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  const admin = createAdminClient();
  try {
    const r = await passadaDaBateria(admin, { agora: new Date(), ateMs: Date.now() + ORCAMENTO_MS });
    if (r.rodada && (r.terminou || r.parou)) {
      const { data } = await admin
        .from("leitor_bateria_rodadas")
        .select("provider, model_id, status, acertos, casos_total, bloqueantes, bloqueantes_acertos, qualidade_acertos, regra_v2, aprovado, erro")
        .eq("id", r.rodada)
        .maybeSingle();
      void audit({
        action: "leitor.bateria_terminada",
        organizationId: null,
        bypassedRls: true,
        resourceType: "leitor_bateria_rodadas",
        metadata: { ...(data ?? {}), rodada_id: r.rodada, parou: r.parou },
        requestId,
      });
    }
    return ok(r, { requestId });
  } catch (e) {
    logger.error("[bateria-do-leitor] a passada falhou", {
      requestId,
      message: (e instanceof Error ? e.message : String(e)).slice(0, 300),
    });
    return fail("internal_error", "Não foi possível rodar a bateria do Leitor.", 500, { requestId });
  }
}

export const GET = handle;
export const POST = handle;
