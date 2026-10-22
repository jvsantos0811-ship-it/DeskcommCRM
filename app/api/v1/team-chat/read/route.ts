/**
 * POST /api/v1/team-chat/read — marca uma sala do chat interno como lida até
 * agora, para o usuário da sessão (migration 9002).
 *
 * Como o `mark-read` das conversas, NÃO audita: é estado de leitura de uma
 * pessoa, sem efeito sobre mais ninguém, e cada abertura de sala geraria uma
 * linha de auditoria sem informação.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { podeEntrar, salaValida } from "@/lib/team-chat/salas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const schema = z.object({ room: z.string().min(1).max(100) }).strict();

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "team_chat" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !salaValida(parsed.data.room) || !podeEntrar(parsed.data.room, authz.user.id)) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }

  const { error } = await createAdminClient()
    .from("team_chat_reads")
    .upsert(
      {
        organization_id: authz.org.orgId,
        user_id: authz.user.id,
        room: parsed.data.room,
        last_read_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,user_id,room" },
    );
  if (error) return fail("internal_error", t("Não foi possível marcar como lida."), 500, { requestId });
  return ok({ room: parsed.data.room }, { requestId });
}
