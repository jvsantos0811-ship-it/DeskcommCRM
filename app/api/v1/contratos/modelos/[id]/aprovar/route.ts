/**
 * POST /api/v1/contratos/modelos/[id]/aprovar — registra "aprovado pelo
 * advogado em (data)" na versão ATUAL do modelo (gerente ou dono). Corpo:
 * `{ aprovado_por_nome }`, o nome do advogado que aprovou o texto.
 *
 * PC-030, item 2: "Cada modelo tem versão e a marca 'aprovado pelo advogado em
 * (data)'. Sem aprovação, a IA não usa."
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { aprovacaoSchema, carregarModelo } from "@/lib/contratos/modelos-servidor";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "contrato_modelos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail("not_found", t("Modelo não encontrado."), 404, { requestId });

  const parsed = aprovacaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Escreva o nome do advogado que aprovou o texto."), 422, { requestId });
  }
  const admin = createAdminClient();
  const atual = await carregarModelo(admin, authz.org.orgId, id);
  if (!atual) return fail("not_found", t("Modelo não encontrado."), 404, { requestId });

  // A aprovação vale para a versão que a tela mostrou: se o texto mudou no
  // meio, a versão gravada é outra e a aprovação não pode ir para ela às cegas.
  const { error } = await admin
    .from("contrato_modelos")
    .update({
      aprovado_em: new Date().toISOString(),
      aprovado_por_nome: parsed.data.aprovado_por_nome,
      aprovado_por_user_id: authz.user.id,
    })
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .eq("versao", atual.versao);
  if (error) return fail("internal_error", t("Não consegui registrar a aprovação. Tente de novo."), 500, { requestId });

  void audit({
    action: "contrato_modelo.aprovado",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "contrato_modelos",
    resourceId: id,
    requestId,
    metadata: { versao: atual.versao, aprovado_por_nome: parsed.data.aprovado_por_nome },
  });
  return ok(await carregarModelo(admin, authz.org.orgId, id), { requestId });
}
