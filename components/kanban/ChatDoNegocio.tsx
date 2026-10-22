"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useConversation, isNotFound } from "@/hooks/inbox/useConversation";
import { ArrowSquareOut } from "@/lib/ui/icons";
import { estadoDaJanela } from "@/lib/channels/janela";
import {
  motivoDaJanelaFechada,
  motivoDoContato,
} from "@/lib/inbox/motivo-do-envio-bloqueado";
import { ChatThread } from "@/components/inbox/ChatThread";
import { Composer } from "@/components/inbox/Composer";
import { JanelaFechadaAviso } from "@/components/inbox/JanelaFechadaAviso";
import type { Message } from "@/lib/types/messaging";

/**
 * O chat da conversa DENTRO do pop-up do negócio.
 *
 * ─── Por que existe ──────────────────────────────────────────────────────────
 *
 * O dossiê dava a porta para a conversa ("Abrir conversa no Inbox") e o
 * operador saía do funil para responder — perdendo o contexto do negócio que
 * estava olhando. Quem trabalha pelo funil quer ler e responder ali mesmo, com
 * etapa, tarefas e campos ao lado.
 *
 * ─── Mesmas peças do Inbox, nenhuma cópia ───────────────────────────────────
 *
 * O fio é o `ChatThread` e o campo é o `Composer` do Inbox — os mesmos
 * componentes, com o mesmo tempo real, as mesmas notas internas, templates,
 * respostas rápidas, anexos e áudio. As regras que FECHAM o envio também são as
 * do Inbox, chamadas pelas mesmas funções: janela de 24h vencida
 * (`motivoDaJanelaFechada`), contato bloqueado ou anonimizado
 * (`motivoDoContato`) e acompanhamento de suporte somente leitura. Duas
 * implementações dessas regras divergiriam no primeiro ajuste de uma delas, e
 * o pop-up liberaria um envio que o Inbox barra.
 *
 * A conversa vem pela MESMA rota do deep link do Inbox (`useConversation`),
 * que respeita o escopo do usuário: conversa fora do acesso volta 404, e aqui
 * isso vira um aviso com a porta para o Inbox, nunca um fio vazio.
 */
export function ChatDoNegocio({ conversationId }: { conversationId: string }) {
  const t = useT();
  const user = useUser();
  const conversa = useConversation(conversationId, true);
  const [respondendo, setRespondendo] = useState<Message | null>(null);

  // A janela de 24h vence sozinha com o pop-up aberto — mesmo relógio do Inbox.
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setAgora(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const linkDoInbox = (
    <Link
      href={`/app/inbox?id=${conversationId}`}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted underline-offset-2 hover:text-text hover:underline"
    >
      {t("Abrir no Inbox")}
      <ArrowSquareOut size={14} aria-hidden />
    </Link>
  );

  if (conversa.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">
        {t("Carregando conversa…")}
      </div>
    );
  }

  if (conversa.isError || !conversa.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-text-muted">
        <p>
          {isNotFound(conversa.error)
            ? t("Conversa não encontrada ou fora do seu acesso.")
            : t("Não foi possível carregar a conversa agora.")}
        </p>
        {linkDoInbox}
      </div>
    );
  }

  const c = conversa.data;
  const provider = c.channel_sessions?.provider ?? null;
  const motivoDaJanela = motivoDaJanelaFechada(
    estadoDaJanela(provider, c.last_inbound_at ?? null, agora),
    provider,
    t,
  );
  const somenteLeitura = user.support?.access_mode === "support_readonly";
  const bloqueio = somenteLeitura
    ? t("Acompanhamento somente leitura")
    : motivoDoContato(c.contacts, t);

  return (
    <div className="flex h-full min-h-0 flex-col" data-chat-do-negocio>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="truncate text-sm font-medium text-text">
          {c.contacts?.name || c.contacts?.display_name || c.contacts?.phone_number || t("Conversa")}
        </span>
        {linkDoInbox}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ChatThread
          conversationId={c.id}
          provider={provider}
          onResponder={setRespondendo}
          dono={{
            userId: c.assigned_to_user_id ?? null,
            nome: c.assigned_to_user_name ?? null,
          }}
          contatoId={c.contacts?.id ?? null}
        />
      </div>
      {motivoDaJanela && (
        <JanelaFechadaAviso conversationId={c.id} provider={provider} motivo={motivoDaJanela} />
      )}
      <Composer
        conversationId={c.id}
        blockedReason={bloqueio}
        janelaFechada={motivoDaJanela}
        disabled={c.status === "closed"}
        contactName={c.contacts?.name ?? null}
        contactDisplayName={c.contacts?.display_name}
        respondendo={respondendo}
        onCancelarResposta={() => setRespondendo(null)}
        currentContactId={c.contact_id}
      />
    </div>
  );
}
