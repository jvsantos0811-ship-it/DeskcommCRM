/**
 * GET /api/v1/ai/passagens?dias=1|7|30
 *
 * PC-014: o painel de passagens entre agentes da Central — por dia, no fuso da
 * organização: passagens, de quem para quem, sem resposta do destino em 2 min,
 * laços (3ª passagem em 1 hora) e regra do roteador × ferramenta × equipe.
 * `tem_roteador` diz se a organização tem algum roteador ativo (sem ele, a tela
 * não mostra o painel).
 *
 * Auth: cookie session, role >= viewer. Leitura pela RLS do usuário.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { montarPainelDePassagens, type LinhaDaPassagem } from "@/lib/ai/passagens/painel";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { fusoDaOrganizacao } from "@/lib/propostas/data-no-fuso";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const DIAS_PERMITIDOS = new Set([1, 7, 30]);

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const pedido = Number(req.nextUrl.searchParams.get("dias") ?? "1");
  const dias = DIAS_PERMITIDOS.has(pedido) ? pedido : 1;

  const supabase = await createClient();
  const agora = new Date();
  // Um dia a mais de folga: o corte certo é o dia no fuso da organização.
  const desde = new Date(agora.getTime() - (dias + 1) * 86_400_000).toISOString();

  const [linhas, roteadores, fuso] = await Promise.all([
    supabase
      .from("passagens_entre_agentes")
      .select("de_agente_id, para_agente_id, origem, desfecho, created_at, destino_respondeu_em")
      .eq("organization_id", orgId)
      .gte("created_at", desde)
      .order("created_at", { ascending: true })
      .limit(5000),
    supabase.from("ai_routers").select("id").eq("organization_id", orgId).eq("is_active", true).limit(1),
    fusoDaOrganizacao(supabase, orgId),
  ]);
  if (linhas.error) {
    return fail("internal_error", t("Não foi possível ler as passagens."), 500, { requestId });
  }
  const dados = (linhas.data ?? []) as LinhaDaPassagem[];
  const ids = [
    ...new Set(dados.flatMap((l) => [l.de_agente_id, l.para_agente_id]).filter((x): x is string => x !== null)),
  ];
  const { data: agentes } =
    ids.length > 0
      ? await supabase.from("ai_agents").select("id, name").eq("organization_id", orgId).in("id", ids)
      : { data: [] as Array<{ id: string; name: string }> };
  const nomes = new Map(((agentes ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));

  const painel = montarPainelDePassagens(dados, {
    agora,
    fuso,
    dias,
    nomes,
    equipe: t("Equipe"),
    removido: t("Agente removido"),
  });
  return ok(
    {
      tem_roteador: (roteadores.data ?? []).length > 0,
      periodo_dias: dias,
      ...painel,
    },
    { requestId },
  );
}
