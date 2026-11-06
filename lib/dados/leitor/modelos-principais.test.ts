import { describe, expect, it } from "vitest";

import { custoEstimadoPorMes, principaisNoCatalogo } from "./modelos-principais";

describe("modelos principais do Leitor", () => {
  it("só os que estão no catálogo, na ordem da lista", () => {
    const catalogo = [
      { provider: "openai", model_id: "gpt-6-luna", display_name: "GPT-6 Luna", input_price_per_million_cents: 10, output_price_per_million_cents: 50 },
      { provider: "anthropic", model_id: "claude-haiku-5-5", display_name: "Haiku 5.5", input_price_per_million_cents: 10, output_price_per_million_cents: 50 },
      { provider: "anthropic", model_id: "modelo-fora-da-lista", display_name: "x", input_price_per_million_cents: 1, output_price_per_million_cents: 1 },
    ];
    expect(principaisNoCatalogo(catalogo).map((m) => m.model_id)).toEqual(["claude-haiku-5-5", "gpt-6-luna"]);
  });

  it("custo por mês: a conta da ordem (§10) — Haiku 5.5 ≈ US$ 0,26", () => {
    const haiku = { input_price_per_million_cents: 10, output_price_per_million_cents: 50 };
    expect(custoEstimadoPorMes(haiku, null)).toBeCloseTo(25.8, 5); // centavos de dólar
    expect(custoEstimadoPorMes(haiku, { leituras: 100, entradaMedia: 1000, saidaMedia: 100 })).toBeCloseTo(1.5, 5);
    expect(custoEstimadoPorMes({ input_price_per_million_cents: null, output_price_per_million_cents: 5 }, null)).toBeNull();
  });
});
