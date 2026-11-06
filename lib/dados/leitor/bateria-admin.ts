/**
 * A BATERIA DO LEITOR NA ÁREA DO DONO — o que a página `/admin/bateria-do-leitor`
 * lê e grava (PM-027 §8–§9; decisão do dono em 06/11: a aprovação vale para a
 * instalação). Tudo com o cliente de serviço, que só a rota do admin usa: os
 * casos e os resultados citam conversas de um escritório e nenhum usuário do app
 * os lê.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { juizPara } from "./bateria";
import {
  CASOS_PARA_UMA_BATERIA_ROBUSTA,
  principaisNoCatalogo,
  type ModeloDoCatalogo,
} from "./modelos-principais";

export interface RodadaNaTela {
  id: string;
  provider: string;
  model_id: string;
  juiz_provider: string;
  juiz_model_id: string;
  credencial_organization_id: string | null;
  status: string;
  criada_em: string;
  terminada_em: string | null;
  casos_total: number;
  casos_feitos: number;
  acertos: number;
  bloqueantes: number;
  bloqueantes_acertos: number;
  regra_v2: number;
  qualidade_acertos: number;
  aprovado: boolean | null;
  tempo_medio_ms: number | null;
  custo_cents: number | null;
  erro: string | null;
}

const COLUNAS_DA_RODADA =
  "id, provider, model_id, juiz_provider, juiz_model_id, credencial_organization_id, status, criada_em, terminada_em, casos_total, casos_feitos, acertos, bloqueantes, bloqueantes_acertos, regra_v2, qualidade_acertos, aprovado, tempo_medio_ms, custo_cents, erro";

export interface ResumoDaBateria {
  casos: {
    total: number;
    bloqueantes: number;
    regraV2: number;
    inventados: number;
    porOrigem: Array<{ organization_id: string; nome: string; casos: number }>;
    pequena: boolean;
    paraRevisar: number;
  };
  rodadas: RodadaNaTela[];
  principais: ModeloDoCatalogo[];
  organizacoes: Array<{ id: string; nome: string }>;
}

export async function resumoDaBateria(admin: SupabaseClient): Promise<ResumoDaBateria> {
  const [casosR, rodadasR, catalogoR, orgsR, revisarR] = await Promise.all([
    admin.from("leitor_bateria_casos").select("origem_organization_id, bloqueia, gabarito").eq("ativo", true),
    admin.from("leitor_bateria_rodadas").select(COLUNAS_DA_RODADA).order("criada_em", { ascending: false }).limit(40),
    admin
      .from("ai_models")
      .select("provider, model_id, display_name, input_price_per_million_cents, output_price_per_million_cents")
      .is("deprecated_at", null),
    admin.from("organizations").select("id, display_name").order("display_name"),
    admin.from("leitor_bateria_resultados").select("id", { count: "exact", head: true }).eq("revisar", true),
  ]);
  for (const r of [casosR, rodadasR, catalogoR, orgsR]) if (r.error) throw new Error(r.error.message);
  const casos = (casosR.data ?? []) as Array<{ origem_organization_id: string | null; bloqueia: boolean; gabarito: { tipo?: string } }>;
  const nomes = new Map(((orgsR.data ?? []) as Array<{ id: string; display_name: string | null }>).map((o) => [o.id, o.display_name ?? o.id]));
  const porOrigem = new Map<string, number>();
  for (const c of casos) if (c.origem_organization_id) porOrigem.set(c.origem_organization_id, (porOrigem.get(c.origem_organization_id) ?? 0) + 1);
  return {
    casos: {
      total: casos.length,
      bloqueantes: casos.filter((c) => c.bloqueia).length,
      regraV2: casos.filter((c) => c.gabarito?.tipo === "regra_v2").length,
      inventados: casos.filter((c) => !c.origem_organization_id).length,
      porOrigem: [...porOrigem.entries()].map(([organization_id, n]) => ({ organization_id, nome: nomes.get(organization_id) ?? organization_id, casos: n })),
      pequena: casos.length < CASOS_PARA_UMA_BATERIA_ROBUSTA,
      paraRevisar: revisarR.count ?? 0,
    },
    rodadas: (rodadasR.data ?? []) as RodadaNaTela[],
    principais: principaisNoCatalogo((catalogoR.data ?? []) as ModeloDoCatalogo[]),
    organizacoes: [...nomes.entries()].map(([id, nome]) => ({ id, nome })),
  };
}

export class PedidoDeRodadaRecusado extends Error {
  constructor(public readonly codigo: "juiz_igual_ao_testado" | "sem_casos" | "ja_rodando") {
    super(codigo);
  }
}

export async function pedirRodada(
  admin: SupabaseClient,
  p: {
    testado: { provider: string; model_id: string };
    juiz: { provider: string; model_id: string } | null;
    credencialOrganizationId: string;
    pedidaPor: string;
  },
): Promise<RodadaNaTela> {
  const mesmo = (a: string, b: string) => a.replace(/^[a-z0-9-]+\//, "").toLowerCase() === b.replace(/^[a-z0-9-]+\//, "").toLowerCase();
  if (p.juiz && mesmo(p.juiz.model_id, p.testado.model_id)) throw new PedidoDeRodadaRecusado("juiz_igual_ao_testado");
  const juiz = juizPara(p.testado, p.juiz);
  const { count } = await admin.from("leitor_bateria_casos").select("id", { count: "exact", head: true }).eq("ativo", true);
  if (!count) throw new PedidoDeRodadaRecusado("sem_casos");
  const { data: viva } = await admin
    .from("leitor_bateria_rodadas")
    .select("id")
    .eq("provider", p.testado.provider)
    .eq("model_id", p.testado.model_id)
    .in("status", ["pendente", "rodando"])
    .limit(1)
    .maybeSingle();
  if (viva) throw new PedidoDeRodadaRecusado("ja_rodando");
  const { data, error } = await admin
    .from("leitor_bateria_rodadas")
    .insert({
      provider: p.testado.provider,
      model_id: p.testado.model_id,
      juiz_provider: juiz.provider,
      juiz_model_id: juiz.model_id,
      credencial_organization_id: p.credencialOrganizationId,
      pedida_por: p.pedidaPor,
      casos_total: count,
    })
    .select(COLUNAS_DA_RODADA)
    .maybeSingle();
  if (error || !data) throw new Error(error?.message ?? "rodada não criada");
  return data as RodadaNaTela;
}

export interface ResultadoNaTela {
  caso_id: string;
  caso_versao: number;
  passou_sem_juiz: boolean;
  acerto: boolean;
  qualidade_igual: boolean | null;
  divergencias: unknown;
  juiz_decisao: string | null;
  juiz_lado_do_gabarito: string | null;
  juiz_motivo: string | null;
  juiz_trecho: string | null;
  revisar: boolean;
  latencia_ms: number | null;
  erro: string | null;
}

export async function resultadosDaRodada(admin: SupabaseClient, rodadaId: string): Promise<{ rodada: RodadaNaTela | null; resultados: ResultadoNaTela[] }> {
  const [rodadaR, resR] = await Promise.all([
    admin.from("leitor_bateria_rodadas").select(COLUNAS_DA_RODADA).eq("id", rodadaId).maybeSingle(),
    admin
      .from("leitor_bateria_resultados")
      .select("caso_id, caso_versao, passou_sem_juiz, acerto, qualidade_igual, divergencias, juiz_decisao, juiz_lado_do_gabarito, juiz_motivo, juiz_trecho, revisar, latencia_ms, erro")
      .eq("rodada_id", rodadaId)
      .order("caso_id"),
  ]);
  if (rodadaR.error) throw new Error(rodadaR.error.message);
  if (resR.error) throw new Error(resR.error.message);
  return { rodada: (rodadaR.data as RodadaNaTela | null) ?? null, resultados: (resR.data ?? []) as ResultadoNaTela[] };
}

/**
 * Os modelos aprovados na instalação: o placar da rodada terminada MAIS NOVA de
 * cada modelo. Um modelo que passou e depois reprovou numa bateria maior deixa de
 * estar aprovado. Lido também pela tela Provedores de cada escritório (só números).
 */
export async function ultimaRodadaPorModelo(db: SupabaseClient): Promise<Map<string, RodadaNaTela>> {
  const { data, error } = await db
    .from("leitor_bateria_rodadas")
    .select(COLUNAS_DA_RODADA)
    .eq("status", "terminada")
    .order("terminada_em", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  const m = new Map<string, RodadaNaTela>();
  for (const r of (data ?? []) as RodadaNaTela[]) {
    const k = `${r.provider}/${r.model_id}`;
    if (!m.has(k)) m.set(k, r);
  }
  return m;
}
