import { beforeEach, describe, expect, it } from "vitest";

import {
  TETO_DE_RASCUNHOS,
  esquecerTodosOsRascunhos,
  guardarRascunhoDaConversa,
  lerRascunhoDaConversa,
} from "./rascunho-por-conversa";

describe("rascunho por conversa", () => {
  beforeEach(() => esquecerTodosOsRascunhos());

  it("guarda e devolve o texto e o modo de cada conversa, sem misturar", () => {
    guardarRascunhoDaConversa("u1", "a", "resposta para A", "reply");
    guardarRascunhoDaConversa("u1", "b", "nota sobre B", "note");
    expect(lerRascunhoDaConversa("u1", "a")).toEqual({ texto: "resposta para A", modo: "reply" });
    expect(lerRascunhoDaConversa("u1", "b")).toEqual({ texto: "nota sobre B", modo: "note" });
    expect(lerRascunhoDaConversa("u1", "c")).toBeNull();
  });

  it("campo vazio (o estado depois do envio) apaga o rascunho", () => {
    guardarRascunhoDaConversa("u1", "a", "vai sair", "reply");
    guardarRascunhoDaConversa("u1", "a", "   ", "reply");
    expect(lerRascunhoDaConversa("u1", "a")).toBeNull();
  });

  it("o rascunho é da pessoa: outra pessoa na mesma aba não vê", () => {
    guardarRascunhoDaConversa("u1", "a", "texto da Ana", "reply");
    expect(lerRascunhoDaConversa("u2", "a")).toBeNull();
    expect(lerRascunhoDaConversa("u1", "a")?.texto).toBe("texto da Ana");
  });

  it("passando do teto, sai o mais antigo, e reescrever renova a vez", () => {
    for (let i = 0; i < TETO_DE_RASCUNHOS; i++) guardarRascunhoDaConversa("u1", `c${i}`, `texto ${i}`, "reply");
    // c0 é reescrito: passa a ser o mais novo, e quem sai é o c1.
    guardarRascunhoDaConversa("u1", "c0", "texto 0 de novo", "reply");
    guardarRascunhoDaConversa("u1", "nova", "texto novo", "reply");
    expect(lerRascunhoDaConversa("u1", "c0")?.texto).toBe("texto 0 de novo");
    expect(lerRascunhoDaConversa("u1", "c1")).toBeNull();
    expect(lerRascunhoDaConversa("u1", "nova")?.texto).toBe("texto novo");
  });
});
