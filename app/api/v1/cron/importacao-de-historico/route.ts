/**
 * GET/POST /api/v1/cron/importacao-de-historico — uma rodada das importações
 * do histórico do canal intermediado (migration 9012). Agendado a cada minuto
 * no `scheduler`.
 *
 * Cada rodada pega no máximo UMA importação viva e trabalha nela por até 40 s
 * (`ORCAMENTO_DA_RODADA_MS`): importa conversas, guarda o cursor, e na rodada
 * seguinte continua. Duas rodadas nunca trabalham na mesma importação — o
 * `update` condicional de `pegarImportacao` é o cadeado — e uma rodada que
 * morreu no meio é retomada depois de 3 minutos sem sinal de vida.
 *
 * Organização parada não é varrida (`idsDeOrgsParadas`): a importação espera.
 *
 * Audita só quando houve efeito: o pedido já foi auditado na rota, e o
 * desfecho (`lead.imported`) é auditado na conclusão, dentro da rodada.
 * Rodada sem importação viva não escreve nada.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { importacoesPendentes, rodarImportacao } from "@/lib/channels/importacao-de-historico";
import { logger } from "@/lib/logger";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const paradas = new Set(await idsDeOrgsParadas(admin));
  const ids = await importacoesPendentes(admin);
  if (ids.length === 0) return ok({ rodadas: 0 }, { requestId });

  const { data: linhas } = await admin.from("importacoes_de_historico").select("id, organization_id").in("id", ids);
  const alvo = ((linhas ?? []) as Array<{ id: string; organization_id: string }>).find(
    (l) => !paradas.has(l.organization_id),
  );
  if (!alvo) return ok({ rodadas: 0 }, { requestId });

  const resultado = await rodarImportacao(admin, alvo.id);
  logger.info("[importacao-historico] rodada", {
    requestId,
    importacao_id: alvo.id,
    organization_id: alvo.organization_id,
    ...resultado,
  });
  return ok({ rodadas: 1, ...resultado }, { requestId });
}

export const GET = handle;
export const POST = handle;
