import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH /api/v1/tipos-de-lead/:id — muda o nome, a categoria, o valor médio, o
 * "confirmado pelo cliente" ou desativa um tipo de lead (manager+).
 *
 * Mudar o valor médio atualiza, no banco, o valor dos negócios ABERTOS daquele
 * tipo cujo valor foi preenchido pela regra — nunca o digitado por pessoa
 * (gatilho `fn_tipo_de_lead_propaga_valor`, migration 9018). A auditoria guarda
 * o valor antes e depois; a mudança em cada negócio fica na linha do tempo dele.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { COLUNAS_DO_TIPO_DE_LEAD, tipoDeLeadPatchSchema } from "@/lib/schemas/tipos-de-lead";
import { refazerRetratoPeloCatalogo } from "@/lib/dados/gerar-retrato";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const parsed = tipoDeLeadPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  if (Object.keys(parsed.data).length === 0) {
    return fail("validation_failed", t("Nada para alterar."), 422, { requestId });
  }

  const admin = createAdminClient();
  const orgId = authz.org.orgId;
  const { data: antes } = await admin
    .from("catalog_products")
    .select("preco_cents")
    .eq("organization_id", orgId)
    .eq("id", id)
    .eq("tipo_de_lead", true)
    .maybeSingle();
  if (!antes) return fail("not_found", t("Tipo de lead não encontrado."), 404, { requestId });

  const { data, error } = await admin
    .from("catalog_products")
    .update(parsed.data)
    .eq("organization_id", orgId)
    .eq("id", id)
    .eq("tipo_de_lead", true)
    .select(COLUNAS_DO_TIPO_DE_LEAD)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", t("Já existe um tipo de lead com esse nome."), 409, { requestId });
    }
    return fail("internal_error", "Erro ao salvar o tipo de lead.", 500, { requestId });
  }
  if (!data) return fail("not_found", t("Tipo de lead não encontrado."), 404, { requestId });

  const depois = data as unknown as { preco_cents: number };
  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "tipo_de_lead.updated",
    resourceType: "catalog_products",
    resourceId: id,
    metadata: {
      fields: Object.keys(parsed.data),
      preco_cents: { antes: (antes as { preco_cents: number }).preco_cents, depois: depois.preco_cents },
    },
    requestId,
  });

  // v3 §7: a aba Dinheiro de Dados muda na hora — o retrato do dia é refeito
  // com o valor novo. Falhar aqui não desfaz o cadastro (a função nunca lança).
  await refazerRetratoPeloCatalogo(
    admin,
    orgId,
    (r) =>
      audit({
        organizationId: orgId,
        actorUserId: authz.user.id,
        action: "dados.retrato_gerado",
        resourceType: "crm_dados_retrato",
        metadata: { origem: "catalogo", dia: r.dia, leads: r.leads, apagados: r.apagados },
        requestId,
      }),
    (e) => logger.warn("dados: retrato não refeito depois do catálogo", { requestId, message: e instanceof Error ? e.message : String(e) }),
  );

  return ok(data, { requestId });
}
