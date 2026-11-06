/**
 * GET   /api/v1/ai/leitor — o cartão do Leitor da conversa na tela Provedores
 *       (PM-027 §8): a configuração, os modelos com preço, custo estimado por mês,
 *       nota na bateria e se há chave (gerente+).
 * PATCH /api/v1/ai/leitor — liga, desliga ou troca o modelo do Leitor (admin).
 *       Só liga com modelo APROVADO na bateria e com a chave do provedor na
 *       organização; a reserva segue a mesma régua. Grava `settings.leitor`
 *       (merge, sem apagar o alcance) e a escolha do ponto `leitor_da_conversa`.
 *       Ligar marca `ligado_em`: nada anterior é lido (sem carga inicial, §3).
 */
import { requireSupportWrite } from "@/lib/impersonate/support";

import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { CHAVE_DO_ALCANCE } from "@/lib/dados/alcance-do-leitor";
import { configDoLeitor } from "@/lib/dados/leitor/config";
import { conferirEscolha, dadosDoLeitor, type RecusaDoLeitor } from "@/lib/dados/leitor/leitor-da-org";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const modelo = z.object({ provider: z.string().trim().min(1).max(40), model_id: z.string().trim().min(1).max(120) });
const corpoSchema = z.strictObject({
  ligado: z.boolean(),
  modelo: modelo.nullable(),
  reserva: modelo.nullable().optional(),
  prefixos_de_anuncio: z.array(z.string().trim().min(1).max(20)).max(20).optional(),
  termo_do_contrato: z.string().trim().min(1).max(40).optional(),
});

const MENSAGEM: Record<RecusaDoLeitor, string> = {
  sem_modelo: "Escolha um modelo e rode a bateria para ligar o Leitor.",
  modelo_nao_aprovado: "Este modelo não acertou 100% da bateria e não pode ser ligado.",
  sem_chave: "Cadastre a chave deste provedor em IA › Credenciais antes de ligar.",
  reserva_igual: "A reserva precisa ser um modelo diferente do principal.",
  reserva_nao_aprovada: "O modelo de reserva também precisa ter acertado 100% da bateria.",
};

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "leitor_da_conversa" });
  if (!authz.ok) return authz.response;
  try {
    const db = await createClient();
    const { data: dono } = await db.rpc("fn_is_platform_admin");
    return ok(
      { ...(await dadosDoLeitor(db, authz.org.orgId)), podeEditar: roleAtLeast(authz.org.role, "admin"), ehDonoDaPlataforma: dono === true },
      { requestId },
    );
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "Query failed", 500, { requestId });
  }
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "leitor_da_conversa" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Pedido inválido."), 422, { requestId });
  const pedido = parsed.data;

  const db = await createClient();
  const dados = await dadosDoLeitor(db, orgId);
  const antes = dados.config;
  const modeloEscolhido = pedido.modelo ?? antes.modelo;
  const reserva = pedido.reserva === undefined ? antes.reserva : pedido.reserva;
  if (pedido.ligado) {
    const recusa = conferirEscolha(dados, modeloEscolhido, reserva);
    if (recusa) return fail("validation_failed", t(MENSAGEM[recusa]), 422, { requestId, details: { codigo: recusa } });
  }

  const admin = createAdminClient();
  const { data: orgRow, error: eOrg } = await admin.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  if (eOrg) return fail("internal_error", eOrg.message, 500, { requestId });
  const settings = ((orgRow as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const leitorAntes = (settings[CHAVE_DO_ALCANCE] && typeof settings[CHAVE_DO_ALCANCE] === "object" ? settings[CHAVE_DO_ALCANCE] : {}) as Record<string, unknown>;
  const depois = {
    ...leitorAntes,
    ligado: pedido.ligado,
    ligado_em: pedido.ligado ? (antes.ligado && antes.ligado_em ? antes.ligado_em : new Date().toISOString()) : null,
    modelo: modeloEscolhido,
    reserva: reserva ?? null,
    prefixos_de_anuncio: pedido.prefixos_de_anuncio ?? antes.prefixos_de_anuncio,
    termo_do_contrato: pedido.termo_do_contrato ?? antes.termo_do_contrato,
  };
  const { error: eUpd } = await admin
    .from("organizations")
    .update({ settings: { ...settings, [CHAVE_DO_ALCANCE]: depois } })
    .eq("id", orgId);
  if (eUpd) return fail("internal_error", eUpd.message, 500, { requestId });

  // A escolha do ponto na tela Provedores acompanha o modelo ligado, com a chave da organização.
  if (pedido.ligado && modeloEscolhido) {
    const { data: cred } = await admin
      .from("ai_provider_credentials")
      .select("id")
      .eq("organization_id", orgId)
      .eq("provider", modeloEscolhido.provider)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { error: eBind } = await admin.from("ai_purpose_bindings").upsert(
      {
        organization_id: orgId,
        purpose: "leitor_da_conversa",
        provider: modeloEscolhido.provider,
        model_id: modeloEscolhido.model_id,
        credential_id: (cred as { id?: string } | null)?.id ?? null,
        is_enabled: true,
      },
      { onConflict: "organization_id,purpose" },
    );
    if (eBind) return fail("internal_error", eBind.message, 500, { requestId });
  }

  await audit({
    action: "settings.leitor_atualizado",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: {
      antes: { ligado: antes.ligado, modelo: antes.modelo, reserva: antes.reserva },
      depois: { ligado: depois.ligado, modelo: depois.modelo, reserva: depois.reserva },
    },
  });
  return ok({ config: configDoLeitor({ [CHAVE_DO_ALCANCE]: depois }) }, { requestId });
}
