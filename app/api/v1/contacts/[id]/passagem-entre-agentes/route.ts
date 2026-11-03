/**
 * GET /api/v1/contacts/[id]/passagem-entre-agentes
 *
 * PC-014: a passagem mais recente entre agentes nas conversas deste contato —
 * o cartão que fica fixo no card do negócio (quem passou, para quem, quando e o
 * cartão: nome confirmado, quem fala, benefício, qualificação, urgência, o que
 * falta, próximo passo, jeito do cliente). Na devolução pela equipe, o cartão é
 * a linha que a pessoa escreveu.
 *
 * Auth: cookie session, role >= viewer. Leitura pela RLS do usuário (a tabela
 * só tem SELECT para quem está logado, e só da própria organização).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface Linha {
  id: string;
  origem: "ferramenta" | "roteador" | "equipe";
  cartao: string | null;
  motivo: string | null;
  created_at: string;
  de: { name: string } | null;
  para: { name: string } | null;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("passagens_entre_agentes")
    .select(
      "id, origem, cartao, motivo, created_at, " +
        "de:ai_agents!passagens_entre_agentes_de_agente_id_fkey(name), " +
        "para:ai_agents!passagens_entre_agentes_para_agente_id_fkey(name)",
    )
    .eq("organization_id", authz.org.orgId)
    .eq("contact_id", id)
    .eq("desfecho", "passou")
    .in("origem", ["ferramenta", "equipe"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    return fail("internal_error", t("Não foi possível ler a passagem desta conversa."), 500, { requestId });
  }
  const linha = ((data ?? []) as unknown as Linha[])[0] ?? null;
  return ok(
    linha === null
      ? null
      : {
          id: linha.id,
          origem: linha.origem,
          de: linha.de?.name ?? null,
          para: linha.para?.name ?? null,
          cartao: linha.cartao,
          motivo: linha.motivo,
          created_at: linha.created_at,
        },
    { requestId },
  );
}
