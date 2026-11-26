import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import { useConversaAbertaEstavel } from "./useConversaAbertaEstavel";

type Conversa = { id: string; preview: string };

interface Props {
  selectedId: string | null;
  daLeitura: Conversa | null;
  naoEncontrada: boolean;
}

function montar(inicial: Props) {
  return renderHook((p: Props) => useConversaAbertaEstavel(p.selectedId, p.daLeitura, p.naoEncontrada), {
    initialProps: inicial,
  });
}

const a1: Conversa = { id: "a", preview: "oi" };
const a2: Conversa = { id: "a", preview: "resposta enviada" };
const b1: Conversa = { id: "b", preview: "outra" };

describe("useConversaAbertaEstavel", () => {
  it("a conversa que sai da lista depois do envio continua aberta enquanto a busca por id não volta", () => {
    const { result, rerender } = montar({ selectedId: "a", daLeitura: a1, naoEncontrada: false });
    expect(result.current).toBe(a1);

    // A recarga da lista deixou a conversa de fora e a busca por id ainda está saindo.
    rerender({ selectedId: "a", daLeitura: null, naoEncontrada: false });
    expect(result.current).toBe(a1);

    // A busca por id chegou: vale a leitura nova.
    rerender({ selectedId: "a", daLeitura: a2, naoEncontrada: false });
    expect(result.current).toBe(a2);
  });

  it("guarda sempre a leitura mais nova, não a primeira", () => {
    const { result, rerender } = montar({ selectedId: "a", daLeitura: a1, naoEncontrada: false });
    rerender({ selectedId: "a", daLeitura: a2, naoEncontrada: false });
    rerender({ selectedId: "a", daLeitura: null, naoEncontrada: false });
    expect(result.current).toBe(a2);
  });

  it("trocar de conversa nunca mostra a anterior no lugar da nova", () => {
    const { result, rerender } = montar({ selectedId: "a", daLeitura: a1, naoEncontrada: false });
    rerender({ selectedId: "b", daLeitura: null, naoEncontrada: false });
    expect(result.current).toBeNull();
    rerender({ selectedId: "b", daLeitura: b1, naoEncontrada: false });
    expect(result.current).toBe(b1);
  });

  it("sair e voltar para a mesma conversa não mostra o objeto da abertura anterior", () => {
    const { result, rerender } = montar({ selectedId: "a", daLeitura: a1, naoEncontrada: false });
    rerender({ selectedId: "b", daLeitura: b1, naoEncontrada: false });
    // Volta para A por um caminho fora da lista: a busca por id ainda não voltou.
    rerender({ selectedId: "a", daLeitura: null, naoEncontrada: false });
    expect(result.current).toBeNull();
  });

  it("a busca por id disse que a conversa não existe mais (404): a tela segue a resposta", () => {
    const { result, rerender } = montar({ selectedId: "a", daLeitura: a1, naoEncontrada: false });
    rerender({ selectedId: "a", daLeitura: null, naoEncontrada: true });
    expect(result.current).toBeNull();
  });

  it("sem conversa escolhida (o voltar do celular) não há conversa aberta", () => {
    const { result, rerender } = montar({ selectedId: "a", daLeitura: a1, naoEncontrada: false });
    rerender({ selectedId: null, daLeitura: null, naoEncontrada: false });
    expect(result.current).toBeNull();
  });
});
