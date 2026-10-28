/**
 * GET  /api/v1/channel-sessions/[id]/importar-historico — a última importação
 *      do histórico desta conexão (progresso e relatório).
 * POST /api/v1/channel-sessions/[id]/importar-historico — pede a importação das
 *      conversas antigas que o provedor intermediado guardou (coexistência).
 *      Corpo: `{ pipeline_id, stage_id, triagem? }`.
 *
 * Fork, migration 9012. O POST só ENFILEIRA: quem trabalha é o cron
 * `importacao-de-historico`, em rodadas de 40 s, porque seis meses de caixa de
 * entrada não cabem num request. Nada do que a importação grava acorda IA,
 * automação ou follow-up (ver `lib/channels/zernio/importar-historico.ts`).
 *
 * Leitura: qualquer papel da organização. Pedido: `admin` (mexe no funil
 * inteiro de uma vez), e o suporte só-leitura não pede.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

const COLUNAS =
  "id, estado, pipeline_id, stage_id, triagem_ligada, contagens, falhas, criada_em, atualizada_em, concluida_em";

const corpo = z.object({
  pipeline_id: z.uuid(),
  stage_id: z.uuid(),
  triagem: z.boolean().optional().default(true),
});

/** A conexão é desta organização e é do canal intermediado de WhatsApp? */
async function conexaoDoProvedor(admin: ReturnType<typeof createAdminClient>, orgId: string, id: string) {
  const { data } = await admin
    .from("channel_sessions")
    .select("id, provider, zernio_account_id")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  return data as { id: string; provider: string; zernio_account_id: string | null } | null;
}

export async function GET(_req: NextRequest, { params }: Context): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId, resource: "importacoes_de_historico" });
  if (!auth.ok) return auth.response;
  const t = (texto: string) => traduzir(texto, auth.user.idioma);
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });

  const admin = createAdminClient();
  const conexao = await conexaoDoProvedor(admin, auth.org.orgId, id);
  if (!conexao) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });

  const { data } = await admin
    .from("importacoes_de_historico")
    .select(COLUNAS)
    .eq("organization_id", auth.org.orgId)
    .eq("channel_session_id", id)
    .order("criada_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  return ok(
    { disponivel: conexao.provider === "zernio" && Boolean(conexao.zernio_account_id), importacao: data ?? null },
    { requestId },
  );
}

export async function POST(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "importacoes_de_historico" });
  if (!auth.ok) return auth.response;
  const t = (texto: string) => traduzir(texto, auth.user.idioma);
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });

  const parsed = corpo.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Escolha o funil e a etapa onde os contatos antigos vão entrar."), 422, { requestId });
  }

  const admin = createAdminClient();
  const conexao = await conexaoDoProvedor(admin, auth.org.orgId, id);
  if (!conexao) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });
  if (conexao.provider !== "zernio" || !conexao.zernio_account_id) {
    return fail(
      "validation_failed",
      t("Só a conexão de WhatsApp pelo parceiro guarda o histórico antigo para importar."),
      422,
      { requestId },
    );
  }

  const { data: etapa } = await admin
    .from("crm_stages")
    .select("id")
    .eq("organization_id", auth.org.orgId)
    .eq("pipeline_id", parsed.data.pipeline_id)
    .eq("id", parsed.data.stage_id)
    .maybeSingle();
  if (!etapa) return fail("validation_failed", t("Essa etapa não é do funil escolhido."), 422, { requestId });

  const { data: criada, error } = await admin
    .from("importacoes_de_historico")
    .insert({
      organization_id: auth.org.orgId,
      channel_session_id: id,
      pipeline_id: parsed.data.pipeline_id,
      stage_id: parsed.data.stage_id,
      triagem_ligada: parsed.data.triagem,
      iniciada_por: auth.user.id,
    })
    .select(COLUNAS)
    .single();
  if (error?.code === "23505") {
    return fail("importacao_em_andamento", t("Já tem uma importação em andamento nesta conexão."), 409, { requestId });
  }
  if (error || !criada) return fail("internal_error", t("Não foi possível começar a importação."), 500, { requestId });

  void audit({
    action: "channel.history_import_started",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "importacao_de_historico",
    resourceId: (criada as { id: string }).id,
    requestId,
    metadata: {
      channel_session_id: id,
      pipeline_id: parsed.data.pipeline_id,
      stage_id: parsed.data.stage_id,
      triagem: parsed.data.triagem,
    },
  });
  return ok(criada, { requestId, status: 201 });
}
