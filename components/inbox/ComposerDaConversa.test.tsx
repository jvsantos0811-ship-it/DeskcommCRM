import { useEffect, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/inbox/Composer", () => ({
  Composer: function SondaDoComposer({
    initialDraft = "",
    initialMode = "reply",
    onDraftChange,
  }: {
    initialDraft?: string;
    initialMode?: "reply" | "note";
    onDraftChange?: (texto: string, modo: "reply" | "note") => void;
  }) {
    const [texto, setTexto] = useState(initialDraft);
    useEffect(() => {
      onDraftChange?.(texto, initialMode);
    }, [texto, onDraftChange, initialMode]);
    return <textarea aria-label="campo" value={texto} onChange={(e) => setTexto(e.target.value)} />;
  },
}));

import { ComposerDaConversa } from "./ComposerDaConversa";
import { esquecerTodosOsRascunhos, guardarRascunhoDaConversa, lerRascunhoDaConversa } from "@/lib/inbox/rascunho-por-conversa";

describe("ComposerDaConversa", () => {
  beforeEach(() => esquecerTodosOsRascunhos());

  it("nasce com o rascunho guardado da conversa e guarda o que muda", () => {
    guardarRascunhoDaConversa("a", "começo", "note");
    render(<ComposerDaConversa conversationId="a" />);
    const campo = screen.getByLabelText("campo");
    expect(campo).toHaveValue("começo");
    fireEvent.change(campo, { target: { value: "começo e meio" } });
    expect(lerRascunhoDaConversa("a")).toEqual({ texto: "começo e meio", modo: "note" });
  });

  it("com texto sugerido por integração, mostra o sugerido e não guarda nada (nem o antigo)", () => {
    guardarRascunhoDaConversa("a", "rascunho antigo", "reply");
    render(<ComposerDaConversa conversationId="a" textoSugerido="Seu boleto venceu hoje." />);
    expect(screen.getByLabelText("campo")).toHaveValue("Seu boleto venceu hoje.");
    // O sugerido só volta pelo link, com a faixa de origem; guardado, voltaria sem ela.
    expect(lerRascunhoDaConversa("a")).toBeNull();
    fireEvent.change(screen.getByLabelText("campo"), { target: { value: "Seu boleto venceu hoje. Posso ajudar?" } });
    expect(lerRascunhoDaConversa("a")).toBeNull();
  });
});
