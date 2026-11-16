/**
 * Conexão de um canal por CREDENCIAL — do lado de dentro do seam.
 *
 * A tela e a rota não podem saber qual provider é (invariante 1 da doutrina),
 * mas precisam de três coisas concretas: como se chama o canal para o usuário,
 * quais campos pedir, e se a credencial que ele colou presta. As três moram
 * aqui, onde nomear o provider é permitido.
 *
 * ─── Validar ANTES de gravar ────────────────────────────────────────────────
 *
 * Mesma decisão da conexão oficial, pelo mesmo motivo: gravar primeiro e
 * descobrir depois é o que faz o operador achar que conectou e só entender que
 * não na primeira mensagem que não sai — com o lead do outro lado esperando.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "./archived";
import { CHANNEL_PROVIDER_ZERNIO } from "./capabilities";
import { zernioBaseUrl } from "./zernio/credentials";
import type { ChannelProvider } from "./types";

/**
 * O canal conectável por credencial nesta instalação.
 *
 * Exportado como valor para que rota e tela não escrevam a string — é o que o
 * `lint:channels` cobra, e o que faz um canal seguinte trocar uma linha aqui
 * em vez de dez espalhadas.
 */
export const PARTNER_CHANNEL_PROVIDER: ChannelProvider = CHANNEL_PROVIDER_ZERNIO;

/**
 * Como o canal se chama PARA O USUÁRIO.
 *
 * O nome comercial mora aqui e não na tela por causa do lint — mas a razão é
 * anterior a ele: quem instala reconhece a marca do serviço que contratou, e a
 * tela que diz "provedor parceiro" obriga a adivinhar. O rótulo é dado, não
 * decisão de quem desenha a tela.
 */
export const PARTNER_CHANNEL_LABEL = "Zernio";

/**
 * Endpoint base do parceiro — o que a tela mostra para o operador reaproveitar
 * em outro sistema. Não é segredo (endereço público do provedor); a credencial
 * continua sem voltar nunca.
 */
export function partnerEndpoint(): string {
  return zernioBaseUrl();
}

export interface PartnerCredentialsInput {
  accountId: string;
  apiKey: string;
}

export type PartnerValidation =
  | {
      ok: true;
      /** Número conectado, para a tela confirmar que é o esperado. */
      phoneNumber: string | null;
      displayName: string | null;
      /** Qualidade do número segundo a plataforma (GREEN/YELLOW/RED). */
      qualityRating: string | null;
    }
  | { ok: false; reason: string };

/**
 * A credencial presta, e a conta é mesmo de WhatsApp?
 *
 * Confere as DUAS coisas de propósito. Uma chave válida apontando para uma
 * conta de outra rede autentica bem e falha em todo envio — e o operador veria
 * "conectado" numa tela de WhatsApp que nunca manda nada.
 */
export async function validatePartnerCredentials(
  input: PartnerCredentialsInput,
): Promise<PartnerValidation> {
  const accountId = input.accountId.trim();
  const apiKey = input.apiKey.trim();
  if (!accountId || !apiKey) return { ok: false, reason: "Informe a conta e a chave." };

  let res: Response;
  try {
    // LISTA e não `GET /accounts/{id}`: medido contra a API, o endpoint por id
    // aceita só `PUT` e responde 405 ao GET — e um 405 tratado como "credencial
    // inválida" mandaria o operador trocar uma chave que estava certa. Pior: a
    // primeira versão deste teste "passava" nos casos de recusa porque TODOS
    // recebiam 405, verde afirmando uma validação que não acontecia.
    res = await fetch(`${zernioBaseUrl()}/v1/accounts`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    // Rede caída não é credencial errada, e dizer "chave inválida" mandaria o
    // operador trocar uma chave que estava certa.
    return { ok: false, reason: "Não foi possível falar com o provedor. Tente de novo." };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "Chave recusada pelo provedor." };
  }
  if (!res.ok) {
    return { ok: false, reason: `Provedor respondeu ${res.status}.` };
  }

  const json = (await res.json().catch(() => null)) as {
    accounts?: Record<string, unknown>[];
  } | null;
  const contas = Array.isArray(json?.accounts) ? json.accounts : [];
  const conta = contas.find((c) => String(c._id ?? c.id) === accountId) ?? null;

  if (!conta) {
    // O operador colou o id do PERFIL no campo CONTA (o provedor lista perfis
    // em outro endpoint): sem distinguir, o par certo vira "não encontrada".
    // Best-effort de propósito — se a consulta falhar, cai na mensagem do caso.
    if (await pareceIdDePerfil(apiKey, accountId)) {
      return { ok: false, reason: "Este id é de um PERFIL. Aqui vai o id da CONTA." };
    }
    if (contas.length === 0) {
      // Medido contra o provedor com chave válida: sem perfil a lista vem
      // `{"accounts":[]}` — a chave presta, mas não lista nada sozinha.
      return {
        ok: false,
        reason: "A chave não lista nenhuma conta. Confira o perfil e a conta no painel do provedor.",
      };
    }
    // A chave presta, mas não alcança esta conta. É diferente de chave inválida,
    // e a mensagem precisa dizer QUAL das duas para o operador saber o que
    // corrigir.
    return {
      ok: false,
      reason: "Conta fora do alcance desta chave. Confira se a conta pertence ao perfil desta chave.",
    };
  }

  if (conta.platform !== "whatsapp") {
    return {
      ok: false,
      reason: `Esta conta é de ${String(conta.platform ?? "outra rede")}, não de WhatsApp.`,
    };
  }

  const meta = (conta.metadata ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    phoneNumber: typeof meta.displayPhoneNumber === "string" ? meta.displayPhoneNumber : null,
    displayName: typeof conta.displayName === "string" ? conta.displayName : null,
    qualityRating: typeof meta.qualityRating === "string" ? meta.qualityRating : null,
  };
}

/**
 * O id colado é de um PERFIL, não de uma CONTA?
 *
 * Confere em `GET /v1/profiles` sem adivinhar a forma do provedor: só vale o
 * que a resposta prova (lista com o id). Qualquer falha — rede, status, corpo
 * inesperado — devolve `false` e quem responde é a mensagem do caso.
 */
async function pareceIdDePerfil(apiKey: string, accountId: string): Promise<boolean> {
  try {
    const res = await fetch(`${zernioBaseUrl()}/v1/profiles`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const json = (await res.json().catch(() => null)) as {
      profiles?: Record<string, unknown>[];
    } | null;
    const perfis = Array.isArray(json?.profiles) ? json.profiles : [];
    return perfis.some((p) => String(p._id ?? p.id) === accountId);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------

/**
 * As colunas da sessão carregam o nome do provider — e é assim que a migration
 * 0117/0118 as criou, porque o CHECK precisa saber qual exigir. Escrevê-las da
 * rota faria a rota nomear o canal, que é o que o `lint:channels` reprovou na
 * primeira versão dela.
 *
 * Então a leitura e a escrita moram aqui, e a rota fala em conceitos: "a conta",
 * "a chave", "o token do webhook".
 */
export interface PartnerSession {
  id: string;
  accountId: string | null;
  phoneNumber: string | null;
  displayName: string | null;
  status: string | null;
  webhookPathToken: string | null;
  hasApiKey: boolean;
  archivedAt: string | null;
  createdAt: string | null;
}

const COLUNAS =
  "id, zernio_account_id, phone_number, display_name, status, webhook_path_token, zernio_token_encrypted, created_at";

/**
 * Quantos números ATIVOS uma organização pode ter por este canal.
 *
 * Dois, e não "quantos o plano deixar": o caso que existe é o escritório com um
 * número para o tráfego pago e outro para a equipe (João, 16/11/2026). O limite
 * de números do PLANO continua valendo por cima deste — quem recusa é o gatilho
 * `trg_trava_canais_do_plano`, e a rota traduz a recusa.
 */
export const MAX_PARTNER_NUMBERS = 2;

function toPartnerSession(row: Record<string, unknown> | null): PartnerSession | null {
  if (!row) return null;
  return {
    id: row.id as string,
    accountId: (row.zernio_account_id as string) ?? null,
    phoneNumber: (row.phone_number as string) ?? null,
    displayName: (row.display_name as string) ?? null,
    status: (row.status as string) ?? null,
    webhookPathToken: (row.webhook_path_token as string) ?? null,
    hasApiKey: !!row.zernio_token_encrypted,
    archivedAt: (row.archived_at as string) ?? null,
    createdAt: (row.created_at as string) ?? null,
  };
}

/**
 * TODAS as conexões deste canal na organização — as excluídas inclusive, porque
 * reconectar por cima de uma excluída a ressuscita (ver `savePartnerSession`).
 *
 * Ordem: a mais antiga primeiro. É ela a "principal" (ver `escolherPrincipal`),
 * e a ordem estável é o que faz a tela mostrar os números sempre na mesma
 * sequência.
 */
export async function listPartnerSessions(
  admin: SupabaseClient,
  organizationId: string,
): Promise<PartnerSession[]> {
  const buscar = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", organizationId)
      .eq("provider", PARTNER_CHANNEL_PROVIDER)
      .order("created_at", { ascending: true });

  const { data, error } = await queryTolerantToMissingArchived(
    () => buscar(`${COLUNAS}, ${ARCHIVED_AT}`),
    () => buscar(COLUNAS),
  );
  // Falha de leitura NÃO é "nenhum número": tratada assim, um "Reconectar"
  // criaria uma linha nova em vez de atualizar a que existe.
  if (error) throw new Error("partner_sessions_lookup_failed");
  const bruto = data as unknown;
  const linhas: Record<string, unknown>[] = Array.isArray(bruto)
    ? (bruto as Record<string, unknown>[])
    : bruto
      ? [bruto as Record<string, unknown>]
      : [];
  return linhas
    .map((l) => toPartnerSession(l))
    .filter((s): s is PartnerSession => s !== null)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

/** As conexões que estão em uso (não excluídas), na ordem da lista. */
export function sessoesAtivas(sessoes: PartnerSession[]): PartnerSession[] {
  return sessoes.filter((s) => !s.archivedAt);
}

/**
 * A conexão "principal": a mais antiga em uso; sem nenhuma em uso, a excluída
 * mais recente (a que um "Reconectar" traria de volta).
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 *
 * Até 16/11/2026 a organização tinha UMA conexão deste canal, e todo caminho que
 * dizia "a conexão" lia com `maybeSingle()`. Com uma linha só, esta função
 * devolve exatamente essa linha — ativa ou excluída —, então quem tem um número
 * vê o mesmo de antes. Com duas, `maybeSingle()` devolvia NADA (PGRST116), e a
 * tela dizia "não conectado" para um número que estava recebendo.
 */
export function escolherPrincipal(sessoes: PartnerSession[]): PartnerSession | null {
  const ativas = sessoesAtivas(sessoes);
  if (ativas.length > 0) return ativas[0] ?? null;
  const excluidas = sessoes.filter((s) => s.archivedAt);
  return excluidas[excluidas.length - 1] ?? null;
}

export async function findPartnerSession(
  admin: SupabaseClient,
  organizationId: string,
): Promise<PartnerSession | null> {
  return escolherPrincipal(await listPartnerSessions(admin, organizationId));
}

/**
 * Uma conexão deste canal pelo id, SÓ se for desta organização e deste canal.
 * A organização vem da sessão de quem chama, nunca do corpo do pedido.
 */
export async function findPartnerSessionById(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<PartnerSession | null> {
  const sessoes = await listPartnerSessions(admin, organizationId);
  return sessoes.find((s) => s.id === channelSessionId) ?? null;
}

/**
 * Qual linha um envio de credencial grava: a pedida, a que já tem esta conta,
 * uma nova, ou a principal (o comportamento de antes).
 *
 * A ordem importa e cada degrau tem motivo:
 *   1. `channelSessionId` pedido → aquela, e só ela (Reconectar de um número).
 *   2. A conta já está gravada na organização → aquela linha. Sem isso, colar a
 *      conta do 2º número no formulário do 1º trocaria o 1º (o defeito que
 *      motivou esta mudança), e "Adicionar" com uma conta já conectada criaria
 *      uma segunda linha que o índice único recusaria.
 *   3. `novo` → linha nova, se couber no teto.
 *   4. Senão → a principal. Com um número só, é o mesmo de antes.
 */
export type AlvoDaCredencial =
  | { tipo: "existente"; sessao: PartnerSession }
  | { tipo: "nova" }
  | { tipo: "nao_encontrada" }
  | { tipo: "conta_em_outro_numero" }
  | { tipo: "teto"; maximo: number };

export function escolherAlvoDaCredencial(
  sessoes: PartnerSession[],
  pedido: { accountId: string; channelSessionId?: string | null; novo?: boolean },
): AlvoDaCredencial {
  const conta = pedido.accountId.trim();

  if (pedido.channelSessionId) {
    const pedida = sessoes.find((s) => s.id === pedido.channelSessionId);
    if (!pedida) return { tipo: "nao_encontrada" };
    // A conta colada já é de OUTRO número ativo desta organização: gravar
    // trocaria este número pelo outro (e o índice único recusaria). Melhor dizer.
    const outro = sessoes.find((s) => s.id !== pedida.id && !s.archivedAt && s.accountId === conta);
    return outro ? { tipo: "conta_em_outro_numero" } : { tipo: "existente", sessao: pedida };
  }

  const mesmaConta = sessoes.filter((s) => s.accountId === conta);
  if (mesmaConta.length > 0) {
    // Ativa antes de excluída; entre excluídas, a mais recente.
    const escolhida = mesmaConta.find((s) => !s.archivedAt) ?? mesmaConta[mesmaConta.length - 1];
    if (escolhida) return { tipo: "existente", sessao: escolhida };
  }

  if (pedido.novo) {
    if (sessoesAtivas(sessoes).length >= MAX_PARTNER_NUMBERS) {
      return { tipo: "teto", maximo: MAX_PARTNER_NUMBERS };
    }
    return { tipo: "nova" };
  }

  const principal = escolherPrincipal(sessoes);
  return principal ? { tipo: "existente", sessao: principal } : { tipo: "nova" };
}

/**
 * Grava (ou ressuscita) a sessão.
 *
 * `archived_at: null` sempre: reconectar por cima de um canal excluído precisa
 * trazê-lo de volta. Sem isso o update deixaria a coluna no lugar e o canal
 * "conectado" ficaria invisível para o webhook, o envio e os seletores — todos
 * filtrados por ela.
 */
export async function savePartnerSession(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existingId: string | null;
    accountId: string;
    apiKeyEncrypted: string;
    webhookPathToken: string;
    webhookSecretEncrypted: string;
    phoneNumber: string | null;
    displayName: string;
  },
): Promise<{
  error: string | null;
  id?: string | null;
  contaJaConectada?: boolean;
  telefoneJaConectado?: boolean;
}> {
  const linha = {
    organization_id: input.organizationId,
    provider: PARTNER_CHANNEL_PROVIDER,
    zernio_account_id: input.accountId,
    zernio_token_encrypted: input.apiKeyEncrypted,
    webhook_path_token: input.webhookPathToken,
    webhook_secret_encrypted: input.webhookSecretEncrypted,
    phone_number: input.phoneNumber,
    display_name: input.displayName,
    status: "WORKING",
    archived_at: null,
  };

  const { data, error } = input.existingId
    ? await admin.from("channel_sessions").update(linha).eq("id", input.existingId)
    : await admin
        .from("channel_sessions")
        .insert({ ...linha, metadata: metadataInicialDoCanal() })
        .select("id")
        .single();
  const id = input.existingId ?? ((data as { id?: string } | null)?.id ?? null);

  // A conta já é de um canal ATIVO (índice único da migration 0165) — de outra
  // organização, porque as desta a rota já resolveu antes. Dito em português,
  // em vez do texto cru do Postgres num 500.
  const duplicado = !!error && (error as { code?: string }).code === "23505";
  const contaJaConectada = duplicado && (error?.message ?? "").includes("zernio_account_id");
  // O mesmo TELEFONE já está ativo nesta organização por outro canal (o QR, por
  // exemplo): índice `channel_sessions_phone_per_org_unique` (migration 0107).
  const telefoneJaConectado = duplicado && (error?.message ?? "").includes("phone_per_org");
  return {
    error: error?.message ?? null,
    id,
    ...(contaJaConectada ? { contaJaConectada } : {}),
    ...(telefoneJaConectado ? { telefoneJaConectado } : {}),
  };
}
