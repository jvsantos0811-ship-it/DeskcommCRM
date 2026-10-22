import { describe, expect, it } from "vitest";

import {
  calcularConversas,
  calcularNegocios,
  painelModelo,
  painelSchema,
  widgetSchema,
  type LinhaDeNegocio,
} from "@/lib/dados/widgets";

const FUSO = "America/Sao_Paulo";

function n(p: Partial<LinhaDeNegocio>): LinhaDeNegocio {
  return {
    status: "open",
    value_cents: 0,
    created_at: "2026-10-10T15:00:00Z",
    closed_at: null,
    stage: "Novo",
    funil: "Vendas",
    dono: "Ana",
    origem: "whatsapp",
    motivo: null,
    ...p,
  };
}

describe("dados — cálculo", () => {
  const linhas = [
    n({ status: "won", value_cents: 1000, closed_at: "2026-10-10T15:00:00Z" }),
    n({ status: "won", value_cents: 3000, closed_at: "2026-10-11T15:00:00Z", dono: "Bia" }),
    n({ status: "lost", value_cents: 500, closed_at: "2026-10-11T15:00:00Z", motivo: "Preço" }),
    n({ status: "open", value_cents: 700, stage: "Proposta" }),
  ];

  it("valor ganho soma só os ganhos", () => {
    expect(calcularNegocios({ metrica: "valor_ganho", agrupar_por: "nenhum" }, linhas, FUSO).total).toBe(4000);
  });

  it("taxa de conversão = ganhos / (ganhos + perdidos), em percentual", () => {
    expect(calcularNegocios({ metrica: "taxa_de_conversao", agrupar_por: "nenhum" }, linhas, FUSO).total).toBe(66.7);
  });

  it("ticket médio é a média dos ganhos", () => {
    expect(calcularNegocios({ metrica: "ticket_medio", agrupar_por: "nenhum" }, linhas, FUSO).total).toBe(2000);
  });

  it("agrupa por dia no fuso da organização e em ordem de data", () => {
    const r = calcularNegocios({ metrica: "negocios_ganhos", agrupar_por: "dia" }, linhas, FUSO);
    expect(r.serie).toEqual([
      { rotulo: "2026-10-10", valor: 1 },
      { rotulo: "2026-10-11", valor: 1 },
    ]);
  });

  it("21h de Brasília ainda é o mesmo dia, mesmo já sendo o seguinte em UTC", () => {
    const r = calcularNegocios(
      { metrica: "leads_criados", agrupar_por: "dia" },
      [n({ created_at: "2026-10-11T00:30:00Z" })],
      FUSO,
    );
    expect(r.serie[0]?.rotulo).toBe("2026-10-10");
  });

  it("agrupa por dono do maior para o menor", () => {
    const r = calcularNegocios({ metrica: "valor_ganho", agrupar_por: "dono" }, linhas, FUSO);
    expect(r.serie.map((p) => p.rotulo)).toEqual(["Bia", "Ana"]);
  });

  it("conversas por dia", () => {
    const r = calcularConversas(
      { agrupar_por: "dia" },
      [
        { created_at: "2026-10-10T12:00:00Z", dono: null },
        { created_at: "2026-10-10T13:00:00Z", dono: null },
      ],
      FUSO,
    );
    expect(r).toMatchObject({ total: 2, serie: [{ rotulo: "2026-10-10", valor: 2 }] });
  });
});

describe("dados — forma", () => {
  it("o painel modelo é válido", () => {
    expect(painelSchema.safeParse(painelModelo()).success).toBe(true);
  });

  it("número não agrupa e gráfico precisa agrupar", () => {
    const base = { id: "x", titulo: "T", metrica: "leads_criados", periodo_dias: 30 } as const;
    expect(widgetSchema.safeParse({ ...base, agrupar_por: "dia", visual: "numero" }).success).toBe(false);
    expect(widgetSchema.safeParse({ ...base, agrupar_por: "nenhum", visual: "linha" }).success).toBe(false);
  });

  it("motivo de perda só para métricas de perda", () => {
    const base = { id: "x", titulo: "T", periodo_dias: 30, visual: "barras" } as const;
    expect(widgetSchema.safeParse({ ...base, metrica: "negocios_ganhos", agrupar_por: "motivo" }).success).toBe(false);
    expect(widgetSchema.safeParse({ ...base, metrica: "negocios_perdidos", agrupar_por: "motivo" }).success).toBe(true);
  });

  it("período fora da lista é recusado", () => {
    expect(
      widgetSchema.safeParse({ id: "x", titulo: "T", metrica: "leads_criados", agrupar_por: "nenhum", visual: "numero", periodo_dias: 15 })
        .success,
    ).toBe(false);
  });
});
