import { describe, expect, it } from "vitest";

import { diasDesde, periodoValido, resumir, SEM_MOTIVO, type NegocioPerdido } from "@/lib/leads/recuperacao";

function negocio(p: Partial<NegocioPerdido>): NegocioPerdido {
  return {
    id: Math.random().toString(36),
    title: "Negócio",
    value_cents: 0,
    currency: "BRL",
    lost_reason: null,
    closed_at: "2026-10-01T00:00:00Z",
    pipeline_id: "p1",
    pipeline_nome: "Funil",
    owner_user_id: null,
    contact_id: null,
    contato_nome: null,
    conversa_id: null,
    retomado: false,
    ...p,
  };
}

describe("recuperação de perdidos — resumo", () => {
  it("ordena motivos pela quantidade e depois pelo valor", () => {
    const r = resumir([
      negocio({ lost_reason: "Preço", value_cents: 100 }),
      negocio({ lost_reason: "Preço", value_cents: 200 }),
      negocio({ lost_reason: "Sumiu", value_cents: 5000 }),
      negocio({ lost_reason: "  ", value_cents: 1 }),
    ]);
    expect(r.motivos.map((m) => m.motivo)).toEqual(["Preço", "Sumiu", SEM_MOTIVO]);
    expect(r.motivos[0]).toMatchObject({ quantidade: 2, valor_cents: 300 });
  });

  it("não soma moedas diferentes", () => {
    const r = resumir([negocio({ value_cents: 100 }), negocio({ value_cents: 50, currency: "USD" })]);
    expect(r.valor_por_moeda).toEqual({ BRL: 100, USD: 50 });
  });

  it("conta os que ainda não foram retomados", () => {
    expect(resumir([negocio({ retomado: true }), negocio({})]).ainda_nao_retomados).toBe(1);
  });
});

describe("recuperação de perdidos — régua", () => {
  it("período fora da lista cai no padrão", () => {
    expect(periodoValido("30")).toBe(30);
    expect(periodoValido("7")).toBe(90);
    expect(periodoValido(null)).toBe(90);
  });

  it("dias desde o encerramento", () => {
    expect(diasDesde("2026-10-01T00:00:00Z", new Date("2026-10-11T12:00:00Z"))).toBe(10);
  });
});
