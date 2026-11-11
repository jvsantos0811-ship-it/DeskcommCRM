/**
 * GET /api/v1/dados/qualidade — o que as abas de Dados mostram (v3 §4 e §8.4):
 * Qualidade do lead, Dinheiro em jogo, Gestão e Explorar.
 *
 * A tela NÃO calcula ao abrir: lê o retrato do dia (`crm_dados_retrato`,
 * migration 9020) pelo cliente da sessão — vale a RLS, que só deixa ler quem
 * vê a organização inteira — e compara com os retratos de ontem e de 7 dias
 * atrás. Os agrupamentos saem do retrato, no servidor (`montarPaineis`).
 *
 * O atendente em "só os seus" não lê o retrato (ele soma os leads dos colegas):
 * para ele a conta é feita na hora, com `fn_dados_leads_do_retrato` (SECURITY
 * INVOKER — a RLS entrega só os leads dele), sem comparação e sem gravar nada.
 *
 * Os nomes dos leads são lidos AGORA, pela RLS: o retrato não guarda nome.
 *
 * PERÍODO (PC-025): `?periodo=hoje|7d|30d|mes|mes_passado` ou
 * `?periodo=personalizado&de=AAAA-MM-DD&ate=AAAA-MM-DD`. Os dias são do fuso da
 * organização e inclusivos; o retrato fica só com os leads que ENTRARAM no
 * período e as contas são refeitas pelas mesmas funções (`recortarPeloPeriodo`).
 * As comparações recortam os retratos de ontem e de 7 dias pelo mesmo período.
 * Sem `periodo`, nada muda.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { montarRetratoDaOrg } from "@/lib/dados/gerar-retrato";
import { montarResposta, type CabecalhoDoRetrato, type ModoDoPainel } from "@/lib/dados/resposta";
import { diaNoFuso, somarDias, type ConteudoDoRetrato, type ResumoDoRetrato } from "@/lib/dados/retrato";
import { periodoDosParametros, resolverPeriodo, type PeriodoResolvido } from "@/lib/dados/periodo";
import { recortarPeloPeriodo } from "@/lib/dados/recorte-do-periodo";
import { rotuloDoInteresse } from "@/lib/kanban/vocabulary";
import type { PipelineVocabulary } from "@/lib/kanban/types";
import { logger } from "@/lib/logger";
import { buscaEmLotes } from "@/lib/supabase/em-lotes";
import { createClient } from "@/lib/supabase/server";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

export const dynamic = "force-dynamic";

const COLUNAS_DO_RETRATO = "dia, gerado_em, origem, versao_regra, fuso, resumo, leads, por_dia, funil, por_etapa, motivos";

interface LinhaDoRetratoGravado extends ConteudoDoRetrato {
  dia: string;
  gerado_em: string;
  origem: string;
  versao_regra: number;
  fuso: string;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_dados_retrato" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const supabase = await createClient();
  const agora = new Date();
  const pedido = periodoDosParametros(req.nextUrl.searchParams);

  const { data: ve, error: eVe } = await supabase.rpc("fn_dados_ve_a_org_inteira", { p_org: orgId });
  if (eVe) return fail("internal_error", "Erro ao ler os painéis de Dados.", 500, { requestId });
  const veAOrgInteira = ve === true;

  let modo: ModoDoPainel;
  let conteudo: ConteudoDoRetrato | null = null;
  let cabecalho: CabecalhoDoRetrato | null = null;
  let fuso = fusoUtilizavel(authz.org.timezone);
  let ontem: ResumoDoRetrato | null = null;
  let seteDias: ResumoDoRetrato | null = null;
  let periodo: PeriodoResolvido | null = null;

  if (veAOrgInteira) {
    const { data, error } = await supabase
      .from("crm_dados_retrato")
      .select(COLUNAS_DO_RETRATO)
      .eq("organization_id", orgId)
      .order("dia", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return fail("internal_error", "Erro ao ler o retrato de Dados.", 500, { requestId });
    const r = data as LinhaDoRetratoGravado | null;
    if (r) {
      modo = "retrato";
      fuso = fusoUtilizavel(r.fuso);
      cabecalho = { dia: r.dia, gerado_em: r.gerado_em, origem: r.origem, versao_regra: r.versao_regra };
      conteudo = {
        resumo: r.resumo,
        leads: r.leads ?? [],
        por_dia: r.por_dia ?? [],
        funil: r.funil ?? [],
        por_etapa: r.por_etapa ?? [],
        motivos: r.motivos ?? [],
      };
      const diaOntem = somarDias(r.dia, -1);
      const diaSete = somarDias(r.dia, -7);
      // Com período, a comparação precisa da LISTA dos retratos de antes (para
      // recortar a mesma turma); sem período, basta o resumo.
      const { data: antes } = await supabase
        .from("crm_dados_retrato")
        .select(pedido ? "dia, gerado_em, fuso, resumo, leads, por_dia, funil, por_etapa, motivos" : "dia, resumo")
        .eq("organization_id", orgId)
        .in("dia", [diaOntem, diaSete]);
      periodo = resolverPeriodo(pedido, diaNoFuso(agora, fuso));
      for (const a of (antes ?? []) as unknown as LinhaDoRetratoGravado[]) {
        let resumo: ResumoDoRetrato | null = a.resumo;
        if (periodo) {
          // Retrato de mais de 7 dias fica sem a lista: sem ela não há como recortar.
          resumo =
            a.leads && a.leads.length > 0
              ? recortarPeloPeriodo(a, periodo, new Date(a.gerado_em), fusoUtilizavel(a.fuso)).resumo
              : null;
        }
        if (a.dia === diaOntem) ontem = resumo;
        if (a.dia === diaSete) seteDias = resumo;
      }
      if (periodo) conteudo = recortarPeloPeriodo(conteudo, periodo, new Date(r.gerado_em), fuso);
    } else {
      modo = "sem_retrato";
    }
  } else {
    modo = "ao_vivo";
    try {
      const vivo = await montarRetratoDaOrg(supabase, orgId, agora);
      fuso = vivo.fuso;
      conteudo = vivo;
      periodo = resolverPeriodo(pedido, diaNoFuso(agora, fuso));
      if (periodo) conteudo = recortarPeloPeriodo(vivo, periodo, agora, fuso);
    } catch (e) {
      logger.warn("dados: conta ao vivo falhou", { requestId, message: e instanceof Error ? e.message : String(e) });
      return fail("internal_error", "Erro ao calcular os seus números.", 500, { requestId });
    }
  }

  // Os nomes, ao vivo e pela RLS (o retrato não guarda nome).
  const nomes = new Map<string, string>();
  const ids = (conteudo?.leads ?? []).map((l) => l.id);
  if (ids.length > 0) {
    const { data: linhas } = await buscaEmLotes(ids, (lote) =>
      supabase.from("crm_leads").select("id, title").eq("organization_id", orgId).in("id", lote),
    );
    for (const l of linhas as Array<{ id: string; title: string }>) nomes.set(l.id, l.title);
  }

  let rotulo: string | null = null;
  const pipelineId = conteudo?.resumo.pipeline_id ?? null;
  if (pipelineId) {
    const { data: p } = await supabase
      .from("crm_pipelines")
      .select("vocabulary")
      .eq("organization_id", orgId)
      .eq("id", pipelineId)
      .maybeSingle();
    rotulo = rotuloDoInteresse((p as { vocabulary?: PipelineVocabulary } | null)?.vocabulary);
  }

  if (modo === "sem_retrato") periodo = resolverPeriodo(pedido, diaNoFuso(agora, fuso));

  return ok(
    montarResposta({
      modo,
      agora,
      fuso,
      retrato: cabecalho,
      conteudo,
      ontem,
      seteDias,
      nomes,
      podeAtualizar: veAOrgInteira && roleAtLeast(authz.org.role, "manager"),
      rotuloDoInteresse: rotulo,
      periodo,
    }),
    { requestId },
  );
}
