/**
 * Adapter do canal em que a IA atende DENTRO do ChatGuru do escritório (PC-047).
 *
 * Burro de propósito, como os irmãos: traduz formato e nada mais. Janela,
 * horário e ritmo vivem na cadeia `before_send` (`docs/doctrine/restricao-de-canal.md`).
 *
 * ─── Para quem a mensagem vai ───────────────────────────────────────────────
 *
 * A API endereça o chat pelo `chat_number` — o número COMO A PLATAFORMA O TEM,
 * que pode não ter o nono dígito que o cadastro do CRM guarda. A entrada grava
 * esse número em `conversations.provider_conversation_id`, e o envio prefere
 * ele (`envelope.providerConversationId`) ao endereço derivado do contato.
 *
 * ─── O que a plataforma faz e o CRM pede ────────────────────────────────────
 *
 *  - `message_send` (texto) e `message_file_send` (mídia por URL);
 *  - na passagem para a equipe: `note_add` (o resumo), `chat_update_custom_fields`
 *    (desliga o campo que mantém o chat na IA) e `dialog_execute` (o diálogo de
 *    transferência que o operador escolheu na tela);
 *  - durante o turno, se o operador liberou: anotar e executar uma das ações.
 *
 * ─── Sem credencial, não envia ──────────────────────────────────────────────
 *
 * Credencial mora na SESSÃO; `isConfigured` responde `true` (é síncrono e não
 * tem como saber) e quem desiste é o `send`, que LANÇA `chatguru_not_configured`
 * — o handler traduz o prefixo para `queued`, em vez de fingir um envio.
 */
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { MAX_MEDIA_BYTES, MediaTooLargeError, type FetchedMedia } from "@/lib/messaging/media/types";
import { createAdminClient } from "@/lib/supabase/admin";

import { chamarApi } from "../atendimento-externo/api";
import {
  ATENDIMENTO_EXTERNO_LABEL,
  resolverCredenciais,
  type CredenciaisDoAtendimentoExterno,
} from "../atendimento-externo/credenciais";
import type {
  AcoesDoAtendimento,
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";

const NAO_CONFIGURADO = "chatguru_not_configured";

/** Anotação e resumo têm teto: a plataforma corta, e um texto enorme não ajuda ninguém. */
const TETO_DA_NOTA = 2_000;

async function credenciaisOuFalha(scope: ChannelTenantScope, phoneId: string): Promise<CredenciaisDoAtendimentoExterno> {
  const creds = await resolverCredenciais(createAdminClient(), {
    organizationId: scope.organizationId,
    phoneId,
  });
  if (!creds) throw new Error(`${NAO_CONFIGURADO}: nenhuma credencial gravada para esta conexão.`);
  return creds;
}

function soDigitos(v: string): string {
  return v.replace(/\D/g, "");
}

export const chatguruAdapter: ChannelAdapter = {
  provider: "chatguru",

  resolveRecipient(input: RecipientInput): string | null {
    // Grupo não entra por este canal (PC-047, "não fazer").
    if (input.isGroup) return null;
    if (!input.phoneNumber) return null;
    const digits = soDigitos(input.phoneNumber);
    return digits.length >= 10 ? digits : null;
  },

  isConfigured(): boolean {
    return true;
  },

  /**
   * A plataforma não tem rota de "estou de pé" nem de "quem sou eu": qualquer
   * chamada de teste poderia ser lida como recusa por motivo que não é a chave
   * (e abriria aviso falso na Central a cada rodada do vigia). O que dá para
   * afirmar sem mentir é se a credencial está gravada e decifra — sem ela a
   * conexão não envia nada, e isso é FAILED de verdade. Recusa da plataforma
   * aparece em cada mensagem (`chatguru_<código>`), onde o operador olha.
   */
  async checkHealth(input: ChannelTenantScope & { sessionRef: string }): Promise<ChannelHealth> {
    try {
      const creds = await resolverCredenciais(createAdminClient(), {
        organizationId: input.organizationId,
        phoneId: input.sessionRef,
      });
      return creds
        ? { reachable: true, status: "WORKING", detail: null }
        : { reachable: true, status: "FAILED", detail: "sem_credencial_para_a_conexao" };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "erro_desconhecido";
      return { reachable: false, status: null, detail: detail.slice(0, 200) };
    }
  },

  codes: {
    notConfigured: NAO_CONFIGURADO,
    sendFailed: "chatguru_error",
    unknownError: "chatguru_unknown",
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const creds = await credenciaisOuFalha(envelope, envelope.sessionRef);
    const chatNumber = soDigitos(envelope.providerConversationId ?? envelope.to);
    if (chatNumber.length < 10) throw new Error("chatguru_error: chat sem número para responder.");

    let acao: string;
    let parametros: Record<string, string>;
    if (envelope.media) {
      // A mídia já é uma URL assinada do nosso Storage; a plataforma baixa e
      // entrega. Legenda, quando há, vai junto.
      acao = "message_file_send";
      parametros = {
        chat_number: chatNumber,
        file_url: envelope.media.url,
        ...(envelope.media.caption || envelope.body ? { caption: (envelope.media.caption ?? envelope.body ?? "").slice(0, 1_000) } : {}),
      };
    } else if (envelope.kind === "text") {
      acao = "message_send";
      parametros = { chat_number: chatNumber, text: envelope.body ?? "" };
    } else {
      throw new Error(`chatguru_error: tipo ${envelope.kind} não é enviado por este canal.`);
    }

    await envelope.beforeSend?.();
    const r = await chamarApi(creds, acao, parametros);
    return { externalId: r.messageId };
  },

  /**
   * Baixa a mídia que o cliente mandou. A URL vem do POST da plataforma e é
   * pública (sem credencial nossa no pedido) — mesmo assim passa pelas duas
   * guardas de destino do repo: um POST com `http://169.254.169.254/...` não
   * pode fazer o servidor buscar metadado de nuvem.
   *
   * `redirect: "error"`: as guardas julgam só o PRIMEIRO endereço, e um link
   * que redirecionasse para a rede interna passaria por elas (os bytes iriam
   * para o Storage e apareceriam na Inbox). E há teto de tamanho, lido em
   * pedaços — o mesmo desenho do adapter social.
   */
  async fetchInboundMedia(input: ChannelTenantScope & {
    sessionRef: string;
    url: string;
    hintMime?: string | null;
  }): Promise<FetchedMedia> {
    assertSafeOutboundUrl(input.url);
    await assertDestinoResolvidoSeguro(new URL(input.url).hostname);
    const res = await fetch(input.url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`chatguru_media_failed: ${res.status} ${res.statusText}`.trim());
    if (Number(res.headers.get("content-length") ?? 0) > MAX_MEDIA_BYTES) {
      await res.body?.cancel();
      throw new MediaTooLargeError();
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("chatguru_media_failed: corpo vazio");
    const pedacos: Uint8Array[] = [];
    let tamanho = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        tamanho += value.byteLength;
        if (tamanho > MAX_MEDIA_BYTES) {
          await reader.cancel();
          throw new MediaTooLargeError();
        }
        pedacos.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    // PC-060: o armazenamento da plataforma pode servir o arquivo com um tipo
    // genérico; aí vale o tipo deduzido da mensagem (ex.: áudio → audio/ogg),
    // senão a transcrição recebe "audio.bin" e o Inbox não toca.
    const doServidor = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "";
    const generico = doServidor === "" || doServidor === "application/octet-stream" || doServidor === "binary/octet-stream";
    const mime = (generico ? input.hintMime : doServidor) || doServidor || "application/octet-stream";
    return { buffer: Buffer.concat(pedacos), mime };
  },

  async aoPassarParaAEquipe(input): Promise<void> {
    const creds = await credenciaisOuFalha(input, input.sessionRef);
    const chatNumber = soDigitos(input.recipient);
    const falhas: string[] = [];

    // Ordem: o RESUMO primeiro (quem abrir o chat lê o contexto), depois o campo
    // que mantém o chat na IA (a plataforma para de entregar), por fim o diálogo
    // de transferência (o chat vai para a fila da equipe). Uma falha não impede
    // as seguintes: cada uma é um pedaço útil sozinho.
    if (input.nota && input.nota.trim().length > 0) {
      try {
        await chamarApi(creds, "note_add", { chat_number: chatNumber, note_text: input.nota.slice(0, TETO_DA_NOTA) });
      } catch (err) {
        falhas.push(err instanceof Error ? err.message : "nota");
      }
    }
    if (creds.config.campoDaIa) {
      try {
        await chamarApi(creds, "chat_update_custom_fields", {
          chat_number: chatNumber,
          [`field__${creds.config.campoDaIa.nome}`]: creds.config.campoDaIa.valorAoPassar,
        });
      } catch (err) {
        falhas.push(err instanceof Error ? err.message : "campo");
      }
    }
    if (creds.config.dialogoTransferencia) {
      try {
        await chamarApi(creds, "dialog_execute", {
          chat_number: chatNumber,
          dialog_id: creds.config.dialogoTransferencia,
        });
      } catch (err) {
        falhas.push(err instanceof Error ? err.message : "dialogo");
      }
    }
    if (falhas.length > 0) throw new Error(falhas.join(" | ").slice(0, 400));
  },

  async acoesDoAtendimento(input): Promise<AcoesDoAtendimento | null> {
    const creds = await resolverCredenciais(createAdminClient(), {
      organizationId: input.organizationId,
      phoneId: input.sessionRef,
    });
    if (!creds) return null;
    const chatNumber = soDigitos(input.recipient);
    if (chatNumber.length < 10) return null;
    const acoes = creds.config.acoes;

    return {
      rotulo: ATENDIMENTO_EXTERNO_LABEL,
      acoes: acoes.map((a) => ({ chave: a.chave, nome: a.nome, quandoUsar: a.quandoUsar })),
      async anotar(texto: string): Promise<void> {
        await chamarApi(creds, "note_add", { chat_number: chatNumber, note_text: texto.slice(0, TETO_DA_NOTA) });
      },
      async executar(chave: string): Promise<void> {
        const acao = acoes.find((a) => a.chave === chave);
        if (!acao) throw new Error("chatguru_error: ação não liberada na tela.");
        await chamarApi(creds, "dialog_execute", { chat_number: chatNumber, dialog_id: acao.dialogoId });
      },
    };
  },
};
