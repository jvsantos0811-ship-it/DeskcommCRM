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
 *  - PC-037 §3: na organização com o painel pela ficha, a ficha gravada refaz o
 *    retrato na hora, em lote de 5 minutos. A que caiu dentro do lote (ex.: a
 *    correção do Gestor logo depois de outra) é refeita aqui, de hora em hora,
 *    quando há ficha mais nova que o retrato de hoje (`fichaMaisNovaQueORetrato`).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { ErroDoRetrato, fichaMaisNovaQueORetrato, gerarRetratoDaOrg, refazerRetratoPelaFicha } from "@/lib/dados/gerar-retrato";
import { lerPadraoDoLeitor } from "@/lib/dados/leitor/padrao";
import { retratoEsperaOLeitor } from "@/lib/dados/leitor/rodadas";
import { diaNoFuso, HORA_DO_RETRATO } from "@/lib/dados/retrato";
import { logger } from "@/lib/logger";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

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
  type OrgDoAlvo = { id: string; settings: unknown; timezone: string | null; created_at: string | null };
  const orgsDoAlvo = new Map<string, OrgDoAlvo>();
  if (alvo.length > 0) {
    const { data: orgs } = await admin
      .from("organizations")
      .select("id, settings, timezone, created_at")
      .in(
        "id",
        alvo.map((o) => o.organization_id),
      );
    for (const org of (orgs ?? []) as OrgDoAlvo[]) orgsDoAlvo.set(org.id, org);
  }
  // Quem segue o modelo padrão do Leitor também está "ligado": o padrão é lido uma vez.
  const padraoDoLeitor = alvo.length > 0 ? await lerPadraoDoLeitor(admin) : null;

  let gerados = 0;
  let falhas = 0;
  let esperando = 0;
  for (const o of alvo) {
    const org = orgsDoAlvo.get(o.organization_id);
    if (org && (await retratoEsperaOLeitor(admin, org, agora, padraoDoLeitor))) {
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

  // PC-037 §3: o fim do lote do painel pela ficha.
  let refeitosPelaFicha = 0;
  const { data: pelaFicha, error: ePelaFicha } = await admin
    .from("organizations")
    .select("id, timezone")
    .eq("settings->leitor->>painel_pela_ficha", "true");
  if (ePelaFicha) {
    logger.error("[dados-retrato] não consegui listar as organizações do painel pela ficha", { requestId, message: ePelaFicha.message });
  }
  for (const org of ((pelaFicha ?? []) as Array<{ id: string; timezone: string | null }>).filter((o) => !paradas.has(o.id))) {
    try {
      if (!(await fichaMaisNovaQueORetrato(admin, org.id, diaNoFuso(agora, fusoUtilizavel(org.timezone))))) continue;
      const r = await refazerRetratoPelaFicha(admin, org.id, { agora });
      if (r?.gravado) {
        refeitosPelaFicha += 1;
        await audit({
          organizationId: org.id,
          action: "dados.retrato_gerado",
          resourceType: "crm_dados_retrato",
          metadata: { origem: "ficha", dia: r.dia, leads: r.leads, apagados: r.apagados },
          requestId,
        });
      }
    } catch (e) {
      falhas += 1;
      logger.error("[dados-retrato] o painel pela ficha falhou numa organização; sigo para as outras", {
        requestId,
        organization_id: org.id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return ok(
    { organizacoes: alvo.length, gerados, falhas, esperando_o_leitor: esperando, refeitos_pela_ficha: refeitosPelaFicha },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;
