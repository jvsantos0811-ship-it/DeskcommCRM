/**
 * GET/POST /api/v1/cron/leitor-da-conversa — as rodadas do Leitor da conversa
 * (PM-027 §3), a cada 10 minutos (`docker/scheduler/entrypoint.sh`).
 *
 * A regra de quem é lido mora em `lib/dados/leitor/selecao.ts`; a passada numa
 * organização em `lib/dados/leitor/rodada.ts`; o ciclo das rodadas (a diária
 * das 06:00 no fuso de cada organização, a manual do "Atualizar agora" e o
 * retrato gerado logo depois que a diária termina) em `lib/dados/leitor/rodadas.ts`.
 * Esta rota só autoriza e chama:
 *
 *  - só organização ATIVA com o Leitor ligado e modelo aprovado entra;
 *  - uma organização que falha não para as outras;
 *  - passada que não leu nada nem terminou rodada não audita (a auditoria é
 *    feita pela própria passada, com o efeito na mão).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { criarLeitor } from "@/lib/dados/leitor/ler-lead";
import { cronDoLeitor } from "@/lib/dados/leitor/rodadas";
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
    const r = await cronDoLeitor(admin, { agora: new Date(), ler: criarLeitor(admin), requestId });
    return ok(r, { requestId });
  } catch (e) {
    logger.error("[leitor-da-conversa] a rodada falhou", {
      requestId,
      message: (e instanceof Error ? e.message : String(e)).slice(0, 300),
    });
    return fail("internal_error", "Não foi possível rodar o Leitor da conversa.", 500, { requestId });
  }
}

export const GET = handle;
export const POST = handle;
