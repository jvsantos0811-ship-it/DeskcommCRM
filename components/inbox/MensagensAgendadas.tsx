"use client";
import { useState } from "react";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useScheduledMessages } from "@/hooks/inbox/useScheduledMessages";
import {
  motivoParaRecusarAgendamento,
  podeCancelar,
  TEXTO_MAXIMO,
  type MensagemAgendada,
} from "@/lib/inbox/mensagens-agendadas";
import { Clock, X } from "@/lib/ui/icons";

/** `yyyy-MM-ddTHH:mm` no fuso do navegador — o formato do `datetime-local`. */
function paraCampoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Sugestão inicial: a próxima hora cheia, pelo menos 30 minutos à frente. */
function sugestao(): string {
  const d = new Date(Date.now() + 30 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return paraCampoLocal(d);
}

/**
 * Mensagens agendadas da conversa — a faixa logo acima do campo de texto.
 *
 * Fica FORA do Composer de propósito: o Composer é o "mandar agora", com
 * anexos, templates, citação e nota interna, e agendar é só texto nesta versão
 * (ver a migration 9001). Um formulário próprio deixa claro que o que se
 * escreve aqui NÃO sai agora, e serve igual no Inbox e no pop-up do negócio.
 *
 * O que mostra: as pendentes (com Cancelar) e as que falharam (com o motivo).
 * As que saíram somem daqui — elas já estão no fio da conversa.
 */
export function MensagensAgendadas({
  conversationId,
  podeAgendar,
}: {
  conversationId: string;
  /** Falso para somente leitura, contato bloqueado ou conversa encerrada. */
  podeAgendar: boolean;
}) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const { lista, agendar, cancelar } = useScheduledMessages(conversationId);
  const [aberto, setAberto] = useState(false);
  const [texto, setTexto] = useState("");
  const [quando, setQuando] = useState(sugestao);
  const [erro, setErro] = useState<string | null>(null);

  const visiveis = (lista.data ?? []).filter(
    (m) => m.status === "scheduled" || m.status === "sending" || m.status === "failed",
  );

  const formatar = (iso: string) =>
    new Date(iso).toLocaleString(tagDoIdioma, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

  const enviar = () => {
    const data = new Date(quando);
    const recusa = motivoParaRecusarAgendamento(texto, data, new Date(), t);
    if (recusa) {
      setErro(recusa);
      return;
    }
    setErro(null);
    agendar.mutate(
      { body: texto.trim(), send_at: data.toISOString() },
      {
        onSuccess: () => {
          setTexto("");
          setQuando(sugestao());
          setAberto(false);
        },
      },
    );
  };

  if (!podeAgendar && visiveis.length === 0) return null;

  return (
    <div className="border-t border-border px-3 py-2 text-xs" data-mensagens-agendadas>
      {visiveis.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1.5" aria-label={t("Mensagens agendadas")}>
          {visiveis.map((m: MensagemAgendada) => (
            <li
              key={m.id}
              data-agendada-status={m.status}
              className={
                "flex items-start gap-2 rounded-md border px-2.5 py-1.5 " +
                (m.status === "failed" ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/40")
              }
            >
              <Clock size={14} className="mt-0.5 shrink-0 text-text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-text">
                  {m.status === "failed"
                    ? t("Não foi enviada")
                    : m.status === "sending"
                      ? t("Enviando…")
                      : `${t("Agendada para")} ${formatar(m.send_at)}`}
                </p>
                <p className="line-clamp-2 break-words text-text-muted">{m.body}</p>
                {m.status === "failed" && m.error && (
                  <p className="mt-0.5 text-destructive">{m.error}</p>
                )}
              </div>
              {podeCancelar(m.status) && podeAgendar && (
                <button
                  type="button"
                  onClick={() => cancelar.mutate(m.id)}
                  disabled={cancelar.isPending}
                  className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-text-muted hover:bg-muted hover:text-text disabled:opacity-60"
                >
                  <X size={12} aria-hidden />
                  {t("Cancelar")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {podeAgendar && !aberto && (
        <button
          type="button"
          onClick={() => setAberto(true)}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 font-medium text-text-muted hover:bg-muted hover:text-text"
        >
          <Clock size={14} aria-hidden />
          {t("Agendar mensagem")}
        </button>
      )}

      {podeAgendar && aberto && (
        <div
          role="group"
          aria-label={t("Agendar mensagem")}
          className="flex flex-col gap-2 rounded-md border border-primary/40 bg-primary/5 p-2.5"
        >
          <textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            maxLength={TEXTO_MAXIMO}
            rows={3}
            placeholder={t("Escreva a mensagem que vai sair no horário escolhido")}
            aria-label={t("Texto da mensagem agendada")}
            className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-sm text-text outline-hidden focus:border-primary"
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-text-muted">
              {t("Enviar em")}
              <input
                type="datetime-local"
                value={quando}
                onChange={(e) => setQuando(e.target.value)}
                aria-label={t("Data e hora do envio")}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs text-text"
              />
            </label>
            <span className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setAberto(false);
                  setErro(null);
                }}
                className="h-8 rounded-md px-3 font-medium text-text-muted hover:bg-muted hover:text-text"
              >
                {t("Cancelar")}
              </button>
              <button
                type="button"
                onClick={enviar}
                disabled={agendar.isPending}
                className="h-8 rounded-md bg-primary px-3 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {t("Agendar")}
              </button>
            </span>
          </div>
          {erro && (
            <p role="alert" className="text-destructive">
              {erro}
            </p>
          )}
          <p className="text-[11px] text-text-muted">
            {t("Sai em seu nome, pelo mesmo canal da conversa. Se não puder sair, você vê o motivo aqui e no fio.")}
          </p>
        </div>
      )}
    </div>
  );
}
