import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/tipos-de-lead — os tipos de lead da organização (v3, seção 1.1):
 *      os itens do catálogo com `tipo_de_lead = true`, com o valor médio por
 *      caso fechado e se o cliente confirmou esse valor.
 * POST /api/v1/tipos-de-lead — cadastra um tipo de lead (manager+).
 *
 * A escrita vai pelo cliente de serviço filtrando o `organization_id` da sessão
 * (nunca do corpo), depois de `requireSupportWrite` e `requireRole("manager")` —
 * a mesma régua da RLS de escrita do catálogo (`catalog_products_insert`, que
 * exige manager). Criar um tipo preenche, no banco, o valor dos negócios abertos
 * que já têm esse interesse e nenhum valor (gatilho da migration 9018).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  codigoDoTipoDeLead,
  COLUNAS_DO_TIPO_DE_LEAD,
  tipoDeLeadCreateSchema,
} from "@/lib/schemas/tipos-de-lead";
import { refazerRetratoPeloCatalogo } from "@/lib/dados/gerar-retrato";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("catalog_products")
    .select(COLUNAS_DO_TIPO_DE_LEAD)
    .eq("organization_id", authz.org.orgId)
    .eq("tipo_de_lead", true)
    .order("ativo", { ascending: false })
    .order("nome");
  if (error) return fail("internal_error", "Erro ao listar os tipos de lead.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = tipoDeLeadCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const admin = createAdminClient();
  const orgId = authz.org.orgId;
  // A moeda vem da organização, nunca do corpo — ver `moedaDaOrganizacao()`.
  const moeda = await moedaDaOrganizacao(admin, orgId);
  const { data, error } = await admin
    .from("catalog_products")
    .insert({
      organization_id: orgId,
      codigo: codigoDoTipoDeLead(parsed.data.nome),
      nome: parsed.data.nome,
      categoria: parsed.data.categoria ?? null,
      preco_cents: parsed.data.preco_cents,
      valor_confirmado: parsed.data.valor_confirmado,
      moeda,
      tipo_de_lead: true,
      // Tipo de lead não é mercadoria: sem estoque, para nunca sumir da busca
      // do agente por quantidade zero.
      controla_estoque: false,
      origem: "manual",
    })
    .select(COLUNAS_DO_TIPO_DE_LEAD)
    .single();

  if (error) {
    // 23505 = já existe um tipo de lead com este nome (ou um item com o mesmo
    // código) nesta organização.
    if (error.code === "23505") {
      return fail("conflict", t("Já existe um tipo de lead com esse nome."), 409, { requestId });
    }
    return fail("internal_error", "Erro ao salvar o tipo de lead.", 500, { requestId });
  }

  const criado = data as unknown as { id: string; preco_cents: number };
  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "tipo_de_lead.created",
    resourceType: "catalog_products",
    resourceId: criado.id,
    metadata: { preco_cents: criado.preco_cents, valor_confirmado: parsed.data.valor_confirmado },
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

  return ok(data, { requestId, status: 201 });
}
