/**
 * Canal em que a IA atende DENTRO de outra plataforma de atendimento — hoje o
 * ChatGuru (PC-047). Credencial **por sessão**, colada pela tela.
 *
 * O nome da pasta não cita o fornecedor de propósito: a rota e a tela importam
 * daqui, e `lint:channels` recusa o nome do provider fora de `lib/channels/`.
 * Dentro da pasta o nome aparece à vontade — é o lado de dentro do seam.
 *
 * ─── A credencial ───────────────────────────────────────────────────────────
 *
 * A API v1 do ChatGuru pede quatro coisas em TODA chamada: o servidor da conta
 * (o `s7` de `s7.chatguru.app`), a `key`, o `account_id` e o `phone_id`. As
 * três primeiras ficam na linha da sessão (a key cifrada por `fn_encrypt_oauth`,
 * a mesma cifra dos outros parceiros); o `phone_id` é o `sessionRef`.
 *
 * A busca leva a ORGANIZAÇÃO junto (issue #236): `phone_id` é identificador do
 * PROVIDER, e `maybeSingle()` com duas linhas devolve `PGRST116`.
 *
 * ─── O host é fixo ──────────────────────────────────────────────────────────
 *
 * O operador escolhe só o SUBDOMÍNIO, e ele passa por `SERVIDOR_VALIDO` antes de
 * virar URL. Um campo livre de "endereço da API" faria o CRM postar a key para
 * onde quem preenchesse quisesse (SSRF com a credencial de brinde).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO } from "../capabilities";
import { lerConfigDoAtendimentoExterno, type ConfigDoAtendimentoExterno } from "./config";

/** Como o canal se chama PARA O USUÁRIO — a tela não pode escrever a marca. */
export const ATENDIMENTO_EXTERNO_LABEL = "ChatGuru";

/** Subdomínio da conta: `s7`, `s7`, `app2`… Letras minúsculas, dígitos e hífen. */
export const SERVIDOR_VALIDO = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/;

/** `account_id` e `phone_id` como a plataforma mostra na tela Celulares (hex ou dígitos). */
export const ID_DA_CONTA_VALIDO = /^[A-Za-z0-9_-]{4,64}$/;

/** A key: longa, sem espaço. O formato exato é da plataforma; aqui só barra lixo. */
export const CHAVE_VALIDA = /^[A-Za-z0-9_.:-]{16,200}$/;

/** Endereço da API v1 da conta. LANÇA para servidor fora do formato. */
export function urlDaApi(servidor: string): string {
  const s = servidor.trim().toLowerCase();
  if (!SERVIDOR_VALIDO.test(s)) throw new Error("chatguru_servidor_invalido");
  return `https://${s}.chatguru.app/api/v1`;
}

export interface CredenciaisDoAtendimentoExterno {
  /** A conexão (`channel_sessions.id`). */
  channelSessionId: string;
  servidor: string;
  accountId: string;
  phoneId: string;
  apiKey: string;
  config: ConfigDoAtendimentoExterno;
}

/**
 * Credencial gravada na sessão DESTA ORGANIZAÇÃO que atende este `phone_id`.
 *
 * `null` = não há key gravada ou ela não decifra (canal não conectado de
 * verdade). **LANÇA quando a consulta falha** — descartar o `error` foi metade
 * do defeito da issue #236.
 */
export async function resolverCredenciais(
  admin: SupabaseClient,
  busca: { organizationId: string; phoneId: string },
): Promise<CredenciaisDoAtendimentoExterno | null> {
  const { organizationId, phoneId } = busca;
  if (!organizationId || !phoneId) return null;

  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, chatguru_servidor, chatguru_account_id, chatguru_phone_id, chatguru_api_key_encrypted, chatguru_config")
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO)
      .eq("chatguru_phone_id", phoneId);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(
      `chatguru_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }
  const linha = data as {
    id: string;
    chatguru_servidor: string | null;
    chatguru_account_id: string | null;
    chatguru_phone_id: string;
    chatguru_api_key_encrypted: unknown;
    chatguru_config: unknown;
  } | null;
  if (!linha || !linha.chatguru_api_key_encrypted || !linha.chatguru_servidor || !linha.chatguru_account_id) {
    return null;
  }

  const apiKey = await decryptWebhookSecret(admin, linha.chatguru_api_key_encrypted as string);
  if (!apiKey) return null;

  return {
    channelSessionId: linha.id,
    servidor: linha.chatguru_servidor,
    accountId: linha.chatguru_account_id,
    phoneId: linha.chatguru_phone_id,
    apiKey,
    config: lerConfigDoAtendimentoExterno(linha.chatguru_config),
  };
}
