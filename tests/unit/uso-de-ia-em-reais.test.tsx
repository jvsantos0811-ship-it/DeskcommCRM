import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * A TELA "USO DE IA" ESCREVE EM REAIS (pedido do dono, 25/11/2026).
 *
 * O banco continua em centavo de DÓLAR — é o que o provedor cobra e o que o
 * teto compara. A conversão é só de tela, pela cotação do painel da agência, e
 * a cotação aparece escrita. O que se prova aqui:
 *
 *  1. com a cotação, o gasto e o limite saem em R$ e a régua aparece;
 *  2. o limite digitado em R$ vai ao servidor em centavo de DÓLAR;
 *  3. sem a cotação, o card fica em dólar como antes (controle).
 */

const { patch } = vi.hoisted(() => ({
  patch: vi.fn(async (_url: string, corpo: Record<string, unknown>) => ({ data: corpo })),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), patch: (url: string, corpo: Record<string, unknown>) => patch(url, corpo) },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { BudgetCard } from "@/components/ai/BudgetCard";
import { UsageChart } from "@/components/ai/UsageChart";
import type { UsagePayload } from "@/lib/ai/usage/aggregate";
import type { BudgetStatus } from "@/lib/ai/budget/check";
import { formatCentsUSDEmReais } from "@/lib/money";

function estado(over: Partial<BudgetStatus> = {}): BudgetStatus {
  return {
    organization_id: "22222222-2222-4222-8222-222222222222",
    monthly_limit_cents: 5000,
    current_month_consumed_cents: 100,
    pct: 2,
    alarm_threshold_pct: 80,
    enforcement_mode: "avisar",
    enforcement_effective_at: null,
    enforcement_env: "on",
    blocked_now: false,
    gasto_incompleto: false,
    current_period_start: "2026-11-01",
    last_alarm_sent_at: null,
    updated_at: "2026-11-15T00:00:00.000Z",
    ...over,
  };
}

function montar(status: BudgetStatus, cotacao?: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BudgetCard initialData={status} isAdmin cotacao={cotacao} />
    </QueryClientProvider>,
  );
}

/** Espaço do Intl (U+00A0) normalizado, para comparar com texto escrito à mão. */
function texto(el: HTMLElement): string {
  return (el.textContent ?? "").replace(/\s/g, " ");
}

describe("formatCentsUSDEmReais", () => {
  it("converte centavo de dólar pela cotação e escreve em reais", () => {
    expect(formatCentsUSDEmReais(5000, 5.5).replace(/\s/g, " ")).toBe("R$ 275,00");
    expect(formatCentsUSDEmReais(0, 5.5).replace(/\s/g, " ")).toBe("R$ 0,00");
  });

  it("no custo por turno guarda as casas que fazem diferença", () => {
    expect(formatCentsUSDEmReais(0.3, 5.5, 4).replace(/\s/g, " ")).toBe("R$ 0,0165");
  });
});

describe("o card do orçamento em reais", () => {
  it("gasto e limite saem em R$, e a cotação usada aparece escrita", () => {
    const { container } = montar(estado(), 5.5);
    const tudo = texto(container);
    expect(tudo).toContain("R$ 5,50 gastos de R$ 275,00");
    expect(tudo).toContain("US$ 1,00 = R$ 5,50");
    expect(tudo, "o gasto não pode aparecer em dólar").not.toContain("US$ 1,00 gastos");
    expect(tudo).not.toMatch(/valores em dólar/u);
  });

  it("o limite digitado em reais vai ao servidor em centavo de DÓLAR", async () => {
    // A rota devolve o estado inteiro; o card relê dele depois de salvar.
    patch.mockImplementation(async (_url, corpo) => ({ data: { ...estado(), ...corpo } }));
    montar(estado(), 5.5);
    fireEvent.click(screen.getByRole("button", { name: "Editar limite" }));
    const campo = await screen.findByLabelText("Limite mensal (R$)");
    expect(campo).toHaveValue(275);

    fireEvent.change(campo, { target: { value: "550" } });
    // A frase mostra o que foi digitado, sem a ida e volta pelo dólar.
    expect(texto(screen.getByTestId("opcao-orcamento-avisar"))).toContain("R$ 550,00");

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    const [, corpo] = patch.mock.calls.at(-1)!;
    expect(corpo.monthly_limit_cents, "R$ 550,00 a 5,50 = US$ 100,00").toBe(10000);
  });

  it("sem a cotação, o card fica em dólar como antes (controle)", () => {
    const { container } = montar(estado());
    const tudo = texto(container);
    expect(tudo).toContain("US$ 1,00 gastos de US$ 50,00");
    expect(tudo).toMatch(/valores em dólar/u);
  });
});

/** Período sem gasto: o cartão do gráfico mostra o título sem desenhar o eixo. */
function payloadVazio(): UsagePayload {
  return {
    range: { from: "2026-11-01", to: "2026-11-25" },
    totals: {
      cost_cents: 0,
      total_tokens: 0,
      invocations: 0,
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_hit_rate: 0,
      agent_turns: 0,
      avg_cost_per_turn_cents: null,
      p50_latency_ms: 0,
      p95_latency_ms: 0,
      handoff_rate: 0,
    },
    series: { cost_cents: [], total_tokens: [], p50_latency_ms: [], p95_latency_ms: [], handoff_rate: [] },
    by_kind: {},
  };
}

describe("o gráfico de custo diz a moeda do eixo", () => {
  it("com a cotação, o título fala em R$", () => {
    render(<UsageChart payload={payloadVazio()} cotacao={5.5} />);
    expect(screen.getByText("Quanto gastou por dia (R$)")).toBeInTheDocument();
    expect(screen.queryByText("Quanto gastou por dia (US$)")).toBeNull();
  });

  it("sem a cotação, segue em US$ (controle)", () => {
    render(<UsageChart payload={payloadVazio()} />);
    expect(screen.getByText("Quanto gastou por dia (US$)")).toBeInTheDocument();
  });
});
