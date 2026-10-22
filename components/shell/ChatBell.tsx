"use client";
import Link from "next/link";

import { useSalasDoChat } from "@/hooks/team-chat/useChatDaEquipe";
import { useT } from "@/hooks/i18n/useT";
import { ChatsCircle } from "@/lib/ui/icons";

/**
 * O chat interno da equipe no topo, ao lado do sino: um ícone com o número de
 * mensagens não lidas. Mora aqui e não no menu lateral porque o menu já está
 * no limite de 900px de altura (`tests/e2e/navegacao.spec.ts`) — e um contador
 * de conversa precisa estar à vista em toda tela, como o sino.
 *
 * Abaixo de 640px o topo não tem largura para mais um botão de 44px sem criar
 * rolagem horizontal; no celular a porta é a busca (⌘K), onde o chat está no
 * catálogo de navegação.
 */
export function ChatBell() {
  const t = useT();
  const { data } = useSalasDoChat();
  const count = data?.total_nao_lidas ?? 0;
  return (
    <Link
      href="/app/chat"
      aria-label={count > 0 ? `${t("Chat da equipe")} — ${count} ${t("não lidas")}` : t("Chat da equipe")}
      title={t("Chat da equipe")}
      data-testid="chat-bell"
      className="relative hidden h-11 w-11 sm:inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:h-9 lg:w-9"
    >
      <ChatsCircle size={18} aria-hidden />
      {count > 0 ? (
        <span
          data-testid="chat-bell-count"
          className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-destructive-foreground"
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}
