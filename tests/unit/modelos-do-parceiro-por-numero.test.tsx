import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A aba "Modelos do parceiro" com dois números escolhe DE QUAL número são os
 * modelos; com um (ou sem acesso à lista), é a tela de sempre, na rota padrão.
 */
const getMock = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (...a: unknown[]) => getMock(...a) } }));
vi.mock("@/components/connections/TemplatesParceiroClient", () => ({
  TemplatesParceiroClient: ({ rota }: { rota?: string }) => <p data-testid="rota">{rota ?? "padrão"}</p>,
}));

import { ModelosDoParceiroPorNumero } from "@/components/connections/ModelosDoParceiroPorNumero";

const N1 = "22222222-2222-4222-8222-222222222222";
const N2 = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  getMock.mockReset();
});

describe("modelos do parceiro por número", () => {
  it("um número: a tela de sempre, sem escolha", async () => {
    getMock.mockResolvedValue({ data: { numbers: [{ channel_session_id: N1, display_name: "A", phone_number: "+1" }] } });
    render(<ModelosDoParceiroPorNumero />);
    expect(await screen.findByTestId("rota")).toHaveTextContent("padrão");
    expect(screen.queryByTestId("modelos-do-parceiro-numero")).not.toBeInTheDocument();
  });

  it("sem acesso à lista de números, a tela de sempre segue servindo", async () => {
    getMock.mockImplementation(() => Promise.reject(new Error("403")));
    render(<ModelosDoParceiroPorNumero />);
    // Espera a recusa ser tratada, para afirmar o estado DEPOIS dela.
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("rota")).toHaveTextContent("padrão");
  });

  it("dois números: começa no principal e troca a rota ao escolher o outro", async () => {
    getMock.mockResolvedValue({
      data: {
        numbers: [
          { channel_session_id: N1, display_name: "Anúncios", phone_number: "+5511911110001" },
          { channel_session_id: N2, display_name: "Equipe", phone_number: "+5511922220002" },
        ],
      },
    });
    render(<ModelosDoParceiroPorNumero />);
    const seletor = await screen.findByTestId("modelos-do-parceiro-numero");
    expect(screen.getByTestId("rota")).toHaveTextContent(`channel_session_id=${N1}`);
    fireEvent.change(seletor, { target: { value: N2 } });
    expect(screen.getByTestId("rota")).toHaveTextContent(`channel_session_id=${N2}`);
  });
});
