/**
 * GET /api/v1/contacts/[id]/registro-da-conversa
 *
 * PC-019: o registro da conversa deste contato para o card do negócio
 * ("Conversa até aqui") — o que a IA já perguntou e o cliente respondeu, o que
 * ficou sem resposta, as licenças dadas e o que foi prometido (pendente,
 * cumprida ou vencida). É o MESMO registro que todo agente lê no turno, com o
 * mesmo cálculo de status (`statusEfetivo`).
 *
 * Auth: cookie session, role >= viewer. Leitura pela RLS do usuário (a tabela
 * só tem SELECT para quem está logado, e só da própria organização).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import {
  itemDaLinha,
  statusEfetivo,
  type LinhaDoRegistro,
  type StatusEfetivo,
  type TipoDoItem,
} from "@/lib/agent-engine/agent/registro-da-conversa";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export interface ItemDoRegistroNaTela {
  id: string;
  tipo: TipoDoItem;
  tema: string;
  status: StatusEfetivo;
  resposta: string | null;
  prazo: string | null;
  vezes: number;
  quando: string;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const supabase = await createClient();
  const [itensRes, equipeRes] = await Promise.all([
    supabase
      .from("registro_da_conversa")
      .select(
        "id, tipo, tema, chave, status, pergunta, resposta, prazo, vezes, agent_id, conversation_id, job_id, criado_em, atualizado_em, resolvido_em",
      )
      .eq("organization_id", authz.org.orgId)
      .eq("contact_id", id)
      .order("atualizado_em", { ascending: false })
      .limit(200),
    supabase
      .from("messages")
      .select("created_at")
      .eq("organization_id", authz.org.orgId)
      .eq("contact_id", id)
      .eq("direction", "outbound")
      .in("sent_via", ["crm", "user", "external_device"])
      .neq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  if (itensRes.error) {
    return fail("internal_error", t("Não foi possível ler o registro desta conversa."), 500, { requestId });
  }
  const equipeFalouEm = equipeRes.data?.[0]?.created_at ? new Date(equipeRes.data[0].created_at as string) : null;
  const agora = new Date();
  const itens: ItemDoRegistroNaTela[] = ((itensRes.data ?? []) as LinhaDoRegistro[]).map((linha) => {
    const item = itemDaLinha(linha);
    return {
      id: linha.id,
      tipo: item.tipo,
      tema: item.tema,
      status: statusEfetivo(item, agora, equipeFalouEm),
      resposta: item.resposta,
      prazo: item.prazo ? item.prazo.toISOString() : null,
      vezes: item.vezes,
      quando: (item.resolvidoEm ?? item.atualizadoEm).toISOString(),
    };
  });
  return ok({ itens }, { requestId });
}
