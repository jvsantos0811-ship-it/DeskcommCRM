/**
 * GET /api/v1/contracts/[id]/arquivo[?via=assinada] — abre o PDF do contrato.
 *
 * Fork, migration 9008. O bucket `contratos` é privado e lido só pelo servidor:
 * esta rota confere a organização da sessão e devolve 302 para uma URL assinada
 * curta. `via=assinada` abre a via assinada que a equipe anexou.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { BUCKET_DOS_CONTRATOS } from "@/lib/contratos/arquivo";
import { carregarContrato } from "@/lib/contratos/servidor";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Curta de propósito: a URL vai para o navegador e não deve servir de link compartilhável. */
const VALIDADE_DA_URL_S = 300;

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_contracts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("not_found", t("Contrato não encontrado."), 404, { requestId });
  }

  const admin = createAdminClient();
  const contrato = await carregarContrato(admin, authz.org.orgId, id);
  if (!contrato) return fail("not_found", t("Contrato não encontrado."), 404, { requestId });

  const assinada = req.nextUrl.searchParams.get("via") === "assinada";
  const caminho = assinada ? contrato.assinado_path : contrato.arquivo_path;
  if (!caminho) {
    return fail(
      "not_found",
      assinada ? t("Este contrato não tem via assinada anexada.") : t("O arquivo deste contrato não existe mais."),
      404,
      { requestId },
    );
  }

  const { data, error } = await admin.storage.from(BUCKET_DOS_CONTRATOS).createSignedUrl(caminho, VALIDADE_DA_URL_S);
  if (error || !data?.signedUrl) {
    logger.error("contracts.sign_failed", { organizationId: authz.org.orgId, erro: error?.message ?? "sem_url" });
    return fail("internal_error", t("Não foi possível abrir o arquivo agora."), 500, { requestId });
  }
  const res = NextResponse.redirect(data.signedUrl, 302);
  res.headers.set("X-Request-Id", requestId);
  return res;
}
