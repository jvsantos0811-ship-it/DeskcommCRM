/**
 * GET /api/v1/dados/perdas — MOTIVO DE PERDA em Dados › Explorar › Medir
 * (PC-025, item 1).
 *
 * Os cards PERDIDOS no período (pela data da perda, `closed_at`, em dias do
 * fuso da organização), por motivo, com o percentual sobre o total perdido e o
 * grupo "sem motivo". Filtros: `pipeline_id`, `etapa` (de onde o card saiu),
 * `marcou` (`ia` | `pessoa` | `outro`), `agente`, `origem` (`anuncio:<id>` ou o
 * `source` do card). Período: os mesmos parâmetros do painel (`periodo`, `de`,
 * `ate`); sem período, todas as perdas.
 *
 * Lê pelo client de RLS de quem pergunta (o atendente em "só os seus" vê os
 * dele, como no quadro). Nada de texto de conversa: só o card, a linha do tempo
 * que o encerrou e o agente da conversa. Nenhuma IA é chamada.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { periodoDosParametros, resolverPeriodo } from "@/lib/dados/periodo";
import {
  chaveDaOrigem,
  contarPorMotivo,
  filtrarPerdas,
  quemMarcou,
  type PerdaNoPeriodo,
  type QuemMarcou,
} from "@/lib/dados/perdas";
import { diaNoFuso } from "@/lib/dados/retrato";
import { periodoNoFuso } from "@/lib/datas/periodo-no-fuso";
import { traduzir } from "@/lib/i18n/dicionario";
import { buscaEmLotes } from "@/lib/supabase/em-lotes";
import { createClient } from "@/lib/supabase/server";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

export const dynamic = "force-dynamic";

/** Teto de perdas por consulta: o resultado diz `truncado` quando bate nele. */
const TETO = 10_000;
/** A linha do tempo do encerramento pode sair um instante depois do `closed_at`. */
const FOLGA_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LinhaDoCard {
  id: string;
  title: string;
  pipeline_id: string;
  stage_id: string;
  lost_reason: string | null;
  closed_at: string | null;
  source: string | null;
  source_metadata: Record<string, unknown> | null;
  contact_id: string | null;
}

interface LinhaDaAtividade {
  lead_id: string;
  type: string;
  payload: Record<string, unknown> | null;
  actor_kind: string | null;
  actor_agent_id: string | null;
  performed_at: string;
}

function uuidOuNulo(v: string | null): string | null {
  return v && UUID.test(v) ? v : null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "dados" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const fuso = fusoUtilizavel(authz.org.timezone);
  const p = req.nextUrl.searchParams;
  const periodo = resolverPeriodo(periodoDosParametros(p), diaNoFuso(new Date(), fuso));
  const limites = periodo ? periodoNoFuso(periodo.de, periodo.ate, fuso) : null;
  const pipelineId = uuidOuNulo(p.get("pipeline_id"));
  const marcouPedido = p.get("marcou");
  const filtros = {
    etapa: uuidOuNulo(p.get("etapa")),
    marcou: (["ia", "pessoa", "outro"] as const).includes(marcouPedido as QuemMarcou)
      ? (marcouPedido as QuemMarcou)
      : null,
    agente: uuidOuNulo(p.get("agente")),
    origem: p.get("origem")?.slice(0, 200) || null,
  };
  const supabase = await createClient();

  let q = supabase
    .from("crm_leads")
    .select(
      "id, title, pipeline_id, stage_id, lost_reason, closed_at, source, source_metadata, contact_id",
    )
    .eq("organization_id", orgId)
    .eq("status", "lost")
    .order("closed_at", { ascending: false })
    .limit(TETO);
  if (limites?.inicio) q = q.gte("closed_at", limites.inicio.toISOString());
  if (limites?.fimExclusivo) q = q.lt("closed_at", limites.fimExclusivo.toISOString());
  if (pipelineId) q = q.eq("pipeline_id", pipelineId);
  const { data: cards, error } = await q;
  if (error)
    return fail("internal_error", t("Não foi possível calcular os motivos de perda."), 500, {
      requestId,
    });
  const linhas = (cards ?? []) as unknown as LinhaDoCard[];
  const ids = linhas.map((l) => l.id);

  // As etapas (nome, e quais são de perda) e os funis, para os filtros.
  const [{ data: etapas }, { data: funis }, { data: agentes }] = await Promise.all([
    supabase
      .from("crm_stages")
      .select("id, name, pipeline_id, position, is_lost")
      .eq("organization_id", orgId)
      .order("position", { ascending: true }),
    supabase
      .from("crm_pipelines")
      .select("id, name, is_default")
      .eq("organization_id", orgId)
      .order("position"),
    supabase.from("ai_agents").select("id, name").eq("organization_id", orgId),
  ]);
  const etapasDaOrg = (etapas ?? []) as Array<{
    id: string;
    name: string;
    pipeline_id: string;
    position: number;
    is_lost: boolean;
  }>;
  const etapasDePerda = new Set(etapasDaOrg.filter((e) => e.is_lost).map((e) => e.id));

  // A linha do tempo que encerrou cada card: quem marcou e de onde saiu.
  const { data: atividades } = await buscaEmLotes<LinhaDaAtividade>(ids, (lote) =>
    supabase
      .from("crm_lead_activities")
      .select("lead_id, type, payload, actor_kind, actor_agent_id, performed_at")
      .eq("organization_id", orgId)
      .in("type", ["demand_closed", "stage_changed"])
      .in("lead_id", lote),
  );
  const porLead = new Map<string, LinhaDaAtividade[]>();
  for (const a of atividades ?? []) porLead.set(a.lead_id, [...(porLead.get(a.lead_id) ?? []), a]);

  // O agente que atendia o contato por último (para perda marcada por pessoa).
  const contatos = [...new Set(linhas.map((l) => l.contact_id).filter((c): c is string => !!c))];
  const { data: conversas } = await buscaEmLotes<{
    contact_id: string;
    active_ai_agent_id: string | null;
    last_message_at: string | null;
  }>(contatos, (lote) =>
    supabase
      .from("conversations")
      .select("contact_id, active_ai_agent_id, last_message_at")
      .eq("organization_id", orgId)
      .eq("is_group", false)
      .in("contact_id", lote),
  );
  const agenteDoContato = new Map<string, { agente: string | null; quando: string }>();
  for (const c of conversas ?? []) {
    const atual = agenteDoContato.get(c.contact_id);
    const quando = c.last_message_at ?? "";
    if (!atual || quando > atual.quando)
      agenteDoContato.set(c.contact_id, { agente: c.active_ai_agent_id, quando });
  }

  const perdas: PerdaNoPeriodo[] = linhas.map((l) => {
    const fechou = Date.parse(l.closed_at ?? "") || Number.MAX_SAFE_INTEGER;
    const encerramento = (porLead.get(l.id) ?? [])
      .filter((a) => {
        const pl = a.payload ?? {};
        const virouPerda =
          (a.type === "demand_closed" && pl.desfecho === "lost") ||
          (a.type === "stage_changed" && etapasDePerda.has(String(pl.to_stage_id ?? "")));
        return virouPerda && Date.parse(a.performed_at) <= fechou + FOLGA_MS;
      })
      .sort((a, b) => b.performed_at.localeCompare(a.performed_at))[0];
    const marcou = encerramento ? quemMarcou(encerramento.actor_kind) : "outro";
    const anuncio = l.source_metadata?.ad_id;
    return {
      id: l.id,
      titulo: l.title,
      pipeline_id: l.pipeline_id,
      motivo: l.lost_reason,
      perdido_em: l.closed_at ?? "",
      etapa_de_onde_saiu:
        typeof encerramento?.payload?.from_stage_id === "string"
          ? encerramento.payload.from_stage_id
          : null,
      marcou,
      agente_id:
        marcou === "ia" && encerramento?.actor_agent_id
          ? encerramento.actor_agent_id
          : l.contact_id
            ? (agenteDoContato.get(l.contact_id)?.agente ?? null)
            : null,
      origem: l.source,
      anuncio_id: typeof anuncio === "string" && anuncio.trim() ? anuncio.trim() : null,
    };
  });

  const filtradas = filtrarPerdas(perdas, filtros);
  const resultado = contarPorMotivo(filtradas);
  const etapasQueAparecem = new Set(perdas.map((x) => x.etapa_de_onde_saiu).filter(Boolean));
  const agentesQueAparecem = new Set(perdas.map((x) => x.agente_id).filter(Boolean));

  return ok(
    {
      periodo,
      truncado: linhas.length >= TETO,
      filtros,
      ...resultado,
      cards: filtradas.map((x) => ({
        id: x.id,
        titulo: x.titulo,
        pipeline_id: x.pipeline_id,
        motivo: x.motivo,
        perdido_em: x.perdido_em,
        // O dia da perda no fuso da organização (a tela não converte instantes).
        perdido_dia: x.perdido_em ? diaNoFuso(new Date(x.perdido_em), fuso) : "",
        etapa_de_onde_saiu: x.etapa_de_onde_saiu,
        marcou: x.marcou,
        agente_id: x.agente_id,
        origem: chaveDaOrigem(x),
      })),
      opcoes: {
        funis: (funis ?? []) as Array<{ id: string; name: string; is_default: boolean }>,
        etapas: etapasDaOrg
          .filter((e) => etapasQueAparecem.has(e.id))
          .map((e) => ({ id: e.id, nome: e.name, pipeline_id: e.pipeline_id })),
        agentes: ((agentes ?? []) as Array<{ id: string; name: string }>)
          .filter((a) => agentesQueAparecem.has(a.id))
          .map((a) => ({ id: a.id, nome: a.name })),
        origens: [...new Set(perdas.map(chaveDaOrigem))].sort(),
      },
    },
    { requestId },
  );
}
