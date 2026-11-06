import { describe, expect, it } from "vitest";

import { decidirPelaForma, normalizarFala } from "./fim-da-conversa";

const nossa = new Date("2026-10-29T18:20:40Z");
const minutosDepois = (n: number) => new Date(nossa.getTime() + n * 60_000);
const texto = (t: string, min = 9) => ({ tipo: "text", texto: t, em: minutosDepois(min) });

describe("a conversa terminou? (1ª camada, sem IA)", () => {
  it("o caso da Bórbora: 'Obg👍' depois da resposta da equipe encerra", () => {
    expect(decidirPelaForma(texto("Obg👍"), nossa)).toBe("encerrou");
  });

  it.each(["obrigado", "Obrigada!", "valeu", "ok", "Okay.", "blz", "beleza", "certo", "combinado", "tá bom", "Perfeito", "tchau", "até mais", "até logo", "falou", "abraço", "ok, obrigado", "Boa noite, obrigado!"])(
    "'%s' logo depois da nossa resposta encerra",
    (t) => {
      expect(decidirPelaForma(texto(t), nossa)).toBe("encerrou");
    },
  );

  it("emoji sozinho, figurinha e reação encerram depois da nossa resposta", () => {
    expect(decidirPelaForma(texto("👍🙏"), nossa)).toBe("encerrou");
    expect(decidirPelaForma({ tipo: "sticker", texto: null, em: minutosDepois(2) }, nossa)).toBe("encerrou");
    expect(decidirPelaForma({ tipo: "reaction", texto: "❤️", em: minutosDepois(2) }, nossa)).toBe("encerrou");
  });

  it("'bom dia' sozinho abrindo a conversa PEDE resposta (nunca é encerramento)", () => {
    // O caso da Bórbora: nossa última foi 4 dias antes.
    expect(decidirPelaForma(texto("Bom dia", 4 * 24 * 60), nossa)).toBe("pede_resposta");
    expect(decidirPelaForma(texto("Bom dia"), null)).toBe("pede_resposta");
  });

  it("'boa noite' logo depois da nossa resposta é despedida", () => {
    expect(decidirPelaForma(texto("Boa noite", 5), nossa)).toBe("encerrou");
    expect(decidirPelaForma(texto("Boa noite", 3 * 60), nossa)).toBe("pede_resposta");
  });

  it("encerramento sem resposta nossa antes não encerra: vai para a 2ª camada", () => {
    expect(decidirPelaForma(texto("obrigado"), null)).toBe("indeciso");
    expect(decidirPelaForma(texto("obrigado", 3 * 24 * 60), nossa)).toBe("indeciso");
  });

  it("frase com conteúdo é indecisa (a 2ª camada lê a conversa)", () => {
    expect(decidirPelaForma(texto("Vou verificar"), nossa)).toBe("indeciso");
    expect(decidirPelaForma(texto("ok, mas e o meu benefício?"), nossa)).toBe("indeciso");
    expect(decidirPelaForma(texto("#N1 - Olá, meu benefício do INSS foi negado e preciso de ajuda."), null)).toBe(
      "indeciso",
    );
  });

  it("áudio, foto e documento nunca são decididos pela forma", () => {
    expect(decidirPelaForma({ tipo: "audio", texto: "Obrigado", em: minutosDepois(1) }, nossa)).toBe("indeciso");
    expect(decidirPelaForma({ tipo: "image", texto: null, em: minutosDepois(1) }, nossa)).toBe("indeciso");
  });

  it("normaliza sem acento, sem emoji e sem pontuação", () => {
    expect(normalizarFala("  Tá  BOM!! 👍 ")).toBe("ta bom");
  });
});
