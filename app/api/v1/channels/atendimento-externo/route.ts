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
 *
 * ─── Dois números (PC-053) ──────────────────────────────────────────────────
 *
 * A conta da plataforma pode ter o número oficial e o número por QR, e a IA
 * atende nos dois. Cada número é uma conexão própria — endereço de entrada,
 * segredo, configuração e acesso da IA dele —, até `MAXIMO_DE_NUMEROS`. O GET
 * devolve a lista em `conexoes`; os campos de cima continuam sendo os da
 * conexão principal (a mais antiga), e quem tem um número vê o de antes. POST e
 * PATCH dizem a qual conexão se referem por `channel_session_id`; sem ele, com
 * um número só, vale a única (o comportamento de antes), e com dois a rota
 * recusa em vez de adivinhar. "Usar a mesma chave" copia a chave CIFRADA de
 * outra conexão da mesma conta: o valor nunca volta à tela.
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
  USOS_FORA_DA_JANELA,
} from "@/lib/channels/atendimento-externo/config";
import {
  ATENDIMENTO_EXTERNO_LABEL,
  CHAVE_VALIDA,
  ID_DA_CONTA_VALIDO,
  SERVIDOR_VALIDO,
} from "@/lib/channels/atendimento-externo/credenciais";
import {
  MAXIMO_DE_NUMEROS,
  escolherAlvoDaConexao,
  escolherConexaoEmUso,
  listarSessoesDoAtendimentoExterno,
  principalDoAtendimento,
  salvarConfigDoAtendimentoExterno,
  salvarSessaoDoAtendimentoExterno,
  segredoNovo,
  sessoesAtivasDoAtendimento,
  trocarSegredoDaEntrada,
  type SessaoDoAtendimentoExterno,
} from "@/lib/channels/atendimento-externo/sessao";
import { traduzirLimiteDoPlano } from "@/lib/cobranca/limites";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECURSO = "channels_atendimento_externo";

const conectarSchema = z
  .object({
    servidor: z.string().trim().toLowerCase().regex(SERVIDOR_VALIDO),
    account_id: z.string().trim().regex(ID_DA_CONTA_VALIDO),
    phone_id: z.string().trim().regex(ID_DA_CONTA_VALIDO),
    /** Obrigatória, a não ser que `usar_chave_de` aponte outra conexão da mesma conta. */
    api_key: z.string().trim().regex(CHAVE_VALIDA).optional(),
    /** Como a equipe chama esta conexão; vazio = mantém o que já tem (ou a marca). */
    apelido: z.string().trim().min(1).max(80).optional(),
    /** Qual conexão esta credencial troca (PC-053). Sem ele: ver `escolherAlvoDaConexao`. */
    channel_session_id: z.string().uuid().optional(),
    /** "Adicionar outro número": nunca grava por cima de uma conexão em uso. */
    novo: z.boolean().optional(),
    /** Copia a chave CIFRADA desta conexão (mesma organização, mesma conta). */
    usar_chave_de: z.string().uuid().optional(),
  })
  .refine((d) => Boolean(d.api_key) || Boolean(d.usar_chave_de), { path: ["api_key"] })
  // "Adicionar" nunca grava por cima: pedir uma conexão existente E um número
  // novo ao mesmo tempo é contraditório, e o pedido explícito venceria.
  .refine((d) => !(d.novo && d.channel_session_id), { path: ["novo"] });

const alvoDoPatchSchema = z.object({ channel_session_id: z.string().uuid().optional() });

const patchSchema = z.union([
  z.object({ trocar_segredo: z.literal(true) }),
  z.object({ config: configDoAtendimentoExternoEntrada }),
]);

async function estadoDaConexao(
  req: NextRequest,
  admin: ReturnType<typeof createAdminClient>,
  sessao: SessaoDoAtendimentoExterno,
) {
  const segredo = sessao.segredoCifrado ? await decryptWebhookSecret(admin, sessao.segredoCifrado) : null;
  return {
    channel_session_id: sessao.id,
    servidor: sessao.servidor,
    account_id: sessao.accountId,
    phone_id: sessao.phoneId,
    tem_chave: sessao.temChave,
    display_name: sessao.displayName,
    status: sessao.status,
    endereco_de_entrada:
      sessao.webhookPathToken && segredo
        ? `${basePublicaDaInstalacao(req)}/api/v1/webhooks/channel/${sessao.webhookPathToken}/${segredo}`
        : null,
    config: {
      dialogo_transferencia: sessao.config.dialogoTransferencia,
      campo_da_ia: sessao.config.campoDaIa
        ? { nome: sessao.config.campoDaIa.nome, valor_ao_passar: sessao.config.campoDaIa.valorAoPassar }
        : null,
      acoes: sessao.config.acoes.map((a) => ({
        chave: a.chave,
        nome: a.nome,
        dialogo_id: a.dialogoId,
        quando_usar: a.quandoUsar,
      })),
      // PC-058: o diálogo da equipe na plataforma cala a IA.
      valor_quando_equipe_assume: sessao.config.valorQuandoEquipeAssume,
      ia_so_sem_responsavel: sessao.config.iaSoSemResponsavel,
      variavel_quando_equipe_assume: sessao.config.variavelQuandoEquipeAssume,
      // PC-052 parte 3: diálogo por uso, fora da janela de 24 h — por número.
      roteiros_fora_da_janela: Object.fromEntries(
        USOS_FORA_DA_JANELA.map((uso) => [uso, sessao.config.roteirosForaDaJanela[uso] ?? null]),
      ),
    },
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  // Conectar um canal expõe a conta da empresa: decisão de dono.
  const authz = await requireRole("admin", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const sessoes = await listarSessoesDoAtendimentoExterno(admin, authz.org.orgId);
  const ativas = sessoesAtivasDoAtendimento(sessoes);
  const conexoes = await Promise.all(ativas.map((s) => estadoDaConexao(req, admin, s)));
  const principal = principalDoAtendimento(sessoes);
  const principalEmUso = principal && !principal.archivedAt ? principal : null;
  const ativaPrincipal = principalEmUso ? conexoes.find((c) => c.channel_session_id === principalEmUso.id) : null;

  return ok(
    {
      label: ATENDIMENTO_EXTERNO_LABEL,
      connected: conexoes.length > 0,
      // Os campos de cima são os da conexão principal: quem tem um número só
      // (todo mundo até o PC-053) lê exatamente o que lia antes.
      channel_session_id: ativaPrincipal?.channel_session_id ?? null,
      servidor: ativaPrincipal?.servidor ?? null,
      account_id: ativaPrincipal?.account_id ?? null,
      phone_id: ativaPrincipal?.phone_id ?? null,
      tem_chave: Boolean(ativaPrincipal?.tem_chave),
      display_name: principalEmUso?.displayName ?? null,
      status: ativaPrincipal?.status ?? null,
      endereco_de_entrada: ativaPrincipal?.endereco_de_entrada ?? null,
      config: ativaPrincipal?.config ?? null,
      conexoes,
      maximo_de_numeros: MAXIMO_DE_NUMEROS,
      pode_adicionar: conexoes.length > 0 && conexoes.length < MAXIMO_DE_NUMEROS,
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
  const sessoes = await listarSessoesDoAtendimentoExterno(admin, orgId);

  // A chave: a colada, ou a CIFRADA de outra conexão em uso desta organização
  // e da mesma conta (a chave da plataforma é da conta, não do número).
  let chaveCifrada: string | null = null;
  if (parsed.data.api_key) {
    chaveCifrada = await encryptWebhookSecret(admin, parsed.data.api_key);
  } else {
    const origem = sessoesAtivasDoAtendimento(sessoes).find((s) => s.id === parsed.data.usar_chave_de);
    if (
      !origem?.chaveCifrada ||
      origem.servidor !== parsed.data.servidor ||
      origem.accountId !== parsed.data.account_id
    ) {
      return fail(
        "invalid_request",
        t("Para usar a mesma chave, o servidor e o ID da conta têm de ser os do número já conectado. Senão, cole a chave."),
        422,
        { requestId },
      );
    }
    chaveCifrada = origem.chaveCifrada;
  }
  const segredoCifrado = await encryptWebhookSecret(admin, segredoNovo());
  if (!chaveCifrada || !segredoCifrado) {
    // Sem a cifra, gravar a chave em claro seria pior que recusar.
    return fail("invalid_request", t("cifra indisponível nesta instalação — a chave não foi gravada"), 422, {
      requestId,
    });
  }

  const alvo = escolherAlvoDaConexao(sessoes, {
    phoneId: parsed.data.phone_id,
    channelSessionId: parsed.data.channel_session_id ?? null,
    novo: parsed.data.novo ?? false,
  });
  if (alvo.tipo === "nao_encontrada") {
    return fail("not_found", t("Conexão não encontrada nesta empresa."), 404, { requestId });
  }
  if (alvo.tipo === "numero_em_outra_conexao" || alvo.tipo === "numero_ja_conectado") {
    return fail("state_conflict", t("Este número já está conectado nesta empresa."), 409, { requestId });
  }
  if (alvo.tipo === "numero_nao_informado") {
    return fail("invalid_request", t("Esta empresa tem dois números conectados: diga qual deles quer trocar."), 422, {
      requestId,
    });
  }
  if (alvo.tipo === "teto") {
    return fail(
      "state_conflict",
      t("Esta empresa já tem o máximo de números conectados neste canal."),
      409,
      { requestId, details: { maximo: alvo.maximo } },
    );
  }
  const existente = alvo.tipo === "existente" ? alvo.sessao : null;

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
      metadata: {
        canal: "atendimento_externo",
        etapa: existente ? "credencial_trocada" : "conexao",
        chave_reaproveitada: !parsed.data.api_key,
      },
    });
  }

  return ok({ connected: true, apelido: apelidoDaConexao, channel_session_id: channelSessionId }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const corpo = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(corpo);
  const alvoPedido = alvoDoPatchSchema.safeParse(corpo ?? {});
  if (!parsed.success || !alvoPedido.success) {
    const issues = [...(parsed.success ? [] : parsed.error.issues), ...(alvoPedido.success ? [] : alvoPedido.error.issues)];
    return fail("invalid_request", t("Confira os campos: algum valor está fora do formato."), 422, {
      requestId,
      details: { campos: issues.map((i) => i.path.join(".")) },
    });
  }

  const admin = createAdminClient();
  const escolha = escolherConexaoEmUso(
    await listarSessoesDoAtendimentoExterno(admin, orgId),
    alvoPedido.data.channel_session_id ?? null,
  );
  if ("motivo" in escolha) {
    if (escolha.motivo === "numero_nao_informado") {
      return fail("invalid_request", t("Esta empresa tem dois números conectados: diga qual deles quer configurar."), 422, {
        requestId,
      });
    }
    if (escolha.motivo === "nao_encontrada") {
      return fail("not_found", t("Conexão não encontrada nesta empresa."), 404, { requestId });
    }
    return fail("state_conflict", t("Conecte a conta antes de configurar."), 409, { requestId });
  }
  const sessao = escolha.sessao;

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

  // A conexão atual entra para uma tela antiga não apagar os roteiros (PC-052 parte 3).
  const config = configParaGravar(parsed.data.config, sessao.config);
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
      equipe_assumiu_na_plataforma: config.valor_quando_equipe_assume !== null,
      ia_so_sem_responsavel: config.ia_so_sem_responsavel === true,
      equipe_assumiu_por_contexto: config.variavel_quando_equipe_assume !== null,
      roteiros_fora_da_janela: Object.values(
        (config.roteiros_fora_da_janela ?? {}) as Record<string, string | null>,
      ).filter((v) => v !== null).length,
    },
  });
  return ok({ salvo: true }, { requestId });
}
