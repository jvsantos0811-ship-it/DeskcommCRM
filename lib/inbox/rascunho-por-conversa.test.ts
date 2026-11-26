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
    guardarRascunhoDaConversa("a", "resposta para A", "reply");
    guardarRascunhoDaConversa("b", "nota sobre B", "note");
    expect(lerRascunhoDaConversa("a")).toEqual({ texto: "resposta para A", modo: "reply" });
    expect(lerRascunhoDaConversa("b")).toEqual({ texto: "nota sobre B", modo: "note" });
    expect(lerRascunhoDaConversa("c")).toBeNull();
  });

  it("campo vazio (o estado depois do envio) apaga o rascunho", () => {
    guardarRascunhoDaConversa("a", "vai sair", "reply");
    guardarRascunhoDaConversa("a", "   ", "reply");
    expect(lerRascunhoDaConversa("a")).toBeNull();
  });

  it("passando do teto, sai o mais antigo, e reescrever renova a vez", () => {
    for (let i = 0; i < TETO_DE_RASCUNHOS; i++) guardarRascunhoDaConversa(`c${i}`, `texto ${i}`, "reply");
    // c0 é reescrito: passa a ser o mais novo, e quem sai é o c1.
    guardarRascunhoDaConversa("c0", "texto 0 de novo", "reply");
    guardarRascunhoDaConversa("nova", "texto novo", "reply");
    expect(lerRascunhoDaConversa("c0")?.texto).toBe("texto 0 de novo");
    expect(lerRascunhoDaConversa("c1")).toBeNull();
    expect(lerRascunhoDaConversa("nova")?.texto).toBe("texto novo");
  });
});
