/**
 * GET /api/v1/team-chat/rooms — as salas do chat interno de quem pergunta
 * (migration 9002): a geral e uma conversa direta com cada membro ativo, cada
 * uma com a última mensagem e quantas o usuário ainda não leu.
 *
 * É também a fonte do contador do menu (`total_nao_lidas`).
 *
 * As mensagens são lidas pelo client de RLS do USUÁRIO — a policy já restringe
 * a sala direta aos dois participantes. Só a lista de MEMBROS vem do admin,
 * filtrada pela organização da sessão.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { membrosAtivos } from "@/lib/team-chat/membros";
import { SALA_GERAL, salaDireta, type SalaResumo } from "@/lib/team-chat/salas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "team_chat" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const eu = authz.user.id;

  const membros = (await membrosAtivos(createAdminClient(), orgId)).filter((m) => m.user_id !== eu);
  const salas: Array<{ room: string; user_id: string | null; nome: string }> = [
    { room: SALA_GERAL, user_id: null, nome: t("Equipe toda") },
    ...membros.map((m) => ({ room: salaDireta(eu, m.user_id), user_id: m.user_id, nome: m.nome ?? t("Sem nome") })),
  ];

  const supabase = await createClient();
  const { data: leituras, error: erroLeitura } = await supabase
    .from("team_chat_reads")
    .select("room, last_read_at")
    .eq("organization_id", orgId)
    .eq("user_id", eu);
  if (erroLeitura) {
    return fail("internal_error", t("Não foi possível carregar o chat. Verifique se o banco está atualizado."), 500, {
      requestId,
    });
  }
  const lidoAte = new Map(
    ((leituras ?? []) as Array<{ room: string; last_read_at: string }>).map((l) => [l.room, l.last_read_at]),
  );

  const resumos: SalaResumo[] = await Promise.all(
    salas.map(async (s) => {
      const [ultima, naoLidas] = await Promise.all([
        supabase
          .from("team_chat_messages")
          .select("body, created_at, sender_name")
          .eq("organization_id", orgId)
          .eq("room", s.room)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        (() => {
          let q = supabase
            .from("team_chat_messages")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", orgId)
            .eq("room", s.room)
            // `neq` sozinho deixaria de fora quem saiu da equipe (remetente nulo).
            .or(`sender_user_id.is.null,sender_user_id.neq.${eu}`);
          const desde = lidoAte.get(s.room);
          if (desde) q = q.gt("created_at", desde);
          return q;
        })(),
      ]);
      return {
        ...s,
        nao_lidas: naoLidas.count ?? 0,
        ultima: (ultima.data as SalaResumo["ultima"]) ?? null,
      };
    }),
  );

  const total = resumos.reduce((soma, s) => soma + s.nao_lidas, 0);
  return ok({ salas: resumos, total_nao_lidas: total }, { requestId });
}
