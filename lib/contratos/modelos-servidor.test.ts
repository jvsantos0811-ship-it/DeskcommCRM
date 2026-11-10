import { describe, expect, it } from "vitest";

import { modeloNovoSchema, modeloPatchSchema, patchDoModelo } from "./modelos-servidor";

/**
 * O advogado aprovou um TEXTO, não o modelo para sempre (PC-030, item 2):
 * mudar o corpo ou os campos obrigatórios sobe a versão e tira a aprovação;
 * mudar nome, interesse ou ligado/desligado não mexe em nenhuma das duas.
 */
const ATUAL = { corpo: "Contrato de {{nome_completo}}, CPF {{cpf}}.", campos_obrigatorios: ["cpf", "nome_completo"], versao: 3 };

describe("patchDoModelo", () => {
  it("⭐ mudar o texto sobe a versão e tira a aprovação", () => {
    const { patch, mudouOTexto } = patchDoModelo(ATUAL, { corpo: "Contrato de {{nome_completo}}." });
    expect(mudouOTexto).toBe(true);
    expect(patch).toMatchObject({
      corpo: "Contrato de {{nome_completo}}.",
      versao: 4,
      aprovado_em: null,
      aprovado_por_nome: null,
      aprovado_por_user_id: null,
    });
  });

  it("⭐ mudar os campos obrigatórios também conta como mudar o texto", () => {
    const { patch, mudouOTexto } = patchDoModelo(ATUAL, { campos_obrigatorios: ["cpf", "nome_completo", "cep"] });
    expect(mudouOTexto).toBe(true);
    expect(patch.versao).toBe(4);
    expect(patch.aprovado_em).toBeNull();
  });

  it("a mesma lista em outra ordem, ou o mesmo texto, não muda nada", () => {
    expect(patchDoModelo(ATUAL, { campos_obrigatorios: ["nome_completo", "cpf"] }).mudouOTexto).toBe(false);
    const mesmo = patchDoModelo(ATUAL, { corpo: ATUAL.corpo });
    expect(mesmo.mudouOTexto).toBe(false);
    expect(mesmo.patch).not.toHaveProperty("versao");
    expect(mesmo.patch).not.toHaveProperty("aprovado_em");
  });

  it("nome, interesse e ligado/desligado não tocam versão nem aprovação", () => {
    const { patch, mudouOTexto } = patchDoModelo(ATUAL, { nome: "BPC/LOAS idoso", interesse: "  ", ativo: false });
    expect(mudouOTexto).toBe(false);
    expect(patch).toEqual({ nome: "BPC/LOAS idoso", interesse: null, ativo: false });
  });
});

describe("os formulários do modelo", () => {
  it("chave de campo só com letras, números e _; texto curto demais é recusado", () => {
    expect(modeloNovoSchema.safeParse({ nome: "BPC", corpo: "x".repeat(20), campos_obrigatorios: ["cpf"] }).success).toBe(true);
    expect(modeloNovoSchema.safeParse({ nome: "BPC", corpo: "curto" }).success).toBe(false);
    expect(modeloNovoSchema.safeParse({ nome: "BPC", corpo: "x".repeat(20), campos_obrigatorios: ["cpf; drop"] }).success).toBe(
      false,
    );
  });

  it("o PATCH não aceita campo que não existe (nem a aprovação por esta porta)", () => {
    expect(modeloPatchSchema.safeParse({ aprovado_em: "2026-11-10" }).success).toBe(false);
    expect(modeloPatchSchema.safeParse({ versao: 9 }).success).toBe(false);
  });
});
