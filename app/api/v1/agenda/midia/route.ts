import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * /api/v1/agenda/midia — o vídeo e as imagens do aquecimento da organização
 * (PC-052 parte 3). Ver `lib/agenda/midia-do-aquecimento.ts`.
 *
 *   GET    — URL assinada (1 h) do vídeo e de cada imagem, para a tela mostrar. Qualquer membro.
 *   POST   — multipart `tipo` (`video` | `imagem`) + `arquivo`. Manager ou acima.
 *            O vídeo substitui o anterior; a imagem entra no fim (até três).
 *   DELETE — `?tipo=video` ou `?tipo=imagem&indice=N`. Manager ou acima.
 *
 * O tipo do arquivo é FAREJADO pelos bytes; o bucket é privado e só o
 * service_role lê e grava (migration 9041). Organização sempre da sessão.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import {
  BUCKET_DA_MIDIA_DA_AGENDA,
  MAXIMO_DE_IMAGENS,
  TAMANHO_MAXIMO_DA_IMAGEM,
  TAMANHO_MAXIMO_DO_VIDEO,
  extensaoDaMidia,
  farejarMidiaDoAquecimento,
  lerMidiaDoAquecimento,
  midiaParaGravar,
  type MidiaDoAquecimento,
} from "@/lib/agenda/midia-do-aquecimento";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const RECURSO = "settings_agenda_midia";
const VALIDADE_SEGUNDOS = 3600;

/**
 * `null` quando a leitura FALHOU — e quem grava tem de parar aí. Tratar a falha
 * como `settings` vazio faria o update seguinte regravar o jsonb inteiro só com
 * a mídia, apagando toda a configuração da organização.
 */
async function lerConfiguracao(
  orgId: string,
): Promise<{ settings: Record<string, unknown>; midia: MidiaDoAquecimento } | null> {
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (error) {
    logger.error("[agenda/midia] leitura de organizations.settings falhou", { detail: error.message });
    return null;
  }
  const settings = ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<
    string,
    unknown
  >;
  return { settings, midia: lerMidiaDoAquecimento(settings, orgId) };
}

async function gravarMidia(orgId: string, settings: Record<string, unknown>, midia: MidiaDoAquecimento): Promise<boolean> {
  // Cliente admin: a RLS de `organizations` só deixa platform admin escrever.
  const { error } = await createAdminClient()
    .from("organizations")
    .update({ settings: { ...settings, midia_do_aquecimento: midiaParaGravar(midia) } })
    .eq("id", orgId);
  return !error;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;

  // Leitura que falhou degrada para "nada escolhido": a tela mostra vazio.
  const midia = (await lerConfiguracao(authz.org.orgId))?.midia ?? { video: null, imagens: [] };
  const assinar = async (caminho: string) =>
    (await createAdminClient().storage.from(BUCKET_DA_MIDIA_DA_AGENDA).createSignedUrl(caminho, VALIDADE_SEGUNDOS))
      .data?.signedUrl ?? null;
  return ok(
    {
      video: midia.video ? { url: await assinar(midia.video.caminho), bytes: midia.video.bytes } : null,
      imagens: await Promise.all(
        midia.imagens.map(async (i, indice) => ({ indice, url: await assinar(i.caminho), bytes: i.bytes })),
      ),
      maximo_de_imagens: MAXIMO_DE_IMAGENS,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  // Recusa pelo Content-Length declarado ANTES de bufferizar o corpo; o
  // `arquivo.size` abaixo continua sendo o check autoritativo.
  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > TAMANHO_MAXIMO_DO_VIDEO + 64 * 1024) {
    return fail("payload_too_large", t("O vídeo pode ter no máximo 16 MB."), 413, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const tipo = form?.get("tipo");
  const arquivo = form?.get("arquivo");
  if ((tipo !== "video" && tipo !== "imagem") || !(arquivo instanceof File)) {
    return fail("invalid_request", t("Escolha se é o vídeo ou uma imagem, e o arquivo."), 400, { requestId });
  }
  const teto = tipo === "video" ? TAMANHO_MAXIMO_DO_VIDEO : TAMANHO_MAXIMO_DA_IMAGEM;
  if (arquivo.size > teto) {
    return fail(
      "payload_too_large",
      tipo === "video" ? t("O vídeo pode ter no máximo 16 MB.") : t("A imagem pode ter no máximo 5 MB."),
      413,
      { requestId },
    );
  }
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  const tipoReal = farejarMidiaDoAquecimento(bytes);
  const coube = tipo === "video" ? tipoReal === "video/mp4" : tipoReal === "image/jpeg" || tipoReal === "image/png";
  if (!tipoReal || !coube) {
    return fail(
      "unsupported_media_type",
      tipo === "video" ? t("O vídeo precisa ser MP4.") : t("A imagem precisa ser JPG ou PNG."),
      415,
      { requestId },
    );
  }

  // Lê a configuração ANTES de subir: falhar aqui não deixa arquivo órfão.
  const atual = await lerConfiguracao(orgId);
  if (!atual) return fail("internal_error", t("Erro ao salvar a mídia."), 500, { requestId });
  if (tipo === "imagem" && atual.midia.imagens.length >= MAXIMO_DE_IMAGENS) {
    return fail("state_conflict", t("Já há três imagens. Remova uma para enviar outra."), 409, { requestId });
  }

  const caminho = `${orgId}/${tipo}-${randomUUID()}.${extensaoDaMidia(tipoReal)}`;
  const admin = createAdminClient();
  const { error: erroUp } = await admin.storage
    .from(BUCKET_DA_MIDIA_DA_AGENDA)
    .upload(caminho, Buffer.from(bytes), { contentType: tipoReal, upsert: false });
  if (erroUp) {
    logger.error("[agenda/midia] upload falhou", { detail: erroUp.message, requestId });
    return fail("internal_error", t("Erro ao subir a mídia."), 500, { requestId });
  }

  const novo = { caminho, mime: tipoReal, bytes: bytes.length };
  const anterior = tipo === "video" ? atual.midia.video : null;
  const proxima: MidiaDoAquecimento =
    tipo === "video"
      ? { ...atual.midia, video: novo }
      : { ...atual.midia, imagens: [...atual.midia.imagens, novo] };
  if (!(await gravarMidia(orgId, atual.settings, proxima))) {
    await admin.storage.from(BUCKET_DA_MIDIA_DA_AGENDA).remove([caminho]);
    return fail("internal_error", t("Erro ao salvar a mídia."), 500, { requestId });
  }
  // O arquivo anterior sai DEPOIS de o novo estar gravado: falhar aqui deixa um
  // órfão, nunca um aquecimento sem vídeo.
  if (anterior) await admin.storage.from(BUCKET_DA_MIDIA_DA_AGENDA).remove([anterior.caminho]);

  void audit({
    action: "agenda.midia_do_aquecimento_atualizada",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: { tipo, bytes: bytes.length, formato: tipoReal },
  });
  return ok({ tipo }, { requestId, status: 201 });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const params = new URL(req.url).searchParams;
  const tipo = params.get("tipo");
  const indice = Number(params.get("indice") ?? NaN);
  if (tipo !== "video" && !(tipo === "imagem" && Number.isInteger(indice) && indice >= 0)) {
    return fail("invalid_request", t("Diga o que remover: o vídeo ou qual imagem."), 400, { requestId });
  }

  const atual = await lerConfiguracao(orgId);
  if (!atual) return fail("internal_error", t("Erro ao salvar a mídia."), 500, { requestId });
  const alvo = tipo === "video" ? atual.midia.video : (atual.midia.imagens[indice] ?? null);
  if (!alvo) return fail("not_found", t("Essa mídia não existe mais."), 404, { requestId });
  const proxima: MidiaDoAquecimento =
    tipo === "video"
      ? { ...atual.midia, video: null }
      : { ...atual.midia, imagens: atual.midia.imagens.filter((_, i) => i !== indice) };
  if (!(await gravarMidia(orgId, atual.settings, proxima))) {
    return fail("internal_error", t("Erro ao salvar a mídia."), 500, { requestId });
  }
  await createAdminClient().storage.from(BUCKET_DA_MIDIA_DA_AGENDA).remove([alvo.caminho]);

  void audit({
    action: "agenda.midia_do_aquecimento_removida",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: { tipo },
  });
  return ok({ tipo }, { requestId });
}
