import { describe, expect, it } from "vitest";

import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";

import {
  caminhoDaCopiaNaConversa,
  caminhoDoAssinado,
  caminhoDoOriginal,
  nomeDoArquivoParaOCliente,
  pareceUmPdf,
} from "./arquivo";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const CONTRATO = "33333333-3333-4333-8333-333333333333";

describe("o nome que o cliente vê no WhatsApp", () => {
  it("tira o acento e troca espaço por `_`, sem `_-_` feio", () => {
    expect(nomeDoArquivoParaOCliente("Contrato de Honorários - Maria Prudente")).toBe(
      "Contrato_de_Honorarios-Maria_Prudente.pdf",
    );
  });

  it("não dobra a extensão de quem já escreveu .pdf", () => {
    expect(nomeDoArquivoParaOCliente("contrato.PDF")).toBe("contrato.pdf");
  });

  it("sobra só o que o Storage aceita como chave (ASCII seguro)", () => {
    const nome = nomeDoArquivoParaOCliente("Procuração/“ad judicia” & substabelecimento: Ação nº 12?");
    expect(nome).toMatch(/^[A-Za-z0-9._()-]+\.pdf$/);
    expect(nome).not.toContain("/");
  });

  it("nunca vazio: sem nada legível, vira Contrato.pdf", () => {
    expect(nomeDoArquivoParaOCliente("—— ··· ——")).toBe("Contrato.pdf");
  });

  it("corta nomes enormes sem terminar em separador", () => {
    const nome = nomeDoArquivoParaOCliente(`${"Contrato ".repeat(30)}fim`);
    expect(nome.length).toBeLessThanOrEqual(84);
    expect(nome).not.toMatch(/[._-]\.pdf$/);
  });
});

describe("onde o PDF mora", () => {
  it("original e via assinada ficam planos na pasta da organização (a Zona de perigo lista a pasta)", () => {
    expect(caminhoDoOriginal(ORG, CONTRATO)).toBe(`${ORG}/${CONTRATO}.pdf`);
    expect(caminhoDoAssinado(ORG, CONTRATO)).toBe(`${ORG}/${CONTRATO}-assinado.pdf`);
  });

  it("⭐ a cópia que sai ao cliente é aceita pelo envio de mídia da conversa — e o último segmento é o nome legível", () => {
    const copia = caminhoDaCopiaNaConversa(ORG, CONVERSA, CONTRATO, "Contrato_de_Honorarios.pdf");
    expect(isMediaPathOwnedBy(copia, ORG, CONVERSA)).toBe(true);
    expect(copia.split("/").pop()).toBe("Contrato_de_Honorarios.pdf");
    // controle: a mesma cópia NÃO é de outra conversa.
    expect(isMediaPathOwnedBy(copia, ORG, "44444444-4444-4444-8444-444444444444")).toBe(false);
  });
});

describe("é mesmo um PDF?", () => {
  it("confere os bytes, não a extensão nem o tipo declarado", () => {
    expect(pareceUmPdf(new TextEncoder().encode("%PDF-1.7\n..."))).toBe(true);
    expect(pareceUmPdf(new TextEncoder().encode("<html>contrato</html>"))).toBe(false);
    expect(pareceUmPdf(new TextEncoder().encode("%PD"))).toBe(false);
  });
});
