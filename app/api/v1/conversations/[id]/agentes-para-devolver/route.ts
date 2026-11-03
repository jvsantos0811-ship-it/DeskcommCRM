/**
 * GET /api/v1/conversations/[id]/agentes-para-devolver
 *
 * PC-014: os agentes publicados do roteador do número desta conversa — para o
 * diálogo de "Devolver para a IA" escolher para qual agente a conversa volta.
 * Sem roteador ativo, a lista vem vazia e a devolução é o clique de sempre.
 *
 * Auth: cookie session, role >= viewer (leitura). Lê pelo cliente de serviço
 * porque os agentes e o roteador são da instalação da organização; todo filtro
 * usa a organização da sessão.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { agentesDoRoteadorDaConversa } from "@/lib/escalacao/devolucao-com-agente";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const roteador = await agentesDoRoteadorDaConversa(createAdminClient(), authz.org.orgId, id);
  return ok(
    {
      tem_roteador: roteador.roteadorId !== null && roteador.agentes.length > 0,
      agentes: roteador.agentes.map((a) => ({ id: a.id, nome: a.nome, intencao: a.intencao })),
    },
    { requestId },
  );
}
