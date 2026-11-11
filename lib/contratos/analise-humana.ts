/**
 * O CARD VAI PARA "ANÁLISE HUMANA" QUANDO O CONTRATO PEDE UMA PESSOA (PC-030).
 *
 * Dois casos: o cliente já tem advogado ou processo sobre o pedido (a IA não
 * envia o contrato), e o cliente reclama ou questiona o contrato enviado.
 *
 * O destino é a "Etapa quando a equipe assume" do funil (PC-029; nas
 * organizações, "Análise humana"). Aqui SEM a trava de "só para frente": o
 * card sai de "Aguardando assinatura" (decisão do João) — mas nunca de um
 * ganho ou perda. Sem a etapa configurada, vale a etapa de passagem de sempre
 * (`chamar-humano`, quando o funil a tem). Quem move é o sistema, pelo caminho
 * de sempre (`moveLeadHandler`: linha do tempo e evento), nunca a IA — a trava
 * de etapa da IA não se aplica a esta mudança. Nunca lança.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import type { Actor } from "@/lib/api/handlers/types";
import { destinoDaAnaliseHumana, type EtapaParaAnalise } from "@/lib/contratos/regra-da-ia";
import { etapaQuandoAEquipeAssume } from "@/lib/escalacao/equipe-assumiu-regra";
import { moverLeadParaEtapaDeHandoff } from "@/lib/leads/handoff-stage-move";
import { logger } from "@/lib/logger";

const ATOR_DO_CONTRATO: Actor = { type: "webhook_source", id: "contrato" };

export async function levarParaAnaliseHumana(
  admin: SupabaseClient,
  e: { orgId: string; leadId: string; motivo: string; requestId: string },
): Promise<{ moveu: boolean; etapa: string | null }> {
  try {
    const { data: lead } = await admin
      .from("crm_leads")
      .select("id, pipeline_id, stage_id")
      .eq("organization_id", e.orgId)
      .eq("id", e.leadId)
      .maybeSingle();
    const l = lead as { id: string; pipeline_id: string; stage_id: string | null } | null;
    if (!l) return { moveu: false, etapa: null };

    const [{ data: funil }, { data: etapas }] = await Promise.all([
      admin.from("crm_pipelines").select("settings").eq("organization_id", e.orgId).eq("id", l.pipeline_id).maybeSingle(),
      admin
        .from("crm_stages")
        .select("id, position, is_won, is_lost, is_archived")
        .eq("organization_id", e.orgId)
        .eq("pipeline_id", l.pipeline_id),
    ]);
    const configurada = etapaQuandoAEquipeAssume((funil as { settings?: unknown } | null)?.settings);
    if (!configurada) {
      // Sem "Etapa quando a equipe assume": a etapa de passagem de sempre.
      const r = await moverLeadParaEtapaDeHandoff(admin, { organizationId: e.orgId, leadId: l.id, reason: e.motivo });
      return { moveu: r.moveu, etapa: null };
    }
    const destino = destinoDaAnaliseHumana((etapas ?? []) as EtapaParaAnalise[], l.stage_id, configurada);
    if (!destino) return { moveu: false, etapa: null };
    await moveLeadHandler(
      admin,
      { organization_id: e.orgId, actor: ATOR_DO_CONTRATO, requestId: e.requestId },
      l.id,
      { to_stage_id: destino, reason: e.motivo },
    );
    return { moveu: true, etapa: destino };
  } catch (err) {
    logger.warn("[contrato] card não levado para Análise humana", {
      organization_id: e.orgId,
      lead_id: e.leadId,
      detalhe: err instanceof Error ? err.message.slice(0, 160) : "erro",
    });
    return { moveu: false, etapa: null };
  }
}
