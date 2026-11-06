/**
 * GET /api/v1/dados/esperando-a-equipe — o painel "Esperando a equipe" de Dados
 * (PM-027 §6): os leads que esperam uma PESSOA da equipe há mais de 2 dias úteis.
 *
 * `?pipeline_id=<uuid>` restringe a um funil — é o que o quadro pede quando abre
 * com `?esperando=equipe`, para filtrar os cards pela mesma regra do painel.
 *
 * Só para quem vê a organização inteira (`fn_dados_ve_a_org_inteira`, a mesma
 * régua do retrato de Dados): a conta usa a ficha do Leitor, que a RLS só
 * entrega a quem vê tudo. Para os outros a resposta diz `disponivel: false` e a
 * tela não mostra o painel. A conta é feita na hora (é relógio, não IA) com o
 * cliente de serviço, filtrando a organização da sessão à mão; os NOMES são
 * lidos pela RLS, como no restante de Dados.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { esperandoAEquipeDaOrg, type LeadEsperandoAEquipe } from "@/lib/dados/esperando-a-equipe-da-org";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { buscaEmLotes } from "@/lib/supabase/em-lotes";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const consultaSchema = z.object({ pipeline_id: z.string().uuid().optional() });

export interface LeadEsperandoNaTela extends LeadEsperandoAEquipe {
  titulo: string;
}

export interface RespostaEsperandoAEquipe {
  disponivel: boolean;
  ligado: boolean;
  agora: string;
  leads: LeadEsperandoNaTela[];
  funis: Array<{ pipeline_id: string; nome: string; leads: number }>;
  falhas: number;
}

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_lead_ficha" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const parsed = consultaSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return fail("validation_error", "Parâmetros inválidos.", 422, { requestId });

  const agora = new Date();
  const vazio: RespostaEsperandoAEquipe = { disponivel: false, ligado: false, agora: agora.toISOString(), leads: [], funis: [], falhas: 0 };
  const supabase = await createClient();
  const { data: ve, error: eVe } = await supabase.rpc("fn_dados_ve_a_org_inteira", { p_org: orgId });
  if (eVe) return fail("internal_error", "Erro ao ler o painel.", 500, { requestId });
  if (ve !== true) return ok(vazio, { requestId });

  let conta;
  try {
    conta = await esperandoAEquipeDaOrg(createAdminClient(), orgId, agora, { pipelineId: parsed.data.pipeline_id });
  } catch (e) {
    logger.warn("dados: esperando a equipe falhou", { requestId, message: e instanceof Error ? e.message : String(e) });
    return fail("internal_error", "Erro ao calcular quem está esperando a equipe.", 500, { requestId });
  }
  if (!conta.ligado) return ok({ ...vazio, disponivel: true }, { requestId });

  const titulos = new Map<string, string>();
  const ids = conta.leads.map((l) => l.lead_id);
  if (ids.length > 0) {
    const { data: linhas } = await buscaEmLotes(ids, (lote) =>
      supabase.from("crm_leads").select("id, title").eq("organization_id", orgId).in("id", lote),
    );
    for (const l of linhas as Array<{ id: string; title: string }>) titulos.set(l.id, l.title);
  }
  // O lead que a RLS não entregou não aparece (nome é dado pessoal).
  const leads = conta.leads.filter((l) => titulos.has(l.lead_id)).map((l) => ({ ...l, titulo: titulos.get(l.lead_id)! }));

  const porFunil = new Map<string, number>();
  for (const l of leads) porFunil.set(l.pipeline_id, (porFunil.get(l.pipeline_id) ?? 0) + 1);
  const nomes = new Map<string, string>();
  if (porFunil.size > 0) {
    const { data: ps } = await supabase
      .from("crm_pipelines")
      .select("id, name")
      .eq("organization_id", orgId)
      .in("id", [...porFunil.keys()]);
    for (const p of (ps ?? []) as Array<{ id: string; name: string }>) nomes.set(p.id, p.name);
  }
  const funis = [...porFunil]
    .map(([pipeline_id, n]) => ({ pipeline_id, nome: nomes.get(pipeline_id) ?? "", leads: n }))
    .sort((a, b) => b.leads - a.leads);

  const resposta: RespostaEsperandoAEquipe = {
    disponivel: true,
    ligado: true,
    agora: agora.toISOString(),
    leads,
    funis,
    falhas: conta.falhas,
  };
  return ok(resposta, { requestId });
}
