import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/channels/atendimento-externo — estado da conexão + o endereço a colar na plataforma.
 * POST  /api/v1/channels/atendimento-externo — grava (ou troca) a credencial da conta.
 * PATCH /api/v1/channels/atendimento-externo — grava as escolhas (transferência, campo da IA,
 *                                              ações) ou troca o segredo da entrada.
 *
 * O canal em que a IA atende DENTRO da plataforma de atendimento que o
 * escritório já usa (PC-047). O caminho e o corpo não citam o provider: quem é,
 * como se chamam as colunas e como se fala com a API estão em
 * `lib/channels/atendimento-externo/` (`lint:channels`).
 *
 * ─── Desligado por padrão ───────────────────────────────────────────────────
 *
 * Sem uma conexão gravada aqui, nada muda na organização: não há token para a
 * entrada, nem credencial para o envio. E a IA do número nasce FECHADA, como em
 * todo canal novo — abrir é decisão do operador, na mesma tela.
 *
 * ─── O que nunca volta num GET ──────────────────────────────────────────────
 *
 * A chave da API. A tela sabe que existe, não qual é. O endereço da entrada
 * (com o segredo) volta, para o administrador colar no disparo da plataforma:
 * é o único jeito de ele chegar lá, e trocar é um clique (PATCH).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  configDoAtendimentoExternoEntrada,
  configParaGravar,
} from "@/lib/channels/atendimento-externo/config";
import {
  ATENDIMENTO_EXTERNO_LABEL,
  CHAVE_VALIDA,
  ID_DA_CONTA_VALIDO,
  SERVIDOR_VALIDO,
} from "@/lib/channels/atendimento-externo/credenciais";
import {
  buscarSessaoDoAtendimentoExterno,
  salvarConfigDoAtendimentoExterno,
  salvarSessaoDoAtendimentoExterno,
  segredoNovo,
  trocarSegredoDaEntrada,
} from "@/lib/channels/atendimento-externo/sessao";
import { traduzirLimiteDoPlano } from "@/lib/cobranca/limites";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECURSO = "channels_atendimento_externo";

const conectarSchema = z.object({
  servidor: z.string().trim().toLowerCase().regex(SERVIDOR_VALIDO),
  account_id: z.string().trim().regex(ID_DA_CONTA_VALIDO),
  phone_id: z.string().trim().regex(ID_DA_CONTA_VALIDO),
  api_key: z.string().trim().regex(CHAVE_VALIDA),
  /** Como a equipe chama esta conexão; vazio = mantém o que já tem (ou a marca). */
  apelido: z.string().trim().min(1).max(80).optional(),
});

const patchSchema = z.union([
  z.object({ trocar_segredo: z.literal(true) }),
  z.object({ config: configDoAtendimentoExternoEntrada }),
]);

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  // Conectar um canal expõe a conta da empresa: decisão de dono.
  const authz = await requireRole("admin", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const sessao = await buscarSessaoDoAtendimentoExterno(admin, authz.org.orgId);
  const ativa = sessao && !sessao.archivedAt ? sessao : null;
  const segredo = ativa?.segredoCifrado ? await decryptWebhookSecret(admin, ativa.segredoCifrado) : null;

  return ok(
    {
      label: ATENDIMENTO_EXTERNO_LABEL,
      connected: Boolean(ativa),
      channel_session_id: ativa?.id ?? null,
      servidor: ativa?.servidor ?? null,
      account_id: ativa?.accountId ?? null,
      phone_id: ativa?.phoneId ?? null,
      tem_chave: Boolean(ativa?.temChave),
      display_name: ativa?.displayName ?? null,
      status: ativa?.status ?? null,
      endereco_de_entrada:
        ativa?.webhookPathToken && segredo
          ? `${basePublicaDaInstalacao(req)}/api/v1/webhooks/channel/${ativa.webhookPathToken}/${segredo}`
          : null,
      config: ativa
        ? {
            dialogo_transferencia: ativa.config.dialogoTransferencia,
            campo_da_ia: ativa.config.campoDaIa
              ? { nome: ativa.config.campoDaIa.nome, valor_ao_passar: ativa.config.campoDaIa.valorAoPassar }
              : null,
            acoes: ativa.config.acoes.map((a) => ({
              chave: a.chave,
              nome: a.nome,
              dialogo_id: a.dialogoId,
              quando_usar: a.quandoUsar,
            })),
          }
        : null,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      "invalid_request",
      t("Confira o servidor, o ID da conta, o ID do número e a chave da API."),
      422,
      { requestId, details: { campos: parsed.error.issues.map((i) => i.path.join(".")) } },
    );
  }

  const admin = createAdminClient();
  const chaveCifrada = await encryptWebhookSecret(admin, parsed.data.api_key);
  const segredoCifrado = await encryptWebhookSecret(admin, segredoNovo());
  if (!chaveCifrada || !segredoCifrado) {
    // Sem a cifra, gravar a chave em claro seria pior que recusar.
    return fail("invalid_request", t("cifra indisponível nesta instalação — a chave não foi gravada"), 422, {
      requestId,
    });
  }

  const existente = await buscarSessaoDoAtendimentoExterno(admin, orgId);
  // O apelido só batiza a conexão; depois dela o nome é do operador (Renomear),
  // e trocar a credencial não o apaga.
  const apelidoDaConexao = parsed.data.apelido ?? (existente?.displayName ? existente.displayName : ATENDIMENTO_EXTERNO_LABEL);

  const { error, channelSessionId } = await salvarSessaoDoAtendimentoExterno(admin, {
    organizationId: orgId,
    existente,
    servidor: parsed.data.servidor,
    accountId: parsed.data.account_id,
    phoneId: parsed.data.phone_id,
    chaveCifrada,
    segredoCifradoNovo: segredoCifrado,
    displayName: apelidoDaConexao,
    userId: authz.user.id,
    requestId,
  });
  if (error) {
    const limite = traduzirLimiteDoPlano(error, authz.user.idioma);
    if (limite) return fail(limite.code, limite.message, 409, { requestId, details: limite.details });
    if (/duplicate key|23505/i.test(error)) {
      return fail(
        "state_conflict",
        t("Este número da plataforma já está conectado em outra empresa desta instalação."),
        409,
        { requestId },
      );
    }
    return fail("internal_error", error, 500, { requestId });
  }

  // A volta de um canal arquivado já é auditada por `reactivateChannelSession`.
  if (!existente?.archivedAt) {
    void audit({
      action: "channel.connected",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "channel_session",
      resourceId: channelSessionId,
      requestId,
      metadata: { canal: "atendimento_externo", etapa: existente ? "credencial_trocada" : "conexao" },
    });
  }

  return ok({ connected: true, apelido: apelidoDaConexao }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("Confira os campos: algum valor está fora do formato."), 422, {
      requestId,
      details: { campos: parsed.error.issues.map((i) => i.path.join(".")) },
    });
  }

  const admin = createAdminClient();
  const sessao = await buscarSessaoDoAtendimentoExterno(admin, orgId);
  if (!sessao || sessao.archivedAt) {
    return fail("state_conflict", t("Conecte a conta antes de configurar."), 409, { requestId });
  }

  if ("trocar_segredo" in parsed.data) {
    const cifrado = await encryptWebhookSecret(admin, segredoNovo());
    if (!cifrado) {
      return fail("invalid_request", t("cifra indisponível nesta instalação — a chave não foi gravada"), 422, {
        requestId,
      });
    }
    const { error } = await trocarSegredoDaEntrada(admin, {
      organizationId: orgId,
      channelSessionId: sessao.id,
      segredoCifrado: cifrado,
    });
    if (error) return fail("internal_error", error, 500, { requestId });
    void audit({
      action: "channel.connected",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "channel_session",
      resourceId: sessao.id,
      requestId,
      metadata: { canal: "atendimento_externo", etapa: "segredo_trocado" },
    });
    return ok({ segredo_trocado: true }, { requestId });
  }

  const config = configParaGravar(parsed.data.config);
  const { error } = await salvarConfigDoAtendimentoExterno(admin, {
    organizationId: orgId,
    channelSessionId: sessao.id,
    config,
  });
  if (error) return fail("internal_error", error, 500, { requestId });
  void audit({
    action: "channel.connected",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: sessao.id,
    requestId,
    metadata: {
      canal: "atendimento_externo",
      etapa: "configuracao",
      acoes: Array.isArray(config.acoes) ? config.acoes.length : 0,
      transferencia: config.dialogo_transferencia !== null,
      campo_da_ia: config.campo_da_ia !== null,
    },
  });
  return ok({ salvo: true }, { requestId });
}
