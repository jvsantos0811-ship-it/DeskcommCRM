import { describe, expect, it } from "vitest";

import {
  camposDoModelo,
  cepFormatado,
  cpfValido,
  fraseDaFalta,
  preencherContrato,
  type DadosParaOContrato,
} from "./modelo-do-contrato";

const MODELO = {
  corpo:
    "CONTRATANTE: {{nome_completo}}, {{estado_civil}}, CPF {{cpf}}, residente em {{endereco}}, CEP {{cep}}.\n" +
    "Objeto: {{servico}}. {{escritorio}}, {{data_de_hoje}}.",
  campos_obrigatorios: ["nome_completo", "cpf", "advogado_ou_processo"],
};

function dados(over: Partial<DadosParaOContrato> = {}): DadosParaOContrato {
  return {
    contato: { nome: "Maria", telefone: "+5531998761234" },
    campos: {
      nome_completo: "Maria da Silva",
      estado_civil: "casada",
      cpf: "529.982.247-25",
      endereco: "Rua A, 10",
      cep: "30140071",
      servico: "Salário-maternidade",
      advogado_ou_processo: "não",
    },
    status: { nome_completo: "CONFIRMADO", cpf: "CONFIRMADO", advogado_ou_processo: "CONFIRMADO" },
    hoje: "10/11/2026",
    escritorio: "Escritório Teste",
    ...over,
  };
}

describe("CPF e CEP", () => {
  it("CPF com dígitos verificadores certos passa; errado, curto ou repetido não", () => {
    expect(cpfValido("529.982.247-25")).toBe(true);
    expect(cpfValido("52998224725")).toBe(true);
    expect(cpfValido("529.982.247-24")).toBe(false);
    expect(cpfValido("111.111.111-11")).toBe(false);
    expect(cpfValido("1234")).toBe(false);
    expect(cpfValido(null)).toBe(false);
  });

  it("CEP precisa de 8 números", () => {
    expect(cepFormatado("30140-071")).toBe("30140-071");
    expect(cepFormatado("30140071")).toBe("30140-071");
    expect(cepFormatado("3014007")).toBeNull();
  });
});

describe("preencher o modelo", () => {
  it("com tudo confirmado: troca as variáveis, formata CPF e CEP e devolve o CPF em dígitos", () => {
    const r = preencherContrato(MODELO, dados());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.texto).toContain("CONTRATANTE: Maria da Silva, casada, CPF 529.982.247-25");
    expect(r.texto).toContain("CEP 30140-071");
    expect(r.texto).toContain("Objeto: Salário-maternidade. Escritório Teste, 10/11/2026.");
    expect(r.texto).not.toContain("[a definir]");
    expect(r.cpf).toBe("52998224725");
  });

  it("campo vazio, não confirmado, CPF e CEP inválidos: diz o que falta, campo a campo", () => {
    const r = preencherContrato(
      MODELO,
      dados({
        campos: { ...dados().campos, estado_civil: "", cpf: "529.982.247-24", cep: "301" },
        status: { nome_completo: "PENDENTE", cpf: "CONFIRMADO", advogado_ou_processo: "CONFIRMADO" },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.faltas).toEqual(
      expect.arrayContaining([
        { campo: "nome_completo", motivo: "nao_confirmado" },
        { campo: "estado_civil", motivo: "vazio" },
        { campo: "cpf", motivo: "cpf_invalido" },
        { campo: "cep", motivo: "cep_invalido" },
      ]),
    );
  });

  it("campo obrigatório que nem aparece no texto também é cobrado", () => {
    const r = preencherContrato(MODELO, dados({ campos: { ...dados().campos, advogado_ou_processo: undefined } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.faltas).toContainEqual({ campo: "advogado_ou_processo", motivo: "vazio" });
  });

  it("as variáveis do sistema não viram campo do negócio", () => {
    expect(camposDoModelo(MODELO.corpo)).toEqual(["nome_completo", "estado_civil", "cpf", "endereco", "cep", "servico"]);
  });

  it("a frase da falta diz o que perguntar", () => {
    expect(fraseDaFalta({ campo: "cpf", motivo: "cpf_invalido" }, "CPF")).toContain("não é válido");
    expect(fraseDaFalta({ campo: "x", motivo: "vazio" }, "Estado civil")).toBe("Estado civil: falta perguntar ao cliente.");
  });
});
