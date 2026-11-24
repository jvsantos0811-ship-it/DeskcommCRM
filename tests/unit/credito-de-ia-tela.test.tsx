/**
 * PC-051 — o bloco "Crédito de IA extra" em Plano e cobrança, como a empresa o vê.
 *
 * Sem pacote (ou sem a oferta) e sem histórico, a tela fica como antes: o bloco
 * não aparece. Com a oferta, o uso do plano e o crédito restante aparecem em
 * PORCENTAGEM — nunca dólar nem o custo da IA convertido em reais.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn() } }));

import { CreditoDeIa } from "@/components/cobranca/CreditoDeIa";
import type { ExtratoDeCredito } from "@/lib/cobranca/credito-ia";

afterEach(cleanup);

const BASE: ExtratoDeCredito = {
  motivoSemOferta: null,
  pacotes: [{ id: "p1", nome: "Pacote 100", preco_cents: 10000 }],
  mes: { uso_do_plano_pct: 73, credito_restante_pct: null },
  pendentes: [],
  historico: [],
};

describe("Crédito de IA extra na tela da empresa", () => {
  it("⭐ sem pacote e sem histórico: o bloco não aparece (como antes)", () => {
    for (const motivo of ["sem_pacote", "plano_sem_oferta", "assinatura_nao_ativa"] as const) {
      const { container } = render(<CreditoDeIa extrato={{ ...BASE, motivoSemOferta: motivo, pacotes: [] }} fuso={null} />);
      expect(container.innerHTML, motivo).toBe("");
      cleanup();
    }
  });

  it("⭐ com a oferta: uso em %, sem dólar e sem valor do incluído no plano", () => {
    render(<CreditoDeIa extrato={{ ...BASE, mes: { uso_do_plano_pct: 100, credito_restante_pct: 40 } }} fuso={null} />);
    expect(screen.getByTestId("uso-do-plano").textContent).toBe("100%");
    expect(screen.getByTestId("saldo-de-credito").textContent).toBe("40%");
    const texto = screen.getByTestId("credito-de-ia").textContent ?? "";
    expect(texto).not.toContain("US$");
    expect(texto).not.toMatch(/Incluído no plano\s*R\$/);
    expect(screen.getByRole("button", { name: "Comprar" })).toBeTruthy();
  });

  it("histórico de quem já comprou continua visível, pelo valor pago", () => {
    render(
      <CreditoDeIa
        extrato={{
          ...BASE,
          motivoSemOferta: "sem_pacote",
          pacotes: [],
          historico: [
            { id: "h1", origem: "compra", status: "pago", preco_cents: 10000, pago_em: "2026-11-23T15:00:00Z", vence_em: "2027-01-01T00:00:00Z", criado_em: "2026-11-23T14:00:00Z" },
          ],
        }}
        fuso="America/Sao_Paulo"
      />,
    );
    expect(screen.getByTestId("credito-de-ia").textContent).toMatch(/R\$\s?100,00/);
    expect(screen.queryByRole("button", { name: "Comprar" })).toBeNull();
  });
});
