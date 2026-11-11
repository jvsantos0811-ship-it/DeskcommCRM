import { describe, expect, it } from "vitest";

import { decidirTitulo, normalizarNomeConfirmado, type FatosDoTitulo } from "./titulo-confirmado";

/**
 * PC-026 (item 1): o título do card é o nome de quem conversa — escrito com
 * iniciais maiúsculas, sem emoji — e a IA nunca apaga um título que a equipe
 * escreveu à mão.
 */

describe("normalizarNomeConfirmado", () => {
  it.each([
    ["maria de souza", "Maria de Souza"],
    ["  ANA  ", "Ana"],
    ["carla 💖", "Carla"],
    ["joão da silva-pereira", "João da Silva-Pereira"],
    ["MARIANA D'ÁVILA", "Mariana D'Ávila"],
  ])("%s → %s", (bruto, esperado) => {
    expect(normalizarNomeConfirmado(bruto)).toBe(esperado);
  });

  it("o que não é nome não vira título", () => {
    expect(normalizarNomeConfirmado("")).toBeNull();
    expect(normalizarNomeConfirmado("não informado")).toBeNull();
    expect(normalizarNomeConfirmado("31 99876-1234")).toBeNull();
    expect(normalizarNomeConfirmado("A")).toBeNull();
    expect(normalizarNomeConfirmado(undefined)).toBeNull();
  });

  it("até 200 caracteres", () => {
    expect(normalizarNomeConfirmado("ana ".repeat(80))!.length).toBeLessThanOrEqual(200);
  });
});

describe("decidirTitulo", () => {
  const base: FatosDoTitulo = {
    tituloAtual: "+55 31 99876-1234",
    origem: null,
    telefone: "+5531998761234",
    nomesDoSistema: ["Mãe ❤️", null],
  };

  it("⭐ título editado pela equipe (pessoa) nunca muda", () => {
    expect(decidirTitulo({ ...base, tituloAtual: "Dona Ana - BPC", origem: "pessoa" }, "Ana")).toBe("protegido");
  });

  it("⭐ correção da IA troca o título que veio da IA ou do sistema", () => {
    expect(decidirTitulo({ ...base, tituloAtual: "Maria", origem: "ia" }, "Mariana")).toBe("trocar");
    expect(decidirTitulo({ ...base, tituloAtual: "Novo contato", origem: "sistema" }, "Mariana")).toBe("trocar");
  });

  it("card antigo (origem desconhecida): troca telefone e nome do perfil, protege o resto", () => {
    expect(decidirTitulo(base, "Ana")).toBe("trocar");
    expect(decidirTitulo({ ...base, tituloAtual: "Mãe ❤️" }, "Ana")).toBe("trocar");
    expect(decidirTitulo({ ...base, tituloAtual: "Indicação Dra. Paula" }, "Ana")).toBe("protegido");
  });

  it("o mesmo nome (sem acento ou caixa importando) não é troca", () => {
    expect(decidirTitulo({ ...base, tituloAtual: "Joao", origem: "ia" }, "João")).toBe("igual");
  });
});
