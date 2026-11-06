/**
 * GET   /api/v1/ai/leitor — o cartão do Leitor da conversa na tela Provedores
 *       (PM-027 §8): a configuração que vale agora (a da organização, ou o
 *       modelo padrão da instalação para quem o segue), os modelos com preço,
 *       custo estimado por mês, nota na bateria e de onde vem a chave (gerente+).
 * PATCH /api/v1/ai/leitor — a escolha da organização (admin), uma de três:
 *       - `padrao`: segue o modelo padrão da instalação (o valor de quem nunca
 *         mexeu — decisão do dono, 06/11: o Leitor liga sozinho em toda empresa);
 *       - `propria`: outro modelo APROVADO na bateria, com chave para ele — a da
 *         organização ou, sem ela, a da instalação; a reserva segue a mesma régua;
 *       - `desligado`: o padrão nunca religa sozinho quem desligou.
 *       Sem `escolha`, `ligado` vale como antes (true = própria, false =
 *       desligado); sem os dois, só os prefixos e o termo mudam. Grava
 *       `settings.leitor` (merge, sem apagar o alcance) e, na escolha própria, a
 *       escolha do ponto `leitor_da_conversa`; nas outras, desliga essa escolha
 *       (senão a leitura rodaria o modelo antigo e pararia por "modelo
 *       diferente"). Ligar marca `ligado_em`: nada anterior é lido (sem carga
 *       inicial, §3).
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
import { configDoLeitor, configEfetivaDoLeitor, ESCOLHAS_DO_LEITOR, type EscolhaDoLeitor } from "@/lib/dados/leitor/config";
import { conferirEscolha, dadosDoLeitor, type RecusaDoLeitor } from "@/lib/dados/leitor/leitor-da-org";
import { lerPadraoDoLeitor } from "@/lib/dados/leitor/padrao";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const modelo = z.object({ provider: z.string().trim().min(1).max(40), model_id: z.string().trim().min(1).max(120) });
const corpoSchema = z.strictObject({
  escolha: z.enum(ESCOLHAS_DO_LEITOR).optional(),
  ligado: z.boolean().optional(),
  modelo: modelo.nullable().optional(),
  reserva: modelo.nullable().optional(),
  prefixos_de_anuncio: z.array(z.string().trim().min(1).max(20)).max(20).optional(),
  termo_do_contrato: z.string().trim().min(1).max(40).optional(),
});

const MENSAGEM: Record<RecusaDoLeitor, string> = {
  sem_modelo: "Escolha um modelo e rode a bateria para ligar o Leitor.",
  modelo_nao_aprovado: "Este modelo não acertou 100% da bateria e não pode ser ligado.",
  sem_chave: "Nenhuma chave disponível para este provedor: cadastre em IA › Credenciais.",
  reserva_igual: "A reserva precisa ser um modelo diferente do principal.",
  reserva_nao_aprovada: "O modelo de reserva também precisa ter acertado 100% da bateria.",
};
const SEM_PADRAO = "A instalação ainda não tem um modelo padrão do Leitor. Escolha um modelo aprovado para esta empresa.";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "leitor_da_conversa" });
  if (!authz.ok) return authz.response;
  try {
    const db = await createClient();
    const [{ data: dono }, padrao] = await Promise.all([db.rpc("fn_is_platform_admin"), lerPadraoDoLeitor(createAdminClient())]);
    return ok(
      {
        ...(await dadosDoLeitor(db, authz.org.orgId, { padrao })),
        podeEditar: roleAtLeast(authz.org.role, "admin"),
        ehDonoDaPlataforma: dono === true,
      },
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
  const admin = createAdminClient();
  const padrao = await lerPadraoDoLeitor(admin);
  const dados = await dadosDoLeitor(db, orgId, { padrao });
  const antes = dados.config;
  const escolha: EscolhaDoLeitor =
    pedido.escolha ?? (pedido.ligado === undefined ? antes.origem : pedido.ligado ? "propria" : "desligado");
  const mudouAEscolha = escolha !== antes.origem;
  const modeloEscolhido = pedido.modelo === undefined ? dados.escolhaPropria.modelo : pedido.modelo;
  const reserva = pedido.reserva === undefined ? dados.escolhaPropria.reserva : pedido.reserva;
  if (escolha === "propria") {
    const recusa = conferirEscolha(dados, modeloEscolhido, reserva);
    if (recusa) return fail("validation_failed", t(MENSAGEM[recusa]), 422, { requestId, details: { codigo: recusa } });
  }
  if (escolha === "padrao" && mudouAEscolha && !padrao) {
    return fail("validation_failed", t(SEM_PADRAO), 422, { requestId, details: { codigo: "sem_padrao" } });
  }

  const { data: orgRow, error: eOrg } = await admin.from("organizations").select("settings, created_at").eq("id", orgId).maybeSingle();
  if (eOrg) return fail("internal_error", eOrg.message, 500, { requestId });
  const linha = orgRow as { settings?: Record<string, unknown>; created_at?: string | null } | null;
  const settings = (linha?.settings ?? {}) as Record<string, unknown>;
  const leitorAntes = (settings[CHAVE_DO_ALCANCE] && typeof settings[CHAVE_DO_ALCANCE] === "object" ? settings[CHAVE_DO_ALCANCE] : {}) as Record<string, unknown>;
  // O marco: quem já estava lendo continua do mesmo ponto; quem passa a ler começa agora.
  const marco = antes.ligado && antes.ligado_em ? antes.ligado_em : new Date().toISOString();
  const depois = {
    ...leitorAntes,
    escolha,
    ligado: escolha === "propria",
    ligado_em: escolha === "desligado" ? null : mudouAEscolha ? marco : (leitorAntes.ligado_em ?? (escolha === "propria" ? marco : null)),
    // O último modelo próprio fica guardado também quando a empresa segue o padrão ou desliga.
    modelo: modeloEscolhido ?? null,
    reserva: reserva ?? null,
    prefixos_de_anuncio: pedido.prefixos_de_anuncio ?? antes.prefixos_de_anuncio,
    termo_do_contrato: pedido.termo_do_contrato ?? antes.termo_do_contrato,
  };
  const { error: eUpd } = await admin
    .from("organizations")
    .update({ settings: { ...settings, [CHAVE_DO_ALCANCE]: depois } })
    .eq("id", orgId);
  if (eUpd) return fail("internal_error", eUpd.message, 500, { requestId });

  // A escolha do ponto na tela Provedores acompanha o modelo próprio, com a chave da
  // organização; sem ela, `credential_id` nulo e a leitura usa a chave da instalação.
  // Seguindo o padrão (ou desligado), a escolha própria do ponto fica desligada: a
  // leitura confere que roda O MODELO APROVADO, e uma escolha antiga a pararia.
  if (escolha === "propria" && modeloEscolhido) {
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
  } else if (mudouAEscolha) {
    const { error: eBind } = await admin
      .from("ai_purpose_bindings")
      .update({ is_enabled: false })
      .eq("organization_id", orgId)
      .eq("purpose", "leitor_da_conversa");
    if (eBind) return fail("internal_error", eBind.message, 500, { requestId });
  }

  const novaEfetiva = configEfetivaDoLeitor(configDoLeitor({ [CHAVE_DO_ALCANCE]: depois }), linha?.created_at ?? null, padrao);
  await audit({
    action: "settings.leitor_atualizado",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: {
      antes: { escolha: antes.origem, ligado: antes.ligado, ligado_em: antes.ligado_em, modelo: antes.modelo, reserva: antes.reserva },
      depois: {
        escolha: novaEfetiva.origem,
        ligado: novaEfetiva.ligado,
        ligado_em: novaEfetiva.ligado_em,
        modelo: novaEfetiva.modelo,
        reserva: novaEfetiva.reserva,
      },
    },
  });
  return ok({ config: novaEfetiva }, { requestId });
}
