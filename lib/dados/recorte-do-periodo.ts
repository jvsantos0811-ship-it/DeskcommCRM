/**
 * O RETRATO RECORTADO PELO PERÍODO (PC-025, item 2) — puro, sem banco.
 *
 * O retrato guarda TODOS os leads do funil padrão, cada um com o dia em que
 * entrou no fuso da organização (`dia`). Escolher um período é ficar só com os
 * leads que entraram nele e refazer as contas com as MESMAS funções do retrato
 * (`montarConteudo`): nada de uma segunda régua para o mesmo número.
 *
 * As comparações (ontem, 7 dias) recortam os retratos daqueles dias pelo mesmo
 * período: é a mesma turma de leads, vista ontem e há 7 dias.
 */
import { diasDoPeriodo, diaNoPeriodo, type PeriodoResolvido } from "@/lib/dados/periodo";
import { montarConteudo, type ConteudoDoRetrato, type LeadDoRetrato } from "@/lib/dados/retrato";

/** O gráfico "por dia" mostra até isto (os últimos dias do período). */
export const DIAS_NO_GRAFICO_DO_PERIODO = 92;

export function recortarPeloPeriodo(
  c: ConteudoDoRetrato,
  p: PeriodoResolvido,
  agora: Date,
  fuso: string,
): ConteudoDoRetrato {
  const leads: LeadDoRetrato[] = c.leads.filter((l) => diaNoPeriodo(l.dia, p));
  // As etapas do funil vêm de `por_etapa` (a etapa vazia também aparece);
  // etapa que só existia num lead (fora do funil padrão) volta pelo próprio lead.
  const etapas = c.por_etapa
    .filter((e) => e.posicao !== Number.MAX_SAFE_INTEGER)
    .map((e) => ({ id: e.etapa_id, nome: e.etapa, posicao: e.posicao }));
  return montarConteudo(
    leads,
    {
      agora,
      fuso,
      pipelineId: c.resumo.pipeline_id,
      moeda: c.resumo.moeda,
      tipos: c.resumo.tipos ?? [],
      etapas,
    },
    diasDoPeriodo(p).slice(-DIAS_NO_GRAFICO_DO_PERIODO),
  );
}
