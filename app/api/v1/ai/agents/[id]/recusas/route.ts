/**
 * GET /api/v1/ai/agents/:id/recusas (manager+) — as recusas e os bloqueios
 * DESTE agente (migration 9010, PC-002b e PC-003).
 *
 * A aba Execuções lê `llm_calls`, que diz "o modelo foi chamado" — e nada
 * sobre o que o SISTEMA barrou depois: a mensagem inteira vetada por uma trava
 * (e a frase segura no lugar), a etapa recusada por campo vazio, o ganho
 * recusado. Esta rota é a segunda metade da aba. Mesmo papel da rota de
 * execuções (manager), leitura pelo client do usuário (RLS) e `organization_id`
 * explícito, como a convenção do repo pede.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUNAS =
  "id, tipo, agent_version_id, contact_id, lead_id, conversation_id, ferramenta, trava, codigo, " +
  "etapa_pedida, campos_faltantes, motivo, created_at";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("manager", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const bruto = Number(req.nextUrl.searchParams.get("limit") ?? "50");
  const limite = Number.isFinite(bruto) ? Math.min(Math.max(Math.trunc(bruto), 1), 200) : 50;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("recusas_da_ia")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .eq("agent_id", id)
    .order("created_at", { ascending: false })
    .limit(limite);
  if (error) return fail("internal_error", t("Erro ao listar as recusas."), 500, { requestId });

  return ok(data ?? [], { requestId });
}
