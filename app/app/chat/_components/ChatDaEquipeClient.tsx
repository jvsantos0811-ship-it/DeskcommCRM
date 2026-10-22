"use client";
import { useEffect, useRef, useState } from "react";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useSalaDoChat, useSalasDoChat } from "@/hooks/team-chat/useChatDaEquipe";
import { SALA_GERAL, TEXTO_MAXIMO, type SalaResumo } from "@/lib/team-chat/salas";
import { CaretLeft, ChatsCircle, PaperPlaneTilt, UsersThree } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * A tela do chat: a lista de salas à esquerda e a conversa à direita. No
 * celular é uma coisa de cada vez — a lista, e ao tocar numa sala, a conversa
 * com um "voltar".
 *
 * Abrir uma sala a marca como lida (e de novo a cada mensagem nova que chega
 * com ela aberta): o número do sino tem de baixar quando a pessoa LÊ, não
 * quando recarrega.
 */
export function ChatDaEquipeClient({ meuId, somenteLeitura }: { meuId: string; somenteLeitura: boolean }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const salas = useSalasDoChat();
  const [sala, setSala] = useState<string>(SALA_GERAL);
  const [noCelularVendoConversa, setNoCelularVendoConversa] = useState(false);
  const { mensagens, enviar, marcarLida } = useSalaDoChat(sala);
  const [texto, setTexto] = useState("");
  const fimRef = useRef<HTMLDivElement | null>(null);

  const lista = salas.data?.salas ?? [];
  const atual: SalaResumo | undefined = lista.find((s) => s.room === sala);
  const quantas = mensagens.data?.length ?? 0;
  const ultimaId = mensagens.data?.[quantas - 1]?.id;

  // Marca como lida ao abrir e a cada mensagem nova com a sala aberta.
  const { mutate: marcar } = marcarLida;
  useEffect(() => {
    if (!somenteLeitura && sala && ultimaId) marcar(sala);
  }, [sala, ultimaId, somenteLeitura, marcar]);

  useEffect(() => {
    fimRef.current?.scrollIntoView({ block: "end" });
  }, [ultimaId, sala]);

  const mandar = () => {
    const limpo = texto.trim();
    if (!limpo || enviar.isPending) return;
    enviar.mutate(limpo, { onSuccess: () => setTexto("") });
  };

  const hora = (iso: string) =>
    new Date(iso).toLocaleString(tagDoIdioma, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-h-0" data-chat-da-equipe>
      {/* ── salas ── */}
      <aside
        className={cn(
          "w-full shrink-0 flex-col border-r border-border md:flex md:w-72",
          noCelularVendoConversa ? "hidden" : "flex",
        )}
        aria-label={t("Conversas da equipe")}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <ChatsCircle size={18} aria-hidden className="text-text-muted" />
          <h1 className="text-sm font-semibold text-text">{t("Chat da equipe")}</h1>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {salas.isLoading && <li className="px-4 py-3 text-xs text-text-muted">{t("Carregando…")}</li>}
          {lista.map((s) => (
            <li key={s.room}>
              <button
                type="button"
                onClick={() => {
                  setSala(s.room);
                  setNoCelularVendoConversa(true);
                }}
                aria-current={s.room === sala ? "true" : undefined}
                data-sala={s.room === SALA_GERAL ? "geral" : "direta"}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted",
                  s.room === sala && "bg-muted",
                )}
              >
                <span
                  aria-hidden
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
                >
                  {s.room === SALA_GERAL ? <UsersThree size={16} /> : (s.nome.trim()[0] ?? "?").toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text">{s.nome}</span>
                  <span className="block truncate text-xs text-text-muted">
                    {s.ultima ? s.ultima.body : t("Nenhuma mensagem ainda")}
                  </span>
                </span>
                {s.nao_lidas > 0 && (
                  <span
                    className="rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-semibold leading-none text-destructive-foreground tabular-nums"
                    aria-label={`${s.nao_lidas} ${t("não lidas")}`}
                  >
                    {s.nao_lidas > 99 ? "99+" : s.nao_lidas}
                  </span>
                )}
              </button>
            </li>
          ))}
          {!salas.isLoading && lista.length === 1 && (
            <li className="px-4 py-3 text-xs text-text-muted">
              {t("Quando você convidar a equipe em Equipe, cada pessoa aparece aqui para uma conversa a dois.")}
            </li>
          )}
        </ul>
      </aside>

      {/* ── conversa ── */}
      <section
        className={cn("min-w-0 flex-1 flex-col md:flex", noCelularVendoConversa ? "flex" : "hidden")}
        aria-label={t("Conversa")}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <button
            type="button"
            onClick={() => setNoCelularVendoConversa(false)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-muted md:hidden"
            aria-label={t("Voltar para a lista")}
          >
            <CaretLeft size={16} aria-hidden />
          </button>
          <h2 className="truncate text-sm font-semibold text-text">{atual?.nome ?? t("Equipe toda")}</h2>
          {sala === SALA_GERAL && (
            <span className="text-xs text-text-muted">{t("Todos da empresa veem esta conversa.")}</span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
          {mensagens.isLoading && <p className="text-xs text-text-muted">{t("Carregando…")}</p>}
          {!mensagens.isLoading && quantas === 0 && (
            <p className="mt-8 text-center text-sm text-text-muted">{t("Nenhuma mensagem ainda. Comece a conversa.")}</p>
          )}
          <ol className="flex flex-col gap-2">
            {(mensagens.data ?? []).map((m) => {
              const minha = m.sender_user_id === meuId;
              return (
                <li key={m.id} className={cn("flex", minha ? "justify-end" : "justify-start")} data-minha={minha}>
                  <div
                    className={cn(
                      "max-w-[75%] rounded-lg px-3 py-2 text-sm",
                      minha ? "bg-primary text-primary-foreground" : "bg-muted text-text",
                    )}
                  >
                    {!minha && sala === SALA_GERAL && (
                      <p className="mb-0.5 text-xs font-semibold">{m.sender_name ?? t("Sem nome")}</p>
                    )}
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                    <p className={cn("mt-1 text-[10px]", minha ? "text-primary-foreground" : "text-text-muted")}>
                      {hora(m.created_at)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
          <div ref={fimRef} />
        </div>

        {somenteLeitura ? (
          <p className="border-t border-border px-4 py-3 text-xs text-text-muted">
            {t("Acompanhamento somente leitura")}
          </p>
        ) : (
          <form
            className="flex items-end gap-2 border-t border-border px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              mandar();
            }}
          >
            <textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  mandar();
                }
              }}
              maxLength={TEXTO_MAXIMO}
              rows={1}
              placeholder={t("Escreva para a equipe… (Enter envia, Shift+Enter quebra a linha)")}
              aria-label={t("Mensagem para a equipe")}
              className="max-h-40 min-h-10 flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-text outline-hidden focus:border-primary"
            />
            <button
              type="submit"
              disabled={!texto.trim() || enviar.isPending}
              aria-label={t("Enviar")}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <PaperPlaneTilt size={16} aria-hidden />
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
