/**
 * PATCH /api/v1/contratos/modelos/[id] — muda o modelo (gerente ou dono).
 * Mudar o TEXTO ou os campos obrigatórios sobe a versão e tira a aprovação do
 * advogado (`patchDoModelo`): o que ele aprovou foi aquele texto.
 *
 * PC-030, item 2.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { carregarModelo, modeloPatchSchema, patchDoModelo } from "@/lib/contratos/modelos-servidor";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "contrato_modelos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail("not_found", t("Modelo não encontrado."), 404, { requestId });

  const parsed = modeloPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Confira os campos do modelo."), 422, { requestId });

  const admin = createAdminClient();
  const atual = await carregarModelo(admin, authz.org.orgId, id);
  if (!atual) return fail("not_found", t("Modelo não encontrado."), 404, { requestId });

  const { patch, mudouOTexto } = patchDoModelo(atual, parsed.data);
  if (Object.keys(patch).length === 0) return ok(atual, { requestId });
  const { error } = await admin.from("contrato_modelos").update(patch).eq("organization_id", authz.org.orgId).eq("id", id);
  if (error) return fail("internal_error", t("Não consegui salvar o modelo. Tente de novo."), 500, { requestId });

  void audit({
    action: "contrato_modelo.atualizado",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "contrato_modelos",
    resourceId: id,
    requestId,
    metadata: {
      campos: Object.keys(patch),
      mudou_o_texto: mudouOTexto,
      versao_antes: atual.versao,
      versao_depois: (patch.versao as number | undefined) ?? atual.versao,
      perdeu_aprovacao: mudouOTexto && Boolean(atual.aprovado_em),
    },
  });
  return ok(await carregarModelo(admin, authz.org.orgId, id), { requestId });
}
