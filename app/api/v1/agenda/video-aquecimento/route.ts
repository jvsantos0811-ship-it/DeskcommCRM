/**
 * Vídeo de aquecimento da organização (PC-045, parte 2) — Configurações › Agenda.
 *
 * GET    — o vídeo atual (formato, tamanho, texto, data da troca) e um link
 *          assinado de 10 min para a prévia. Sem vídeo: `{ video: null }`.
 * POST   — envia ou TROCA o vídeo, em dois passos (link assinado de upload →
 *          o navegador sobe direto ao Storage → confirmar). mp4 ou 3gp até
 *          16 MB, conferidos no objeto que subiu; recusa com o motivo. O
 *          antigo sai do Storage.
 * PATCH  — troca só o texto que acompanha o vídeo.
 * DELETE — tira o vídeo: a confirmação volta a sair sozinha, como antes.
 *
 * Gerente ou acima (mesmo piso das outras regras da agenda); a organização vem
 * da sessão. Trocar vale para os próximos agendamentos; nada é reenviado.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  BUCKET_DO_VIDEO,
  cabecalhoDeMp4,
  caminhoDoVideo,
  conferirVideo,
  TEXTO_MAX,
  videoPertenceAOrg,
  type MimeDoVideo,
  type RecusaDoVideo,
} from "@/lib/agenda/video-aquecimento";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECURSO = "agenda_video_aquecimento";

interface Linha {
  storage_path: string;
  mime: string;
  bytes: number;
  texto: string | null;
  trocado_em: string;
}

async function lerLinha(orgId: string): Promise<Linha | null> {
  const { data, error } = await createAdminClient()
    .from("agenda_video_aquecimento")
    .select("storage_path, mime, bytes, texto, trocado_em")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`video_aquecimento: leitura falhou (${error.code ?? "sem_codigo"})`);
  return (data as Linha | null) ?? null;
}

async function apagarArquivo(caminho: string, orgId: string): Promise<void> {
  if (!videoPertenceAOrg(caminho, orgId)) return;
  const { error } = await createAdminClient().storage.from(BUCKET_DO_VIDEO).remove([caminho]);
  if (error) logger.warn("video_aquecimento.arquivo_antigo_nao_removido", { organization_id: orgId, motivo: error.message.slice(0, 120) });
}

export async function GET(): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  try {
    const linha = await lerLinha(authz.org.orgId);
    if (!linha) return ok({ video: null }, { requestId });
    const { data: assinado } = await createAdminClient()
      .storage.from(BUCKET_DO_VIDEO)
      .createSignedUrl(linha.storage_path, 600);
    return ok(
      {
        video: {
          mime: linha.mime,
          bytes: linha.bytes,
          texto: linha.texto,
          trocado_em: linha.trocado_em,
          previa_url: assinado?.signedUrl ?? null,
        },
      },
      { requestId },
    );
  } catch {
    return fail("internal_error", "Não foi possível ler o vídeo.", 500, { requestId });
  }
}

/** Os dois passos do envio: pedir o link assinado; confirmar o que subiu. */
const postSchema = z.discriminatedUnion("etapa", [
  z.strictObject({ etapa: z.literal("link"), mime: z.string().max(100), bytes: z.number().int().nonnegative() }),
  z.strictObject({ etapa: z.literal("confirmar"), caminho: z.string().max(300), texto: z.string().trim().max(TEXTO_MAX).default("") }),
]);

function recusa(motivo: RecusaDoVideo | "conteudo", requestId: string): NextResponse {
  const mensagem =
    motivo === "tamanho"
      ? "O vídeo passa de 16 MB, o limite do WhatsApp. Comprima e envie de novo."
      : motivo === "formato"
        ? "Formato não aceito: envie um vídeo .mp4."
        : motivo === "conteudo"
          ? "O arquivo não é um vídeo .mp4 de verdade (só a extensão foi trocada). Exporte o vídeo como .mp4 e envie de novo."
          : "O arquivo está vazio.";
  return fail("video_recusado", mensagem, 422, { requestId, details: { motivo } });
}

/** Os primeiros bytes do objeto, por link assinado com Range (sem baixar 16 MB). */
async function primeirosBytes(caminho: string): Promise<Uint8Array | null> {
  const { data } = await createAdminClient().storage.from(BUCKET_DO_VIDEO).createSignedUrl(caminho, 60);
  if (!data?.signedUrl) return null;
  try {
    const r = await fetch(data.signedUrl, { headers: { Range: "bytes=0-15" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer()).slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * POST em dois passos, porque o corpo de requisição do app tem teto de 10 MB e
 * o vídeo vai a 16 MB: (1) `etapa: "link"` confere formato e tamanho DECLARADOS
 * e devolve um link de upload assinado para `<org>/aquecimento/<uuid>.mp4`; o
 * navegador sobe o arquivo direto ao Storage; (2) `etapa: "confirmar"` confere
 * o objeto que REALMENTE subiu (tamanho, tipo e cabeçalho mp4), grava a linha e
 * tira o antigo. Recusa = o objeto sai do Storage e a tela mostra o motivo.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const corpo = postSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) return fail("validation_failed", "Pedido inválido.", 400, { requestId });
  const admin = createAdminClient();

  if (corpo.data.etapa === "link") {
    const motivo = conferirVideo({ type: corpo.data.mime, size: corpo.data.bytes });
    if (motivo) return recusa(motivo, requestId);
    const caminho = caminhoDoVideo(orgId, corpo.data.mime as MimeDoVideo);
    const { data, error } = await admin.storage.from(BUCKET_DO_VIDEO).createSignedUploadUrl(caminho);
    if (error || !data) return fail("internal_error", "Não foi possível preparar o envio do vídeo.", 500, { requestId });
    return ok({ caminho, token: data.token }, { requestId });
  }

  // etapa "confirmar": o caminho é desta organização e da pasta do aquecimento.
  const { caminho } = corpo.data;
  if (!videoPertenceAOrg(caminho, orgId)) return fail("forbidden", "Arquivo de outra organização.", 403, { requestId });
  const { data: info, error: erroInfo } = await admin.storage.from(BUCKET_DO_VIDEO).info(caminho);
  if (erroInfo || !info) return fail("not_found", "O vídeo não chegou ao armazenamento. Envie de novo.", 404, { requestId });
  const mime = (info.contentType ?? "").split(";")[0]!.trim();
  const bytes = Number(info.size ?? 0);
  const motivo = conferirVideo({ type: mime, size: bytes });
  const cabecalho = motivo ? null : await primeirosBytes(caminho);
  if (motivo || !cabecalho || !cabecalhoDeMp4(cabecalho)) {
    await apagarArquivo(caminho, orgId);
    return recusa(motivo ?? "conteudo", requestId);
  }
  const texto = corpo.data.texto;

  let antigo: Linha | null = null;
  try {
    antigo = await lerLinha(orgId);
  } catch {
    // segue: o antigo só não é removido do Storage
  }
  const { error } = await admin.from("agenda_video_aquecimento").upsert(
    {
      organization_id: orgId,
      storage_path: caminho,
      mime,
      bytes,
      texto: texto === "" ? null : texto,
      trocado_em: new Date().toISOString(),
      trocado_por: authz.user.id,
    },
    { onConflict: "organization_id" },
  );
  if (error) {
    await apagarArquivo(caminho, orgId);
    return fail("internal_error", "Não foi possível salvar o vídeo.", 500, { requestId });
  }
  if (antigo && antigo.storage_path !== caminho) await apagarArquivo(antigo.storage_path, orgId);

  void audit({
    action: "agenda.video_aquecimento_trocado",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: { mime, bytes, com_texto: texto !== "", trocou: antigo !== null },
  });
  return ok({ salvo: true }, { status: 201, requestId });
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const corpo = z.strictObject({ texto: z.string().trim().max(TEXTO_MAX) }).safeParse(await req.json().catch(() => null));
  if (!corpo.success) return fail("validation_failed", "Texto inválido (até 500 caracteres).", 400, { requestId });
  const { data, error } = await createAdminClient()
    .from("agenda_video_aquecimento")
    .update({ texto: corpo.data.texto === "" ? null : corpo.data.texto })
    .eq("organization_id", authz.org.orgId)
    .select("organization_id")
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível salvar o texto.", 500, { requestId });
  if (!data) return fail("not_found", "Envie o vídeo antes de escrever o texto.", 404, { requestId });
  void audit({
    action: "agenda.video_aquecimento_trocado",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { so_texto: true, com_texto: corpo.data.texto !== "" },
  });
  return ok({ salvo: true }, { requestId });
}

export async function DELETE(): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  let antigo: Linha | null;
  try {
    antigo = await lerLinha(orgId);
  } catch {
    return fail("internal_error", "Não foi possível ler o vídeo.", 500, { requestId });
  }
  if (!antigo) return ok({ removido: false }, { requestId });
  const { error } = await createAdminClient().from("agenda_video_aquecimento").delete().eq("organization_id", orgId);
  if (error) return fail("internal_error", "Não foi possível tirar o vídeo.", 500, { requestId });
  await apagarArquivo(antigo.storage_path, orgId);
  void audit({
    action: "agenda.video_aquecimento_removido",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: {},
  });
  return ok({ removido: true }, { requestId });
}
