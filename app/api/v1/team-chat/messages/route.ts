/**
 * GET/POST /api/v1/team-chat/messages — mensagens de UMA sala do chat interno
 * (migration 9002).
 *
 * - GET `?room=<sala>&before=<ISO>`: as 50 anteriores a `before` (ou as últimas),
 *   pelo client de RLS do usuário — quem não é da conversa direta recebe vazio,
 *   porque a policy não deixa a linha existir para ele.
 * - POST `{ room, body }`: envia. A sala é conferida aqui também (`podeEntrar`)
 *   e, na conversa direta, a outra pessoa precisa ser membro ATIVO da mesma
 *   organização — senão daria para abrir sala com um id qualquer. A escrita vai
 *   pelo admin, com `organization_id` da sessão; quem envia já fica com a sala
 *   lida até a própria mensagem.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { membrosAtivos } from "@/lib/team-chat/membros";
import {
  COLUNAS_DA_MENSAGEM,
  outroParticipante,
  podeEntrar,
  SALA_GERAL,
  salaValida,
  TEXTO_MAXIMO,
  type MensagemDaEquipe,
} from "@/lib/team-chat/salas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const LIMITE = 50;

const enviarSchema = z
  .object({
    room: z.string().min(1).max(100),
    body: z.string(),
  })
  .strict();

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "team_chat" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const room = req.nextUrl.searchParams.get("room") ?? "";
  const before = req.nextUrl.searchParams.get("before");
  if (!salaValida(room) || !podeEntrar(room, authz.user.id)) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }
  if (before && Number.isNaN(new Date(before).getTime())) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }

  const supabase = await createClient();
  let q = supabase
    .from("team_chat_messages")
    .select(COLUNAS_DA_MENSAGEM)
    .eq("organization_id", authz.org.orgId)
    .eq("room", room)
    .order("created_at", { ascending: false })
    .limit(LIMITE + 1);
  if (before) q = q.lt("created_at", new Date(before).toISOString());
  const { data, error } = await q;
  if (error) {
    return fail("internal_error", t("Não foi possível carregar o chat. Verifique se o banco está atualizado."), 500, {
      requestId,
    });
  }
  const linhas = (data ?? []) as MensagemDaEquipe[];
  const temMais = linhas.length > LIMITE;
  return ok(linhas.slice(0, LIMITE).reverse(), { requestId, meta: { has_more: temMais } });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "team_chat" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const eu = authz.user.id;

  const parsed = enviarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  const texto = parsed.data.body.trim();
  if (texto.length === 0) return fail("validation_failed", t("Escreva a mensagem antes de enviar."), 422, { requestId });
  if (texto.length > TEXTO_MAXIMO) {
    return fail("validation_failed", t("A mensagem ficou longa demais: divida em duas."), 422, { requestId });
  }
  const room = parsed.data.room;
  if (!salaValida(room) || !podeEntrar(room, eu)) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }

  const admin = createAdminClient();
  if (room !== SALA_GERAL) {
    const outro = outroParticipante(room, eu);
    const membros = await membrosAtivos(admin, orgId);
    if (!outro || !membros.some((m) => m.user_id === outro)) {
      return fail("not_found", t("Essa pessoa não faz mais parte da equipe."), 404, { requestId });
    }
  }

  const { data, error } = await admin
    .from("team_chat_messages")
    .insert({
      organization_id: orgId,
      room,
      sender_user_id: eu,
      sender_name: authz.user.full_name ?? null,
      body: texto,
    })
    .select(COLUNAS_DA_MENSAGEM)
    .maybeSingle();
  if (error || !data) {
    return fail("internal_error", t("Não foi possível enviar. Verifique se o banco está atualizado."), 500, {
      requestId,
    });
  }
  const mensagem = data as MensagemDaEquipe;

  await admin
    .from("team_chat_reads")
    .upsert(
      { organization_id: orgId, user_id: eu, room, last_read_at: mensagem.created_at },
      { onConflict: "organization_id,user_id,room" },
    );

  void audit({
    action: "team_chat.message_sent",
    actorUserId: eu,
    organizationId: orgId,
    resourceType: "team_chat_message",
    resourceId: mensagem.id,
    requestId,
    // O TEXTO não vai para a trilha: a auditoria registra que houve mensagem e
    // em que tipo de sala, nunca o que foi dito.
    metadata: { sala: room === SALA_GERAL ? "geral" : "direta" },
  });

  return ok(mensagem, { requestId, status: 201 });
}
