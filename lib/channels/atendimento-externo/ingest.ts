/**
 * Ingestão do que chega da plataforma de atendimento (ChatGuru, PC-047).
 *
 * Reusa as MESMAS operações canônicas dos outros canais — `fn_upsert_wa_contact`,
 * `fn_upsert_wa_conversation`, `fn_mark_conversation_message` e os efeitos de
 * `aplicarEfeitosPosEntrada` (opt-out, lead, despacho do agente). O que é deste
 * canal é só o mapeamento do POST e duas anotações na conversa:
 *
 *  - `provider_conversation_id` = o número do chat COMO A PLATAFORMA O ENDEREÇA.
 *    O cadastro do contato guarda o celular canônico (com o nono dígito); a
 *    plataforma pode ter o chat sem ele. Responder pelo número do cadastro
 *    abriria outro chat lá — ou falharia. O envio usa este campo.
 *  - `metadata.link_externo` = o link do chat dentro da plataforma, que a Inbox
 *    mostra como "Abrir em …". Só https e só do domínio dela (`entrada.ts`).
 *
 * ─── Nada aqui escolhe organização pelo corpo ───────────────────────────────
 *
 * A organização e a sessão vêm de quem chama (a rota, pelo TOKEN do caminho e
 * pelo SEGREDO da conexão). O corpo só diz quem escreveu e o quê.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { consumirRespostaDoSuporteNoWhatsApp } from "@/lib/escalacao/resposta-whatsapp-ao-caso";
import { logger } from "@/lib/logger";
import { previaDaMensagem } from "@/lib/messaging/previa-da-mensagem";

import { encontrarContatoPorTelefone } from "../contato-por-telefone";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { canonicalPhoneBR } from "../phone-variants";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import type { ChannelTenantScope } from "../types";
import { idExternoDaEntrada, type EntradaDoAtendimentoExterno } from "./entrada";
import { CHAVE_DO_LINK_EXTERNO } from "./link";

export type DesfechoDaIngestao =
  | { status: "ingested"; messageId: string; conversationId: string }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string }
  | { status: "failed"; reason: string };

/** Dica de mime para a tela ter o que mostrar antes de os bytes chegarem. */
function mimeDoTipo(tipo: EntradaDoAtendimentoExterno["tipo"]): string | null {
  switch (tipo) {
    case "image":
      return "image/jpeg";
    case "video":
      return "video/mp4";
    case "audio":
      return "audio/ogg";
    default:
      return null;
  }
}

/**
 * Grava o endereço do chat e o link na conversa, só quando mudaram. Falha aqui
 * não derruba a ingestão: a mensagem é o produto; o endereço é recuperável na
 * próxima entrada, que traz os dois de novo.
 *
 * O `metadata` é compartilhado (a passagem para a equipe grava marcas nele), e o
 * client não faz `metadata || jsonb` atômico. Por isso o link vai com trava
 * otimista em `updated_at`: se outra escrita entrou entre a leitura e esta, o
 * link fica para a próxima mensagem — nunca apaga a marca de outro escritor.
 */
async function anotarConversa(
  admin: SupabaseClient,
  orgId: string,
  conversationId: string,
  e: EntradaDoAtendimentoExterno,
): Promise<void> {
  const { data, error } = await admin
    .from("conversations")
    .select("provider_conversation_id, metadata, updated_at")
    .eq("organization_id", orgId)
    .eq("id", conversationId)
    .maybeSingle();
  if (error || !data) {
    logger.warn("[atendimento-externo] conversa não lida para anotar o endereço", {
      conversation_id: conversationId,
    });
    return;
  }
  const atual = data as {
    provider_conversation_id: string | null;
    metadata: Record<string, unknown> | null;
    updated_at: string;
  };

  if (atual.provider_conversation_id !== e.celular) {
    const { error: erroEndereco } = await admin
      .from("conversations")
      .update({ provider_conversation_id: e.celular })
      .eq("organization_id", orgId)
      .eq("id", conversationId);
    if (erroEndereco) {
      logger.warn("[atendimento-externo] endereço do chat não gravado", { conversation_id: conversationId });
    }
    // O update acima mexe em `updated_at`: a trava do link releria um valor velho.
    await anotarLink(admin, orgId, conversationId, e);
    return;
  }
  const metadata = atual.metadata ?? {};
  if (e.linkChat === null || metadata[CHAVE_DO_LINK_EXTERNO] === e.linkChat) return;
  await admin
    .from("conversations")
    .update({ metadata: { ...metadata, [CHAVE_DO_LINK_EXTERNO]: e.linkChat } })
    .eq("organization_id", orgId)
    .eq("id", conversationId)
    .eq("updated_at", atual.updated_at);
}

/** Segunda leitura, só para o link, depois de o endereço ter mudado a linha. */
async function anotarLink(
  admin: SupabaseClient,
  orgId: string,
  conversationId: string,
  e: EntradaDoAtendimentoExterno,
): Promise<void> {
  if (e.linkChat === null) return;
  const { data } = await admin
    .from("conversations")
    .select("metadata, updated_at")
    .eq("organization_id", orgId)
    .eq("id", conversationId)
    .maybeSingle();
  const atual = data as { metadata: Record<string, unknown> | null; updated_at: string } | null;
  if (!atual) return;
  const metadata = atual.metadata ?? {};
  if (metadata[CHAVE_DO_LINK_EXTERNO] === e.linkChat) return;
  await admin
    .from("conversations")
    .update({ metadata: { ...metadata, [CHAVE_DO_LINK_EXTERNO]: e.linkChat } })
    .eq("organization_id", orgId)
    .eq("id", conversationId)
    .eq("updated_at", atual.updated_at);
}

const JANELA_DO_ECO_MS = 10 * 60_000;
/**
 * Abaixo disto não é eco, é conversa: "Bom dia!", "Perfeito", "Sim" o cliente
 * repete de verdade, e engolir a resposta dele seria pior que um eco curto.
 */
const ECO_MINIMO = 20;

async function ehEcoDoProprioEnvio(
  admin: SupabaseClient,
  orgId: string,
  conversationId: string,
  texto: string,
): Promise<boolean> {
  const desde = new Date(Date.now() - JANELA_DO_ECO_MS).toISOString();
  const { data, error } = await admin
    .from("messages")
    .select("id")
    .eq("organization_id", orgId)
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .eq("body", texto)
    .gte("created_at", desde)
    .limit(1)
    .maybeSingle();
  // Na dúvida, entra: perder a mensagem do cliente é pior que um eco raro.
  return !error && data !== null;
}

export async function ingestAtendimentoExterno(
  admin: SupabaseClient,
  e: EntradaDoAtendimentoExterno,
  dono: ChannelTenantScope & {
    channelSessionId: string;
    /**
     * Roda com a conversa já conhecida e ANTES de a mensagem ser gravada (a
     * gravação é o que acorda a IA). É onde a regra do responsável cala ou
     * devolve a IA. Nunca deve lançar; se lançar, a mensagem entra assim mesmo.
     */
    antesDaMensagem?: (conversationId: string) => Promise<void>;
  },
): Promise<DesfechoDaIngestao> {
  const orgId = dono.organizationId;
  const telefone = `+${e.celular}`;
  const externalId = idExternoDaEntrada(e);

  // O número interno de avisos da equipe não vira atendimento (mesma regra dos
  // outros canais), e é decidido ANTES do upsert do contato.
  if (
    await consumirRespostaDoSuporteNoWhatsApp(admin, {
      organizationId: orgId,
      channelSessionId: dono.channelSessionId,
      identidade: { kind: "phone", phone: telefone, lid: null },
      direction: "inbound",
      texto: e.texto,
      externalId,
    })
  ) {
    return { status: "ignored", reason: "numero_interno_de_aviso" };
  }

  const existente = await encontrarContatoPorTelefone(admin, orgId, telefone);
  const phone = existente?.phone_number ? canonicalPhoneBR(existente.phone_number) : canonicalPhoneBR(telefone);

  const { data: contactId, error: erroContato } = await admin.rpc(
    "fn_upsert_wa_contact" as never,
    {
      p_org: orgId,
      p_kind: "phone",
      p_phone: phone,
      p_lid: null,
      p_chat_id: e.celular,
      p_notify: e.nome,
    } as never,
  );
  if (erroContato || !contactId) {
    return { status: "failed", reason: `contato: ${erroContato?.message ?? "sem id"}` };
  }

  const { data: conversationId, error: erroConversa } = await admin.rpc(
    "fn_upsert_wa_conversation" as never,
    { p_org: orgId, p_contact: contactId as string, p_session: dono.channelSessionId } as never,
  );
  if (erroConversa || !conversationId) {
    return { status: "failed", reason: `conversa: ${erroConversa?.message ?? "sem id"}` };
  }

  await anotarConversa(admin, orgId, conversationId as string, e);

  // ─── O eco do próprio envio não é o cliente falando ───────────────────────
  //
  // O POST não diz se a mensagem foi recebida ou enviada. Se o diálogo da
  // plataforma também disparar nas mensagens que SAEM, a resposta da IA voltaria
  // como se fosse do cliente — e a IA passaria a conversar consigo mesma,
  // gastando a cada volta. Texto idêntico a uma saída desta conversa nos últimos
  // minutos é tratado como eco e não entra.
  if (
    !e.midiaUrl &&
    e.texto.length >= ECO_MINIMO &&
    (await ehEcoDoProprioEnvio(admin, orgId, conversationId as string, e.texto))
  ) {
    return { status: "ignored", reason: "eco_do_proprio_envio" };
  }

  // A reentrega da MESMA mensagem (fora de ordem, inclusive) não reaplica a
  // regra: um POST velho não pode calar ou soltar a IA de novo.
  let jaGravada = false;
  if (dono.antesDaMensagem) {
    const { data: repetida } = await admin
      .from("messages")
      .select("id")
      .eq("organization_id", orgId)
      .eq("external_id", externalId)
      .limit(1)
      .maybeSingle();
    jaGravada = repetida !== null && repetida !== undefined;
  }
  if (dono.antesDaMensagem && !jaGravada) {
    try {
      await dono.antesDaMensagem(conversationId as string);
    } catch {
      // A mensagem do cliente entra de qualquer jeito.
    }
  }

  const agora = new Date().toISOString();
  const { data: inserida, error: erroInsert } = await admin
    .from("messages")
    .insert({
      organization_id: orgId,
      conversation_id: conversationId as string,
      channel_session_id: dono.channelSessionId,
      contact_id: contactId as string,
      direction: "inbound",
      status: "delivered",
      type: e.tipo,
      body: e.midiaUrl ? null : e.texto,
      external_id: externalId,
      // A URL da mídia é PONTEIRO: o worker de persistência baixa os bytes pelo
      // `fetchInboundMedia` do adapter, com a guarda de destino.
      ...(e.midiaUrl ? { media_url: e.midiaUrl, media_mime: mimeDoTipo(e.tipo) } : {}),
      sent_at: agora,
      metadata: { via_atendimento_externo: true },
    })
    .select("id")
    .maybeSingle();

  // 23505 = a mesma mensagem já entrou: é a plataforma reentregando.
  if (erroInsert) {
    if (erroInsert.code === "23505") return { status: "duplicate" };
    return { status: "failed", reason: `mensagem: ${erroInsert.message}` };
  }
  const messageId = (inserida as { id: string } | null)?.id ?? "";

  await marcarConversaComMensagem(admin, {
    organizationId: orgId,
    conversationId: conversationId as string,
    direction: "inbound",
    preview: previaDaMensagem(e.midiaUrl ? null : e.texto, e.tipo),
    at: agora,
    canal: "atendimento_externo",
  });

  if (e.midiaUrl && messageId) {
    const { error: erroMidia } = await admin.rpc("emit_event" as never, {
      p_event_type: "media.persist_requested",
      p_entity_kind: "message",
      p_entity_id: messageId,
      p_payload: { message_id: messageId, conversation_id: conversationId as string },
      p_metadata: { source: "atendimento_externo" },
      p_organization_id: orgId,
    } as never);
    if (erroMidia) {
      logger.warn("[atendimento-externo] emit media.persist_requested falhou", { message_id: messageId });
    }
  }

  await aplicarEfeitosPosEntrada(admin, {
    organizationId: orgId,
    contactId: contactId as string,
    conversationId: conversationId as string,
    messageId: messageId || null,
    channelSessionId: dono.channelSessionId,
    texto: e.midiaUrl ? null : e.texto,
    nomeDoContato: e.nome,
    origem: "atendimento_externo",
  });

  return { status: "ingested", messageId, conversationId: conversationId as string };
}
