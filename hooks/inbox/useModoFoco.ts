"use client";
import { useCallback, useEffect, useState } from "react";

/**
 * O "MODO FOCO" das telas de conversa (PC-011): esconde as colunas laterais, a
 * régua de etapas e a faixa recolhida, e deixa só o cabeçalho de uma linha, as
 * mensagens e a barra de escrever. É para quem precisa LER a conversa inteira
 * rápido (Análise humana, Análise de viabilidade) antes de assumir.
 *
 * Sai pelo mesmo botão ou pelo Esc. O Esc é ignorado quando outra coisa já o
 * usa: um campo de texto em foco (o composer fecha menus com ele, a busca
 * fecha a si mesma) ou um diálogo, menu ou balão aberto — senão fechar a
 * confirmação de "Arquivar" também tiraria a pessoa do modo foco.
 *
 * O modo foco NUNCA esconde alerta novo de conformidade nem o estado da IA: o
 * cabeçalho continua com o "quem manda" e a faixa aberta continua à vista.
 */
export function useModoFoco(ativo = true) {
  const [modoFoco, setModoFoco] = useState(false);
  const alternarFoco = useCallback(() => setModoFoco((v) => !v), []);
  const ligado = ativo && modoFoco;

  useEffect(() => {
    if (!ligado) return;
    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key !== "Escape" || evento.defaultPrevented) return;
      if (escDeOutroDono(evento.target)) return;
      setModoFoco(false);
    }
    document.addEventListener("keydown", aoTeclar);
    return () => document.removeEventListener("keydown", aoTeclar);
  }, [ligado]);

  return { modoFoco: ligado, alternarFoco, sairDoFoco: () => setModoFoco(false) };
}

/** O Esc pertence a outra coisa? (campo de texto, diálogo, menu ou balão aberto). */
export function escDeOutroDono(alvo: EventTarget | null): boolean {
  if (typeof document === "undefined") return false;
  const el = alvo instanceof HTMLElement ? alvo : null;
  if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) {
    return true;
  }
  return (
    document.querySelector(
      '[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [role="alertdialog"]',
    ) !== null || document.querySelectorAll('[role="dialog"][data-state="open"]').length > 1
  );
}
