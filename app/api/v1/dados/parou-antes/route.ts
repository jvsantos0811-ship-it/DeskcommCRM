/**
 * GET /api/v1/dados/parou-antes — "PAROU ANTES DA QUALIFICAÇÃO" em Dados ›
 * Explorar › Medir (PC-025, item 3).
 *
 * Duas medidas sobre os cards do funil que ENTRARAM no período (dias do fuso
 * da organização): (a) "Só mandou a 1ª mensagem" e (b) "Conversou e parou antes
 * da qualificação", com a espera de `horas` (24, 48 ou 72) sem mensagem do
 * cliente. A regra mora em `lib/dados/parou-antes.ts`; os fatos vêm de
 * `fn_dados_ritmo_da_conversa` (migration 9029), que lê das mensagens só a
 * direção e o horário. Nenhuma IA é chamada; nada é escrito.
 *
 * Funil sem "Etapa marco de qualificação" (Configurações › Funis) devolve
 * `configurado: false` — a tela pede para configurar, em vez de adivinhar.
 *
 * Parâmetros: `pipeline_id` (sem ele, o funil padrão), `horas`, e o período do
 * painel (`periodo`, `de`, `ate`; sem período, desde o começo).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  classificarParouAntes,
  etapasForaDaMedida,
  HORAS_DA_MEDIDA,
  marcoDeQualificacao,
  type HorasDaMedida,
  type LinhaDoRitmo,
} from "@/lib/dados/parou-antes";
import { periodoDosParametros, resolverPeriodo } from "@/lib/dados/periodo";
import { diaNoFuso } from "@/lib/dados/retrato";
import { periodoNoFuso } from "@/lib/datas/periodo-no-fuso";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** "Desde o começo", quando não há período escolhido. */
const DESDE_SEMPRE = "2000-01-01T00:00:00Z";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "dados" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const fuso = fusoUtilizavel(authz.org.timezone);
  const p = req.nextUrl.searchParams;
  const agora = new Date();
  const periodo = resolverPeriodo(periodoDosParametros(p), diaNoFuso(agora, fuso));
  const limites = periodo ? periodoNoFuso(periodo.de, periodo.ate, fuso) : null;
  const horasPedidas = Number(p.get("horas") ?? 24);
  const horas: HorasDaMedida = (HORAS_DA_MEDIDA as readonly number[]).includes(horasPedidas)
    ? (horasPedidas as HorasDaMedida)
    : 24;
  const supabase = await createClient();

  const { data: funis, error: eFunis } = await supabase
    .from("crm_pipelines")
    .select("id, name, is_default, settings")
    .eq("organization_id", orgId)
    .order("position");
  if (eFunis)
    return fail("internal_error", t("Não foi possível calcular esta medida."), 500, { requestId });
  const listaDeFunis = (funis ?? []) as Array<{
    id: string;
    name: string;
    is_default: boolean;
    settings: unknown;
  }>;
  const pedido = p.get("pipeline_id");
  const funil =
    (pedido && UUID.test(pedido) ? listaDeFunis.find((f) => f.id === pedido) : null) ??
    listaDeFunis.find((f) => f.is_default) ??
    listaDeFunis[0] ??
    null;
  const opcoesDeFunis = listaDeFunis.map((f) => ({
    id: f.id,
    name: f.name,
    is_default: f.is_default,
  }));
  if (!funil) {
    return ok(
      { configurado: false, funil: null, funis: opcoesDeFunis, periodo, horas },
      { requestId },
    );
  }

  const { data: etapas } = await supabase
    .from("crm_stages")
    .select("id, name, position, is_won, is_lost, is_archived")
    .eq("organization_id", orgId)
    .eq("pipeline_id", funil.id)
    .order("position", { ascending: true });
  const etapasDoFunil = (etapas ?? []) as Array<{
    id: string;
    name: string;
    position: number;
    is_won: boolean;
    is_lost: boolean;
    is_archived: boolean;
  }>;
  const marcoId = marcoDeQualificacao(funil.settings);
  const marco = etapasDoFunil.find((e) => e.id === marcoId) ?? null;
  const fora = etapasForaDaMedida(funil.settings).filter((id) =>
    etapasDoFunil.some((e) => e.id === id),
  );
  const base = {
    funil: { id: funil.id, name: funil.name },
    funis: opcoesDeFunis,
    periodo,
    horas,
    marco: marco ? { id: marco.id, nome: marco.name } : null,
    fora: fora.map((id) => ({ id, nome: etapasDoFunil.find((e) => e.id === id)?.name ?? "" })),
    etapas: etapasDoFunil.map((e) => ({ id: e.id, nome: e.name })),
  };
  if (!marco) return ok({ configurado: false, ...base }, { requestId });

  const { data: ritmo, error } = await supabase.rpc("fn_dados_ritmo_da_conversa", {
    p_org: orgId,
    p_pipeline_id: funil.id,
    p_desde: limites?.inicio?.toISOString() ?? DESDE_SEMPRE,
    p_ate: limites?.fimExclusivo?.toISOString() ?? new Date(agora.getTime() + 60_000).toISOString(),
    p_posicao_do_marco: marco.position,
  });
  if (error)
    return fail("internal_error", t("Não foi possível calcular esta medida."), 500, { requestId });

  const resultado = classificarParouAntes((ritmo ?? []) as LinhaDoRitmo[], {
    agora,
    horas,
    fora: new Set(fora),
    diaDe: (iso) => diaNoFuso(new Date(iso), fuso),
  });

  const agentesUsados = [
    ...new Set(resultado.cards.map((c) => c.agente_id).filter((a): a is string => !!a)),
  ];
  const { data: agentes } = agentesUsados.length
    ? await supabase
        .from("ai_agents")
        .select("id, name")
        .eq("organization_id", orgId)
        .in("id", agentesUsados)
    : { data: [] };

  return ok(
    {
      configurado: true,
      ...base,
      agentes: ((agentes ?? []) as Array<{ id: string; name: string }>).map((a) => ({
        id: a.id,
        nome: a.name,
      })),
      ...resultado,
    },
    { requestId },
  );
}
