import { describe, expect, it } from "vitest";

import {
  doisNomes,
  lerModeloDoEvento,
  montarDescricao,
  montarTitulo,
  TITULO_SUGERIDO,
} from "./modelo-do-evento";

const ROTULOS = {
  atendimento: "Atendimento",
  etapa: "Etapa",
  proximaAcao: "Próxima ação",
  resumo: "Resumo da conversa",
  observacao: "Observação",
};

const DADOS = {
  tipo: "Consulta inicial",
  nomeDoContato: "Maria  da Silva Souza",
  telefone: "+55 (31) 98765-4321",
  etapa: "Qualificado",
  proximaAcao: "Trazer os documentos do plano",
  resumoDaConversa: "Resumo com fato sensível",
  descricaoDeQuemMarcou: "Observação da IA",
};

describe("lerModeloDoEvento", () => {
  it("ausente, torto ou incompleto é sem modelo (comportamento de sempre)", () => {
    expect(lerModeloDoEvento(null)).toBeNull();
    expect(lerModeloDoEvento({})).toBeNull();
    expect(lerModeloDoEvento({ modelo_do_evento_agenda: "x" })).toBeNull();
    expect(lerModeloDoEvento({ modelo_do_evento_agenda: { titulo: "" , descricao: "basica" } })).toBeNull();
    expect(lerModeloDoEvento({ modelo_do_evento_agenda: { titulo: "a", descricao: "tudo" } })).toBeNull();
    expect(lerModeloDoEvento([])).toBeNull();
  });

  it("lê o modelo gravado", () => {
    expect(
      lerModeloDoEvento({ modelo_do_evento_agenda: { titulo: TITULO_SUGERIDO, descricao: "basica" } }),
    ).toEqual({ titulo: TITULO_SUGERIDO, descricao: "basica" });
  });
});

describe("montarTitulo", () => {
  it("primeiro nome e final do telefone (o sugerido)", () => {
    expect(montarTitulo(TITULO_SUGERIDO, DADOS)).toBe("Consulta inicial – Maria – final 4321");
  });

  it("nome completo e telefone inteiro só com dígitos", () => {
    expect(montarTitulo("{nome_completo} – {telefone}", DADOS)).toBe(
      "Maria da Silva Souza – +5531987654321",
    );
  });

  it("dois nomes no padrão da agenda do escritório (PC-052, Samantha)", () => {
    expect(montarTitulo("{dois_nomes} - {final_telefone} - REPARADORA", DADOS)).toBe(
      "Maria da Silva - 4321 - REPARADORA",
    );
    expect(
      montarTitulo("{dois_nomes} - {final_telefone} - REPARADORA", { ...DADOS, nomeDoContato: "Laura Beatriz Martins" }),
    ).toBe("Laura Beatriz - 4321 - REPARADORA");
    // Sem nome: o campo some e o separador que sobraria também.
    expect(
      montarTitulo("{dois_nomes} - {final_telefone} - REPARADORA", { ...DADOS, nomeDoContato: null }),
    ).toBe("4321 - REPARADORA");
  });

  it("doisNomes: a partícula entre os nomes não conta como nome", () => {
    expect(doisNomes("Ana")).toBe("Ana");
    expect(doisNomes("Ana Souza")).toBe("Ana Souza");
    expect(doisNomes("Laura Beatriz Martins")).toBe("Laura Beatriz");
    expect(doisNomes("Maria da Silva Santos")).toBe("Maria da Silva");
    expect(doisNomes("João dos Santos")).toBe("João dos Santos");
    expect(doisNomes("Pedro De Souza Lima")).toBe("Pedro De Souza");
    expect(doisNomes("Maria da")).toBe("Maria da");
    expect(doisNomes("")).toBe("");
  });

  it("campo sem valor some junto com o separador que sobraria", () => {
    expect(
      montarTitulo(TITULO_SUGERIDO, { tipo: "Consulta", nomeDoContato: null, telefone: null }),
    ).toBe("Consulta");
  });

  it("campo desconhecido fica como está, para a pessoa ver e corrigir", () => {
    expect(montarTitulo("{tipo} {cpf}", DADOS)).toBe("Consulta inicial {cpf}");
  });

  it("modelo que fica vazio cai no nome do tipo", () => {
    expect(montarTitulo("{primeiro_nome}", { tipo: "Visita" })).toBe("Visita");
  });

  it("a palavra final do nome do tipo fica; só o par sem telefone some", () => {
    expect(montarTitulo("{tipo} – {primeiro_nome}", { ...DADOS, tipo: "Reunião final" })).toBe(
      "Reunião final – Maria",
    );
    expect(montarTitulo(TITULO_SUGERIDO, { ...DADOS, telefone: null })).toBe("Consulta inicial – Maria");
  });

  it("vírgula sobrando no fim some", () => {
    expect(montarTitulo("{tipo}, {primeiro_nome}", { tipo: "Consulta" })).toBe("Consulta");
  });

  it("respeita o teto de 200", () => {
    expect(montarTitulo("x".repeat(300), DADOS).length).toBe(200);
  });
});

describe("montarDescricao", () => {
  it("nenhuma não mexe no que veio", () => {
    expect(montarDescricao("nenhuma", DADOS, ROTULOS)).toBeNull();
  });

  it("básica NÃO leva o resumo nem a observação (LGPD)", () => {
    const d = montarDescricao("basica", DADOS, ROTULOS)!;
    expect(d).toContain("Atendimento: Consulta inicial");
    expect(d).toContain("Etapa: Qualificado");
    expect(d).toContain("Próxima ação: Trazer os documentos do plano");
    expect(d).not.toContain("fato sensível");
    expect(d).not.toContain("Observação da IA");
  });

  it("completa leva o resumo e a observação", () => {
    const d = montarDescricao("completa", DADOS, ROTULOS)!;
    expect(d).toContain("Resumo da conversa:\nResumo com fato sensível");
    expect(d).toContain("Observação:\nObservação da IA");
  });

  it("sem dado nenhum devolve null", () => {
    expect(montarDescricao("basica", { tipo: "" }, ROTULOS)).toBeNull();
  });
});
