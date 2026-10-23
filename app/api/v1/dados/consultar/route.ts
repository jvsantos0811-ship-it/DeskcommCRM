/**
 * GET /api/v1/dados/consultar — calcula UM widget de painel (migration 9004).
 *
 * Parâmetros: `metrica`, `agrupar_por`, `periodo_dias`, e opcionais
 * `pipeline_id` e `owner_user_id` — validados contra o catálogo fechado de
 * `lib/dados/widgets.ts`. Não há SQL vindo da tela.
 *
 * Lê pelo client de RLS de quem pergunta: o atendente em "só os seus" vê os
 * números dos negócios DELE, como no quadro. O fuso é o da organização — "por
 * dia" quer dizer o dia de quem trabalha, não o de Greenwich.
 *
 * Teto de linhas por consulta (`TETO`): o resultado diz `truncado` quando bate
 * nele, em vez de devolver um número menor sem avisar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  calcularConversas,
  calcularNegocios,
  widgetSchema,
  type LinhaDeConversa,
  type LinhaDeNegocio,
} from "@/lib/dados/widgets";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { fusoUtilizavel } from "@/lib/tempo/fusos";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";

const TETO = 10_000;

interface LinhaBruta {
  status: "open" | "won" | "lost";
  value_cents: number | null;
  created_at: string;
  closed_at: string | null;
  source: string | null;
  lost_reason: string | null;
  owner_user_id: string | null;
  stage: { name: string | null } | null;
  pipeline: { name: string | null } | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "dados" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const fuso = fusoUtilizavel(authz.org.timezone);

  const p = req.nextUrl.searchParams;
  const parsed = widgetSchema.safeParse({
    id: "consulta",
    titulo: "consulta",
    metrica: p.get("metrica"),
    agrupar_por: p.get("agrupar_por"),
    visual: p.get("agrupar_por") === "nenhum" ? "numero" : "barras",
    periodo_dias: Number(p.get("periodo_dias")),
    pipeline_id: p.get("pipeline_id") || null,
    owner_user_id: p.get("owner_user_id") || null,
  });
  if (!parsed.success) return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  const w = parsed.data;
  const desde = new Date(Date.now() - w.periodo_dias * 86_400_000).toISOString();
  const supabase = await createClient();

  if (w.metrica === "conversas_iniciadas") {
    let q = supabase
      .from("conversations")
      .select("created_at, assigned_to_user_id")
      .eq("organization_id", orgId)
      .gte("created_at", desde)
      .limit(TETO);
    if (w.owner_user_id) q = q.eq("assigned_to_user_id", w.owner_user_id);
    const { data, error } = await q;
    if (error) return fail("internal_error", t("Não foi possível calcular este gráfico."), 500, { requestId });
    const brutas = (data ?? []) as Array<{ created_at: string; assigned_to_user_id: string | null }>;
    const nomes = w.agrupar_por === "dono" ? await nomesDosAtendentes(brutas.map((b) => b.assigned_to_user_id)) : new Map();
    const linhas: LinhaDeConversa[] = brutas.map((b) => ({
      created_at: b.created_at,
      dono: b.assigned_to_user_id ? (nomes.get(b.assigned_to_user_id) ?? t("Sem nome")) : t("Sem dono"),
    }));
    return ok({ ...calcularConversas(w, linhas, fuso), truncado: brutas.length >= TETO }, { requestId });
  }

  let q = supabase
    .from("crm_leads")
    .select(
      "status, value_cents, created_at, closed_at, source, lost_reason, owner_user_id, stage:crm_stages!crm_leads_stage_id_fkey(name), pipeline:crm_pipelines(name)",
    )
    .eq("organization_id", orgId)
    .limit(TETO);
  if (w.metrica === "leads_criados") q = q.gte("created_at", desde);
  else if (w.metrica === "negocios_abertos" || w.metrica === "valor_em_aberto") q = q.eq("status", "open");
  else q = q.in("status", ["won", "lost"]).gte("closed_at", desde);
  if (w.pipeline_id) q = q.eq("pipeline_id", w.pipeline_id);
  if (w.owner_user_id) q = q.eq("owner_user_id", w.owner_user_id);

  const { data, error } = await q;
  if (error) return fail("internal_error", t("Não foi possível calcular este gráfico."), 500, { requestId });
  const brutas = (data ?? []) as unknown as LinhaBruta[];
  const nomes = w.agrupar_por === "dono" ? await nomesDosAtendentes(brutas.map((b) => b.owner_user_id)) : new Map();
  const linhas: LinhaDeNegocio[] = brutas.map((b) => ({
    status: b.status,
    value_cents: b.value_cents,
    created_at: b.created_at,
    closed_at: b.closed_at,
    stage: b.stage?.name ?? null,
    funil: b.pipeline?.name ?? null,
    dono: b.owner_user_id ? (nomes.get(b.owner_user_id) ?? t("Sem nome")) : t("Sem dono"),
    origem: b.source,
    motivo: b.lost_reason,
  }));
  return ok({ ...calcularNegocios(w, linhas, fuso), truncado: brutas.length >= TETO }, { requestId });
}
