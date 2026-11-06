/**
 * O RETRATO DAS 06:00 DOS PAINÉIS DE DADOS — v3 §8.2.
 *
 * Roda de hora em hora (`docker/scheduler/entrypoint.sh`) e gera o retrato só
 * da organização cujo relógio já passou das 06:00 e que ainda não tem o retrato
 * do dia dela (`fn_dados_orgs_sem_retrato`, migration 9020). Assim cada uma é
 * atualizada às 6h no próprio fuso, e a que falhou é refeita na hora seguinte.
 *
 *  - Organização parada fica de fora: o banco só lista as operantes
 *    (`fn_org_operante`) e esta rota ainda tira `idsDeOrgsParadas`, como cinto.
 *  - Idempotente: a gravação é upsert por (organização, dia) com
 *    `p_so_se_faltar` — rodar duas vezes no mesmo dia não duplica nem refaz.
 *  - Uma organização que falha não para as outras: o erro vai para o log e para
 *    a auditoria (`dados.retrato_falhou`), e a rodada segue.
 *  - Rodada sem nada a fazer não audita (`cron-audita-so-quando-ha-efeito`).
 *  - Organização com o Leitor da conversa ligado espera a rodada diária dele
 *    terminar (PM-027 §3: o retrato vem depois do Leitor). Quem gera o retrato,
 *    nesse caso, é o próprio fim da rodada (`lib/dados/leitor/rodadas.ts`); esta
 *    rota só o gera se a rodada passar de 3 horas aberta (`retratoEsperaOLeitor`).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { ErroDoRetrato, gerarRetratoDaOrg } from "@/lib/dados/gerar-retrato";
import { retratoEsperaOLeitor } from "@/lib/dados/leitor/rodadas";
import { HORA_DO_RETRATO } from "@/lib/dados/retrato";
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
  const { data, error } = await admin.rpc("fn_dados_orgs_sem_retrato", { p_hora: HORA_DO_RETRATO });
  if (error) {
    logger.error("[dados-retrato] não consegui listar as organizações", { requestId, message: error.message });
    return fail("internal_error", "Não foi possível listar as organizações.", 500, { requestId });
  }
  const alvo = ((data ?? []) as Array<{ organization_id: string; dia: string }>).filter(
    (o) => !paradas.has(o.organization_id),
  );

  // O Leitor ligado faz o retrato esperar a rodada diária (até 3 horas).
  const agora = new Date();
  const orgsDoAlvo = new Map<string, { id: string; settings: unknown; timezone: string | null }>();
  if (alvo.length > 0) {
    const { data: orgs } = await admin
      .from("organizations")
      .select("id, settings, timezone")
      .in(
        "id",
        alvo.map((o) => o.organization_id),
      );
    for (const org of (orgs ?? []) as Array<{ id: string; settings: unknown; timezone: string | null }>) orgsDoAlvo.set(org.id, org);
  }

  let gerados = 0;
  let falhas = 0;
  let esperando = 0;
  for (const o of alvo) {
    const org = orgsDoAlvo.get(o.organization_id);
    if (org && (await retratoEsperaOLeitor(admin, org, agora))) {
      esperando += 1;
      continue;
    }
    try {
      const r = await gerarRetratoDaOrg(admin, o.organization_id, "cron", { soSeFaltar: true });
      if (r.gravado) {
        gerados += 1;
        await audit({
          organizationId: o.organization_id,
          action: "dados.retrato_gerado",
          resourceType: "crm_dados_retrato",
          metadata: { origem: "cron", dia: r.dia, leads: r.leads, apagados: r.apagados },
          requestId,
        });
      }
    } catch (e) {
      falhas += 1;
      const etapa = e instanceof ErroDoRetrato ? e.etapa : "desconhecida";
      const mensagem = e instanceof Error ? e.message : String(e);
      logger.error("[dados-retrato] falhou numa organização; sigo para as outras", {
        requestId,
        organization_id: o.organization_id,
        etapa,
        message: mensagem,
      });
      await audit({
        organizationId: o.organization_id,
        action: "dados.retrato_falhou",
        resourceType: "crm_dados_retrato",
        metadata: { dia: o.dia, etapa, erro: mensagem.slice(0, 300) },
        requestId,
      });
    }
  }

  return ok({ organizacoes: alvo.length, gerados, falhas, esperando_o_leitor: esperando }, { requestId });
}

export const GET = handle;
export const POST = handle;
