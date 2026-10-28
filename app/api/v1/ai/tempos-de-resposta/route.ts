/**
 * GET /api/v1/ai/tempos-de-resposta — o tempo de resposta da IA por turno
 * (PC-002, Fase 1, item 5).
 *
 * Filtros: `agente` (id do agente), `conversa` (id da conversa) e `dias`
 * (1–90, padrão 7). `formato=csv` devolve a planilha para baixar; sem ele,
 * JSON com as linhas e um resumo (mediana e pior caso da espera).
 *
 * Só horários e contagens, nunca conteúdo de mensagem. Leitura pelo client de
 * RLS do usuário (a organização vem da sessão); `viewer` basta, como as outras
 * leituras de métrica — o suporte somente leitura também abre.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { linhasParaCsv, resumirTempos, type TempoDeResposta } from "@/lib/ai/tempos-de-resposta";

export const dynamic = "force-dynamic";

const LIMITE = 2_000;

const filtrosSchema = z.object({
  agente: z.string().uuid().optional(),
  conversa: z.string().uuid().optional(),
  dias: z.coerce.number().int().min(1).max(90).default(7),
  formato: z.enum(["json", "csv"]).default("json"),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const sp = req.nextUrl.searchParams;
  const parsed = filtrosSchema.safeParse({
    agente: sp.get("agente") ?? undefined,
    conversa: sp.get("conversa") ?? undefined,
    dias: sp.get("dias") ?? undefined,
    formato: sp.get("formato") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_error", t("Filtro inválido: confira o agente, a conversa e os dias (1 a 90)."), 400, {
      requestId,
    });
  }
  const f = parsed.data;
  const desde = new Date(Date.now() - f.dias * 86_400_000).toISOString();

  const supabase = await createClient();
  let consulta = supabase
    .from("tempos_de_resposta_da_ia")
    .select(
      "created_at, conversation_id, agent_id, ultima_msg_cliente_em, primeira_bolha_em, espera_ms, mensagens_respondidas, bolhas_retidas, ferramentas_falharam",
    )
    .eq("organization_id", authz.org.orgId)
    .gte("created_at", desde)
    .order("created_at", { ascending: false })
    .limit(LIMITE);
  if (f.agente) consulta = consulta.eq("agent_id", f.agente);
  if (f.conversa) consulta = consulta.eq("conversation_id", f.conversa);
  const { data, error } = await consulta;
  if (error) {
    return fail("internal_error", t("Não foi possível carregar os tempos de resposta da IA."), 500, { requestId });
  }
  const linhas = (data ?? []) as TempoDeResposta[];

  if (f.formato === "csv") {
    return new Response(linhasParaCsv(linhas, t), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="tempos-de-resposta-da-ia.csv"`,
        "X-Request-Id": requestId,
      },
    });
  }
  return ok({ linhas, resumo: resumirTempos(linhas) }, { requestId });
}
