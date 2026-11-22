/**
 * Persistência da conexão com a plataforma de atendimento (ChatGuru, PC-047) —
 * do lado de dentro do seam.
 *
 * A rota e a tela não podem nomear o provider nem as colunas dele (invariante 1
 * de `docs/doctrine/restricao-de-canal.md`, vigiado por `lint:channels`); elas
 * falam em "a conta", "a chave", "o endereço". A leitura e a escrita moram aqui.
 *
 * Toda consulta leva `organization_id` À MÃO: o client é de service role e
 * ignora a RLS.
 *
 * ─── O segredo da entrada ───────────────────────────────────────────────────
 *
 * Nasce aleatório (32 bytes) na primeira conexão e vai cifrado para
 * `webhook_secret_encrypted`, a mesma coluna dos outros canais. Reconectar NÃO o
 * troca: mudar a chave da API não pode desligar o recebimento que já estava
 * configurado na plataforma. Trocar é ação própria (`trocarSegredoDaEntrada`).
 */
import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";

import { CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO } from "../capabilities";
import { reactivateChannelSession } from "../reactivate";
import { lerConfigDoAtendimentoExterno, type ConfigDoAtendimentoExterno } from "./config";

export interface SessaoDoAtendimentoExterno {
  id: string;
  servidor: string | null;
  accountId: string | null;
  phoneId: string | null;
  displayName: string | null;
  status: string | null;
  webhookPathToken: string | null;
  temChave: boolean;
  /** Cifrado; quem precisa do valor decifra no servidor. */
  segredoCifrado: string | null;
  config: ConfigDoAtendimentoExterno;
  archivedAt: string | null;
}

const COLUNAS =
  "id, chatguru_servidor, chatguru_account_id, chatguru_phone_id, chatguru_api_key_encrypted, chatguru_config, display_name, status, webhook_path_token, webhook_secret_encrypted, archived_at";

function paraSessao(row: Record<string, unknown> | null): SessaoDoAtendimentoExterno | null {
  if (!row) return null;
  return {
    id: row.id as string,
    servidor: (row.chatguru_servidor as string) ?? null,
    accountId: (row.chatguru_account_id as string) ?? null,
    phoneId: (row.chatguru_phone_id as string) ?? null,
    displayName: (row.display_name as string) ?? null,
    status: (row.status as string) ?? null,
    webhookPathToken: (row.webhook_path_token as string) ?? null,
    temChave: !!row.chatguru_api_key_encrypted,
    segredoCifrado: (row.webhook_secret_encrypted as string) ?? null,
    config: lerConfigDoAtendimentoExterno(row.chatguru_config),
    archivedAt: (row.archived_at as string) ?? null,
  };
}

/**
 * A conexão deste canal na organização — a ATIVA primeiro. Reconectar por cima
 * de uma arquivada traz a linha de volta, não cria outra ao lado dela.
 *
 * LANÇA quando a consulta falha: "não há conexão" e "não consegui perguntar"
 * levam a desfechos diferentes (conectar × tentar depois).
 */
export async function buscarSessaoDoAtendimentoExterno(
  admin: SupabaseClient,
  organizationId: string,
): Promise<SessaoDoAtendimentoExterno | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO)
    .order("archived_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`chatguru_session_lookup_failed: ${error.message}`);
  return paraSessao((data as Record<string, unknown>[] | null)?.[0] ?? null);
}

/** Um segredo novo, em texto, para cifrar e mostrar na tela. */
export function segredoNovo(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Grava (ou ressuscita) a conexão com a credencial colada na tela.
 *
 * `segredoCifradoNovo` só é usado numa conexão NOVA; numa reconexão o segredo
 * que já está configurado na plataforma continua valendo.
 */
export async function salvarSessaoDoAtendimentoExterno(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existente: SessaoDoAtendimentoExterno | null;
    servidor: string;
    accountId: string;
    phoneId: string;
    chaveCifrada: string;
    segredoCifradoNovo: string;
    displayName: string;
    userId: string;
    requestId: string;
  },
): Promise<{ error: string | null; channelSessionId: string | null }> {
  const linha = {
    organization_id: input.organizationId,
    provider: CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO,
    chatguru_servidor: input.servidor,
    chatguru_account_id: input.accountId,
    chatguru_phone_id: input.phoneId,
    chatguru_api_key_encrypted: input.chaveCifrada,
    display_name: input.displayName,
    // A plataforma não tem rota de "quem sou eu" para conferir a chave antes de
    // gravar: o primeiro envio é a prova, e uma recusa ali vira falha visível
    // na mensagem (`chatguru_<código>`).
    status: "WORKING",
  };

  if (input.existente) {
    const r = await reactivateChannelSession(
      admin,
      {
        organizationId: input.organizationId,
        channelSessionId: input.existente.id,
        archivedAt: input.existente.archivedAt,
      },
      linha,
      {
        userId: input.userId,
        requestId: input.requestId,
        metadata: { provider: CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO },
      },
    );
    return { error: r.error?.message ?? null, channelSessionId: input.existente.id };
  }

  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      ...linha,
      webhook_secret_encrypted: input.segredoCifradoNovo,
      // A IA do número nasce FECHADA, como em todo canal novo: ninguém recebe
      // resposta automática até o operador abrir o acesso na tela.
      metadata: metadataInicialDoCanal(),
    })
    .select("id")
    .maybeSingle();
  return {
    error: error?.message ?? null,
    channelSessionId: (data as { id: string } | null)?.id ?? null,
  };
}

/** Grava as escolhas do operador (já validadas e no formato de `configParaGravar`). */
export async function salvarConfigDoAtendimentoExterno(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; config: Record<string, unknown> },
): Promise<{ error: string | null }> {
  const { error } = await admin
    .from("channel_sessions")
    .update({ chatguru_config: input.config })
    .eq("organization_id", input.organizationId)
    .eq("id", input.channelSessionId)
    .eq("provider", CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO)
    .is("archived_at", null);
  return { error: error?.message ?? null };
}

/** Troca o segredo da entrada. O endereço antigo passa a responder 401 na hora. */
export async function trocarSegredoDaEntrada(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; segredoCifrado: string },
): Promise<{ error: string | null }> {
  const { error } = await admin
    .from("channel_sessions")
    .update({ webhook_secret_encrypted: input.segredoCifrado })
    .eq("organization_id", input.organizationId)
    .eq("id", input.channelSessionId)
    .eq("provider", CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO)
    .is("archived_at", null);
  return { error: error?.message ?? null };
}

/** O `phone_id` que ESTA sessão atende — para a guarda de conta da entrada. */
export async function phoneIdDaSessao(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("chatguru_phone_id")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .maybeSingle();
  if (error) throw new Error(`chatguru_refs_lookup_failed: ${error.message}`);
  return (data as { chatguru_phone_id?: string | null } | null)?.chatguru_phone_id ?? null;
}
