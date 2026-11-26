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
  createdAt: string | null;
  /**
   * A chave da API, CIFRADA. Só existe para "usar a mesma chave" ao adicionar o
   * segundo número da mesma conta (PC-053): copia-se o valor cifrado, sem
   * decifrar. Nunca vai para a tela nem para um GET.
   */
  chaveCifrada: string | null;
}

const COLUNAS =
  "id, chatguru_servidor, chatguru_account_id, chatguru_phone_id, chatguru_api_key_encrypted, chatguru_config, display_name, status, webhook_path_token, webhook_secret_encrypted, archived_at, created_at";

/**
 * Quantos números ATIVOS uma organização pode ter neste canal (PC-053).
 *
 * Dois: o caso que existe é o escritório com o número oficial (anúncios e
 * modelos da Meta) e o número por QR (grupos e enquete), a IA atendendo nos
 * dois (João, 25/11/2026). O limite de canais do PLANO continua valendo por
 * cima deste — quem recusa é o gatilho do plano, e a rota traduz a recusa.
 */
export const MAXIMO_DE_NUMEROS = 2;

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
    createdAt: (row.created_at as string) ?? null,
    chaveCifrada: (row.chatguru_api_key_encrypted as string) ?? null,
  };
}

/**
 * TODAS as conexões deste canal na organização — as desconectadas inclusive,
 * porque reconectar por cima de uma desconectada a traz de volta. Ordem: a mais
 * antiga primeiro; é ela a "principal", e a ordem estável faz a tela mostrar os
 * números sempre na mesma sequência.
 *
 * LANÇA quando a consulta falha: "não há conexão" e "não consegui perguntar"
 * levam a desfechos diferentes (conectar × tentar depois). Tratada como "nenhum
 * número", uma falha de leitura faria a troca da chave criar uma linha nova.
 */
export async function listarSessoesDoAtendimentoExterno(
  admin: SupabaseClient,
  organizationId: string,
): Promise<SessaoDoAtendimentoExterno[]> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`chatguru_session_lookup_failed: ${error.message}`);
  return ((data as Record<string, unknown>[] | null) ?? [])
    .map((l) => paraSessao(l))
    .filter((s): s is SessaoDoAtendimentoExterno => s !== null)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

/** As conexões em uso (não desconectadas), na ordem da lista. */
export function sessoesAtivasDoAtendimento(sessoes: SessaoDoAtendimentoExterno[]): SessaoDoAtendimentoExterno[] {
  return sessoes.filter((s) => !s.archivedAt);
}

/**
 * A conexão "principal": a mais antiga em uso; sem nenhuma em uso, a
 * desconectada criada por último (a que uma reconexão traria de volta).
 *
 * Com uma linha só — o caso de toda organização até o PC-053 — devolve
 * exatamente essa linha, ativa ou não: quem tem um número vê o mesmo de antes.
 */
export function principalDoAtendimento(sessoes: SessaoDoAtendimentoExterno[]): SessaoDoAtendimentoExterno | null {
  const ativas = sessoesAtivasDoAtendimento(sessoes);
  if (ativas.length > 0) return ativas[0] ?? null;
  const desconectadas = sessoes.filter((s) => s.archivedAt);
  return desconectadas[desconectadas.length - 1] ?? null;
}

/**
 * Quantas conexões deste canal estão EM USO na organização — para a guarda da
 * entrada (PC-053): com dois números, um corpo que não diga de qual número é
 * não pode ser atribuído a nenhum dos dois.
 *
 * LANÇA quando a consulta falha: "não sei" não vira "aceito".
 */
export async function contarConexoesAtivas(admin: SupabaseClient, organizationId: string): Promise<number> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO)
    .is("archived_at", null);
  if (error) throw new Error(`chatguru_session_count_failed: ${error.message}`);
  return Array.isArray(data) ? data.length : data ? 1 : 0;
}

/**
 * Qual linha uma credencial colada grava (PC-053). O número da plataforma
 * (`phone_id`) é o que identifica a conexão — o mesmo servidor, conta e chave
 * servem aos dois números.
 *
 * A ordem importa e cada degrau tem motivo:
 *   1. `channelSessionId` pedido → aquela, e só ela (trocar a credencial de um
 *      número). Se o número colado já é de OUTRA conexão em uso, recusa.
 *   2. O número já está em uso nesta organização → aquela linha (trocar a chave
 *      dele). Mas, se o pedido era "Adicionar", recusa: gravar por cima mudaria
 *      a conexão que já atende, e o operador achou que estava criando outra.
 *   3. O número é de uma conexão DESCONECTADA desta organização → ela volta
 *      (com as conversas e a configuração de antes).
 *   4. `novo` → linha nova.
 *   5. Sem dizer qual: com um (ou nenhum) número é a principal, como antes do
 *      PC-053; com dois, adivinhar trocaria um número em uso, então recusa.
 * Trazer de volta uma linha desconectada também ocupa vaga: passa pelo teto.
 */
export type AlvoDaConexao =
  | { tipo: "existente"; sessao: SessaoDoAtendimentoExterno }
  | { tipo: "nova" }
  | { tipo: "nao_encontrada" }
  | { tipo: "numero_em_outra_conexao" }
  | { tipo: "numero_ja_conectado" }
  | { tipo: "numero_nao_informado" }
  | { tipo: "teto"; maximo: number };

export function escolherAlvoDaConexao(
  sessoes: SessaoDoAtendimentoExterno[],
  pedido: { phoneId: string; channelSessionId?: string | null; novo?: boolean },
): AlvoDaConexao {
  const numero = pedido.phoneId.trim();
  const ativas = sessoesAtivasDoAtendimento(sessoes);
  const teto: AlvoDaConexao = { tipo: "teto", maximo: MAXIMO_DE_NUMEROS };
  const cabe = (alvo: SessaoDoAtendimentoExterno): AlvoDaConexao =>
    alvo.archivedAt && ativas.length >= MAXIMO_DE_NUMEROS ? teto : { tipo: "existente", sessao: alvo };

  if (pedido.channelSessionId) {
    const pedida = sessoes.find((s) => s.id === pedido.channelSessionId);
    if (!pedida) return { tipo: "nao_encontrada" };
    const outra = ativas.find((s) => s.id !== pedida.id && s.phoneId === numero);
    return outra ? { tipo: "numero_em_outra_conexao" } : cabe(pedida);
  }

  const mesmoNumero = sessoes.filter((s) => s.phoneId === numero);
  const ativaComONumero = mesmoNumero.find((s) => !s.archivedAt);
  if (ativaComONumero) {
    return pedido.novo ? { tipo: "numero_ja_conectado" } : { tipo: "existente", sessao: ativaComONumero };
  }
  const desconectada = mesmoNumero[mesmoNumero.length - 1];
  if (desconectada) return cabe(desconectada);

  if (pedido.novo) return ativas.length >= MAXIMO_DE_NUMEROS ? teto : { tipo: "nova" };

  if (ativas.length >= 2) return { tipo: "numero_nao_informado" };
  const principal = principalDoAtendimento(sessoes);
  return principal ? cabe(principal) : { tipo: "nova" };
}

/**
 * Qual conexão em uso uma configuração (ou a troca do endereço) atinge: a
 * pedida, se for desta organização e estiver em uso; sem pedido, a única em
 * uso. Com dois números e nenhum pedido, `null` + motivo — adivinhar gravaria
 * a configuração no número errado.
 */
export function escolherConexaoEmUso(
  sessoes: SessaoDoAtendimentoExterno[],
  channelSessionId: string | null | undefined,
): { sessao: SessaoDoAtendimentoExterno } | { motivo: "nenhuma" | "nao_encontrada" | "numero_nao_informado" } {
  const ativas = sessoesAtivasDoAtendimento(sessoes);
  if (channelSessionId) {
    const pedida = ativas.find((s) => s.id === channelSessionId);
    return pedida ? { sessao: pedida } : { motivo: "nao_encontrada" };
  }
  if (ativas.length === 0) return { motivo: "nenhuma" };
  const unica = ativas[0];
  if (ativas.length > 1 || !unica) return { motivo: ativas.length > 1 ? "numero_nao_informado" : "nenhuma" };
  return { sessao: unica };
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

/**
 * A conexão IRMÃ que atende este `phone_id`: mesma organização, mesma conta da
 * plataforma (servidor e conta iguais aos da conexão onde o POST chegou), ativa.
 *
 * Por que existe: a conta da plataforma tem UM chatbot para os dois números, e
 * o diálogo que entrega à IA tem UM endereço. Sem isto, o chat do segundo
 * número que cai no setor da IA era recusado como "evento de outra conta" e o
 * cliente ficava sem resposta. O segredo já provou a organização e a conta;
 * o `phone_id` só escolhe qual das conexões dela recebe.
 *
 * `null` = nenhuma irmã (outra conta, outra organização, arquivada, ou o
 * próprio número). LANÇA quando a consulta falha: "não sei" não vira "aceito".
 */
export async function conexaoIrmaDoNumero(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
  phoneId: string,
): Promise<string | null> {
  const { data: atual, error: e1 } = await admin
    .from("channel_sessions")
    .select("chatguru_servidor, chatguru_account_id")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .maybeSingle();
  if (e1) throw new Error(`chatguru_refs_lookup_failed: ${e1.message}`);
  const a = atual as { chatguru_servidor?: string | null; chatguru_account_id?: string | null } | null;
  if (!a?.chatguru_servidor || !a.chatguru_account_id) return null;
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO)
    .eq("chatguru_servidor", a.chatguru_servidor)
    .eq("chatguru_account_id", a.chatguru_account_id)
    .eq("chatguru_phone_id", phoneId)
    .is("archived_at", null)
    .neq("id", channelSessionId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`chatguru_sibling_lookup_failed: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}
