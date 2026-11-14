/**
 * GET   /api/v1/ai/leitor — o cartão do Leitor da conversa na tela Provedores
 *       (PM-027 §8): a configuração que vale agora (a da organização, ou o
 *       modelo padrão da instalação para quem o segue), os modelos com preço,
 *       custo estimado por mês, nota na bateria e de onde vem a chave (gerente+).
 * PATCH /api/v1/ai/leitor — a escolha da organização (admin), uma de quatro:
 *       - `padrao`: segue o modelo padrão da instalação (o valor de quem nunca
 *         mexeu — decisão do dono, 06/11: o Leitor liga sozinho em toda empresa);
 *       - `propria`: outro modelo APROVADO na bateria, com chave para ele — a da
 *         organização ou, sem ela, a da instalação; a reserva segue a mesma régua;
 *       - `desligado`: o padrão nunca religa sozinho quem desligou;
 *       - `claude` (PC-036): quem lê é a tarefa agendada do Claude, pela porta
 *         Ficha da agência; o CRM não chama modelo. Só o dono da instalação com
 *         escrita (`fn_is_platform_admin_full`, o mesmo que cria a chave da porta)
 *         escolhe, e só ele tira dela.
 *       Sem `escolha`, `ligado` vale como antes (true = própria, false =
 *       desligado); sem os dois, só os prefixos e o termo mudam. Grava
 *       `settings.leitor` (merge, sem apagar o alcance) e, na escolha própria, a
 *       escolha do ponto `leitor_da_conversa`; nas outras, desliga essa escolha
 *       (senão a leitura rodaria o modelo antigo e pararia por "modelo
 *       diferente"). Ligar marca `ligado_em`: nada anterior é lido (sem carga
 *       inicial, §3).
 *       `painel_pela_ficha` (Regra v2 + PC-037): o painel de Dados passa a contar
 *       pela ficha (régua v2) — desligado por padrão, só liga com o Leitor lendo.
 *       Ligar ou desligar refaz o retrato do dia na hora (origem `ficha`).
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
import { refazerRetratoDoDia } from "@/lib/dados/gerar-retrato";
import { conferirEscolha, dadosDoLeitor, type RecusaDoLeitor } from "@/lib/dados/leitor/leitor-da-org";
import { lerPadraoDoLeitor } from "@/lib/dados/leitor/padrao";
import { ultimaRodadaDoClaude } from "@/lib/dados/leitor/pelo-claude";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
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
  painel_pela_ficha: z.boolean().optional(),
});

const SEM_LEITURA_PARA_O_PAINEL = "Ligue o Leitor da conversa antes: sem leitura, o painel pela ficha mostraria todos como sem leitura.";

const MENSAGEM: Record<RecusaDoLeitor, string> = {
  sem_modelo: "Escolha um modelo e rode a bateria para ligar o Leitor.",
  modelo_nao_aprovado: "Este modelo não acertou 100% da bateria e não pode ser ligado.",
  sem_chave: "Nenhuma chave disponível para este provedor: cadastre em IA › Credenciais.",
  reserva_igual: "A reserva precisa ser um modelo diferente do principal.",
  reserva_nao_aprovada: "O modelo de reserva também precisa ter acertado 100% da bateria.",
};
const SEM_PADRAO = "A instalação ainda não tem um modelo padrão do Leitor. Escolha um modelo aprovado para esta empresa.";
const SO_O_DONO_E_O_CLAUDE = "Só o dono da instalação liga ou desliga a leitura pelo Claude.";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "leitor_da_conversa" });
  if (!authz.ok) return authz.response;
  try {
    const db = await createClient();
    const [{ data: dono }, { data: donoComEscrita }, padrao] = await Promise.all([
      db.rpc("fn_is_platform_admin"),
      db.rpc("fn_is_platform_admin_full"),
      lerPadraoDoLeitor(createAdminClient()),
    ]);
    const dados = await dadosDoLeitor(db, authz.org.orgId, { padrao });
    return ok(
      {
        ...dados,
        podeEditar: roleAtLeast(authz.org.role, "admin"),
        ehDonoDaPlataforma: dono === true,
        // PC-036: entrar e sair da leitura pelo Claude é do dono com escrita (o que cria a chave da porta Ficha).
        podeEscolherOClaude: donoComEscrita === true,
        rodadaDoClaude: dados.config.origem === "claude" ? await ultimaRodadaDoClaude(db, authz.org.orgId) : null,
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
  // PC-036: entrar na leitura pelo Claude ou sair dela é do dono da instalação.
  if (mudouAEscolha && (escolha === "claude" || antes.origem === "claude")) {
    const { data: dono } = await db.rpc("fn_is_platform_admin_full");
    if (dono !== true) {
      return fail("forbidden", t(SO_O_DONO_E_O_CLAUDE), 403, { requestId, details: { codigo: "so_o_dono" } });
    }
  }
  const modeloEscolhido = pedido.modelo === undefined ? dados.escolhaPropria.modelo : pedido.modelo;
  const reserva = pedido.reserva === undefined ? dados.escolhaPropria.reserva : pedido.reserva;
  if (escolha === "propria") {
    const recusa = conferirEscolha(dados, modeloEscolhido, reserva);
    if (recusa) return fail("validation_failed", t(MENSAGEM[recusa]), 422, { requestId, details: { codigo: recusa } });
  }
  if (escolha === "padrao" && mudouAEscolha && !padrao) {
    return fail("validation_failed", t(SEM_PADRAO), 422, { requestId, details: { codigo: "sem_padrao" } });
  }
  const painelPelaFicha = pedido.painel_pela_ficha ?? antes.painel_pela_ficha;
  if (pedido.painel_pela_ficha === true && escolha === "desligado") {
    return fail("validation_failed", t(SEM_LEITURA_PARA_O_PAINEL), 422, { requestId, details: { codigo: "sem_leitura" } });
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
    painel_pela_ficha: painelPelaFicha,
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
      antes: {
        escolha: antes.origem,
        ligado: antes.ligado,
        ligado_em: antes.ligado_em,
        modelo: antes.modelo,
        reserva: antes.reserva,
        painel_pela_ficha: antes.painel_pela_ficha,
      },
      depois: {
        escolha: novaEfetiva.origem,
        ligado: novaEfetiva.ligado,
        ligado_em: novaEfetiva.ligado_em,
        modelo: novaEfetiva.modelo,
        reserva: novaEfetiva.reserva,
        painel_pela_ficha: novaEfetiva.painel_pela_ficha,
      },
    },
  });

  // A régua do painel mudou: o retrato do dia é refeito na hora (depois das 06:00
  // e fora do lote de 5 minutos). Falhar aqui não desfaz a configuração; o cron
  // de hora em hora refaz o retrato que ficou na régua velha (`retratoPrecisaRefazer`).
  let painelRefeito = false;
  if (antes.painel_pela_ficha !== painelPelaFicha || (painelPelaFicha && mudouAEscolha)) {
    const r = await refazerRetratoDoDia(admin, orgId, {
      falhou: (e) =>
        logger.warn("[leitor] a régua do painel mudou e o retrato não foi refeito; o cron refaz", {
          requestId,
          organization_id: orgId,
          message: e instanceof Error ? e.message : String(e),
        }),
    });
    painelRefeito = r?.gravado === true;
  }
  return ok({ config: novaEfetiva, painel_refeito: painelRefeito }, { requestId });
}
