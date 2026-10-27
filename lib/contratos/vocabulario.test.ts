import { describe, expect, it } from "vitest";

import { provedorDeAssinatura } from "./provedores";
import { PROVEDORES_DE_ASSINATURA, STATUS_DO_CONTRATO, ehFinal, podeDecidir, podeEnviar } from "./vocabulario";

describe("o ciclo de vida do contrato", () => {
  it("envia do rascunho, e de novo quando o cliente pede outra via; nunca depois de encerrado", () => {
    expect(STATUS_DO_CONTRATO.filter(podeEnviar)).toEqual(["rascunho", "enviado"]);
  });

  it("⭐ só se assina ou recusa o que SAIU — não o que o cliente nunca recebeu", () => {
    expect(STATUS_DO_CONTRATO.filter((s) => podeDecidir(s, "assinado"))).toEqual(["enviado"]);
    expect(STATUS_DO_CONTRATO.filter((s) => podeDecidir(s, "recusado"))).toEqual(["enviado"]);
  });

  it("cancela o que ainda não terminou; o que terminou fica como está", () => {
    expect(STATUS_DO_CONTRATO.filter((s) => podeDecidir(s, "cancelado"))).toEqual(["rascunho", "enviado"]);
    for (const s of STATUS_DO_CONTRATO.filter(ehFinal)) {
      expect(podeEnviar(s)).toBe(false);
      expect(podeDecidir(s, "cancelado")).toBe(false);
    }
  });
});

describe("o encaixe do serviço de assinatura", () => {
  it("todo provedor do vocabulário tem adaptador", () => {
    for (const id of PROVEDORES_DE_ASSINATURA) expect(provedorDeAssinatura(id).id).toBe(id);
  });

  it("o manual não prepara nada: o PDF vai como está e uma pessoa marca o desfecho", async () => {
    const manual = provedorDeAssinatura("manual");
    expect(manual.desfechoPorPessoa).toBe(true);
    await expect(
      manual.preparar({ organizationId: "o", contratoId: "c", pdf: Buffer.from("%PDF-"), nomeDoArquivo: "x.pdf" }),
    ).resolves.toEqual({ documentoId: null, linkAssinatura: null });
  });
});
