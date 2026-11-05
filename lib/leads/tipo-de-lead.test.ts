import { describe, expect, it } from "vitest";

import { conferirInteresse } from "@/lib/mcp/conferencia-de-campos";
import { formatarCamposDoNegocio } from "@/lib/agent-engine/agent/campos-do-negocio-no-turno";

import { linhaDosTiposDeLead, normalizarNomeDoTipo, resolverInteresse } from "./tipo-de-lead";

const TIPOS = [{ nome: "Auxílio-acidente" }, { nome: "BPC/LOAS" }, { nome: "Salário-maternidade" }];

describe("normalizarNomeDoTipo — sem maiúscula, acento nem pontuação", () => {
  it.each([
    ["Auxílio-acidente", "auxilio acidente"],
    ["  AUXILIO   ACIDENTE ", "auxilio acidente"],
    ["BPC/LOAS", "bpc loas"],
    ["bpc-loas", "bpc loas"],
    ["Salário Maternidade!", "salario maternidade"],
    ["", ""],
  ])("%s → %s", (entrada, saida) => {
    expect(normalizarNomeDoTipo(entrada)).toBe(saida);
  });
});

describe("resolverInteresse — a IA grava o nome EXATO do catálogo", () => {
  it("grafia diferente casa e devolve o nome do catálogo", () => {
    expect(resolverInteresse("auxilio acidente", TIPOS)).toEqual({ ok: true, nome: "Auxílio-acidente" });
    expect(resolverInteresse("Bpc Loas", TIPOS)).toEqual({ ok: true, nome: "BPC/LOAS" });
  });

  it("nome que não existe é recusado com os nomes válidos", () => {
    const r = resolverInteresse("Aposentadoria", TIPOS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mensagem).toContain('"Aposentadoria" não é um tipo de lead');
    expect(r.mensagem).toContain("Auxílio-acidente; BPC/LOAS; Salário-maternidade");
  });

  it("valor que não é texto (ou só pontuação) é recusado", () => {
    expect(resolverInteresse(42, TIPOS).ok).toBe(false);
    expect(resolverInteresse(" / ", TIPOS).ok).toBe(false);
  });

  it("não casa por pedaço: 'auxilio' sozinho não é 'Auxílio-acidente'", () => {
    expect(resolverInteresse("auxilio", TIPOS).ok).toBe(false);
  });
});

describe("linhaDosTiposDeLead — a linha do bloco do turno", () => {
  it("vazia sem tipos; com tipos, lista os nomes", () => {
    expect(linhaDosTiposDeLead([])).toBe("");
    expect(linhaDosTiposDeLead(["BPC/LOAS", "Implante"])).toContain("custom_fields.servico");
    expect(linhaDosTiposDeLead(["BPC/LOAS", "Implante"])).toContain("BPC/LOAS; Implante");
  });

  it("o bloco do negócio aparece só com os tipos, mesmo sem campos do funil", () => {
    const bloco = formatarCamposDoNegocio({
      etapa: "Novo",
      settings: {},
      custom_fields: {},
      status_dos_campos: {},
      tipos_de_lead: ["BPC/LOAS"],
    });
    expect(bloco).toContain("## Campos do negócio (etapa atual: Novo)");
    expect(bloco).toContain("Tipos de lead do escritório");
    expect(bloco).not.toContain("Formato: nome: status");
    expect(formatarCamposDoNegocio({ etapa: "X", settings: {}, custom_fields: {}, status_dos_campos: {} })).toBe("");
  });
});

/** Um Supabase de mentira que só responde a lista de tipos de lead. */
function bancoCom(nomes: string[] | "erro") {
  const lidas: string[] = [];
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    order: () => cadeia,
    limit: async () =>
      nomes === "erro" ? { data: null, error: { message: "x" } } : { data: nomes.map((nome) => ({ nome })), error: null },
  };
  return {
    lidas,
    ctx: {
      organizationId: "org-1",
      supabase: {
        from: (t: string) => {
          lidas.push(t);
          return cadeia;
        },
      },
    } as never,
  };
}

describe("conferirInteresse — a porta do `crm_update_lead`", () => {
  it("sem `servico` na chamada não lê nada", async () => {
    const b = bancoCom(["BPC/LOAS"]);
    expect(await conferirInteresse(b.ctx, { outro: 1 })).toEqual({ custom_fields: { outro: 1 }, recusados: [] });
    expect(b.lidas).toEqual([]);
  });

  it("troca pela grafia do catálogo e mantém as outras chaves", async () => {
    const b = bancoCom(["BPC/LOAS"]);
    expect(await conferirInteresse(b.ctx, { servico: "bpc loas", cidade: "Recife" })).toEqual({
      custom_fields: { servico: "BPC/LOAS", cidade: "Recife" },
      recusados: [],
    });
  });

  it("recusa só a chave `servico`, com erro de ensino", async () => {
    const b = bancoCom(["BPC/LOAS"]);
    const r = await conferirInteresse(b.ctx, { servico: "Divórcio", cidade: "Recife" });
    expect(r.custom_fields).toEqual({ cidade: "Recife" });
    expect(r.recusados).toHaveLength(1);
    expect(r.recusados[0]).toMatchObject({ campo: "servico", motivo: "tipo_de_lead_desconhecido" });
    expect(r.recusados[0]!.mensagem).toContain("BPC/LOAS");
  });

  it("organização sem tipo de lead cadastrado e leitura que falha deixam passar como veio", async () => {
    expect((await conferirInteresse(bancoCom([]).ctx, { servico: "reforma" })).custom_fields).toEqual({ servico: "reforma" });
    expect((await conferirInteresse(bancoCom("erro").ctx, { servico: "reforma" })).custom_fields).toEqual({
      servico: "reforma",
    });
  });

  it("`null` apaga o interesse sem conferir", async () => {
    const b = bancoCom(["BPC/LOAS"]);
    expect((await conferirInteresse(b.ctx, { servico: null })).custom_fields).toEqual({ servico: null });
    expect(b.lidas).toEqual([]);
  });
});

describe("rotuloDoInteresse — o nome da coluna vem do vocabulário do funil (v3 §1.4)", () => {
  it("o que o dono escreveu, ou null (a tela mostra \"Interesse\")", async () => {
    const { rotuloDoInteresse, resolveVocabulary, ROTULO_PADRAO_DO_INTERESSE } = await import("@/lib/kanban/vocabulary");
    expect(rotuloDoInteresse({ interesse: "Benefício" })).toBe("Benefício");
    expect(rotuloDoInteresse({ interesse: "  " })).toBeNull();
    expect(rotuloDoInteresse(null)).toBeNull();
    expect(ROTULO_PADRAO_DO_INTERESSE).toBe("Interesse");
    expect(resolveVocabulary({ lead: "Cliente" }).interesse).toBe("Interesse");
  });
});
