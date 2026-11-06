/**
 * GET/POST /api/v1/cron/ninguem-respondeu — o aviso "Um lead escreveu e ninguém
 * respondeu" (PM-025 §7), a cada 5 minutos (`docker/scheduler/entrypoint.sh`).
 *
 * A regra mora em `lib/escalacao/ninguem-respondeu.ts` e a parte com banco em
 * `lib/escalacao/ninguem-respondeu-rodada.ts`. Esta rota só autoriza, chama e
 * audita:
 *
 *  - só organização ATIVA que ligou o aviso entra (`ehOperante` na rodada);
 *  - uma organização que falha não para as outras;
 *  - rodada sem aviso aberto nem resolvido não audita
 *    (`tests/unit/cron-audita-so-quando-ha-efeito.test.ts`).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { criarConferidorDoFim } from "@/lib/escalacao/conferir-fim-da-conversa";
import { rodadaNinguemRespondeu } from "@/lib/escalacao/ninguem-respondeu-rodada";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  try {
    const r = await rodadaNinguemRespondeu(admin, { agora: new Date(), conferir: criarConferidorDoFim(admin) });
    if (r.abertos > 0 || r.resolvidos > 0) {
      void audit({
        action: "central.ninguem_respondeu_rodada",
        organizationId: null,
        bypassedRls: true,
        resourceType: "agent_inbox_items",
        metadata: { ...r },
        requestId,
      });
    }
    return ok(r, { requestId });
  } catch (e) {
    logger.error("[ninguem-respondeu] a rodada falhou", {
      requestId,
      message: (e instanceof Error ? e.message : String(e)).slice(0, 300),
    });
    return fail("internal_error", "Não foi possível rodar o aviso.", 500, { requestId });
  }
}

export const GET = handle;
export const POST = handle;
