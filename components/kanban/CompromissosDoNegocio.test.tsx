import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PC-027 — o pop-up do negócio agenda pelo MESMO serviço da Agenda. Prova que:
 * sem tipo de agendamento o formulário não abre vazio (mostra o aviso); as
 * ações de cada compromisso chamam os hooks da Agenda; desmarcar exige motivo.
 */

const estado = vi.hoisted(() => ({
  tipos: [] as unknown[],
  compromissos: [] as unknown[],
  desfecho: vi.fn(),
  cancelar: vi.fn(),
  marcar: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (url: string) =>
      url.startsWith("/api/v1/agenda/tipos") ? { data: estado.tipos } : { data: estado.compromissos },
    ),
  },
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ timezone: "America/Sao_Paulo" }) }));
vi.mock("@/hooks/agenda/usePessoasDaAgenda", () => ({ usePessoasDaAgenda: () => ({ data: [] }) }));
vi.mock("@/hooks/agenda/useHorariosLivres", () => ({
  useHorariosLivres: () => ({ data: { slots: [], publicou_horarios: true }, isLoading: false, refetch: vi.fn() }),
}));
vi.mock("@/hooks/agenda/useMarcarAgendamento", () => ({
  useMarcarAgendamento: () => ({ mutate: estado.marcar, isPending: false }),
}));
vi.mock("@/hooks/agenda/useRemarcarAgendamento", () => ({
  useRemarcarAgendamento: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelarAgendamento: () => ({ mutate: estado.cancelar, isPending: false }),
  useRegistrarDesfecho: () => ({ mutate: estado.desfecho, isPending: false }),
}));

import { CompromissosDoNegocio, DialogoDeHorario } from "./CompromissosDoNegocio";

function comQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const daqui = (dias: number) => new Date(Date.now() + dias * 86_400_000).toISOString();

beforeEach(() => {
  estado.tipos = [];
  estado.compromissos = [];
  estado.desfecho.mockReset();
  estado.cancelar.mockReset();
});

describe("agendar pelo pop-up (PC-027)", () => {
  it("sem tipo de agendamento: o aviso de cadastrar, nunca um formulário vazio", async () => {
    comQuery(<DialogoDeHorario modo="marcar" contactId="c1" conversationId={null} fuso="America/Sao_Paulo" onFechar={() => {}} />);
    expect(await screen.findByTestId("agendar-sem-tipo")).toBeTruthy();
    expect(screen.queryByTestId("confirmar-agendar")).toBeNull();
    expect(screen.queryByTestId("agendar-tipo")).toBeNull();
  });

  it("confirmar chama o desfecho da Agenda; desmarcar exige o motivo", async () => {
    estado.compromissos = [
      { id: "a1", revision: 3, titulo: "Consulta", iniciaEm: daqui(2), terminaEm: daqui(2.1), situacao: "pending", donoId: "d" },
    ];
    comQuery(<CompromissosDoNegocio contactId="c1" conversationId={null} podeAgendar aberto />);
    await waitFor(() => expect(screen.getByTestId("compromisso-do-negocio")).toBeTruthy());
    fireEvent.click(screen.getByTestId("compromisso-confirmar"));
    expect(estado.desfecho).toHaveBeenCalledWith({ id: "a1", revision: 3, status: "confirmed" });

    fireEvent.click(screen.getByTestId("compromisso-desmarcar"));
    const confirmar = (await screen.findByTestId("confirmar-desmarcar")) as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("motivo-de-desmarcar"), { target: { value: "cliente pediu" } });
    fireEvent.click(screen.getByTestId("confirmar-desmarcar"));
    expect(estado.cancelar).toHaveBeenCalledWith(
      { id: "a1", revision: 3, reason: "cliente pediu" },
      expect.anything(),
    );
  });

  it("quem só lê vê os compromissos sem botões", async () => {
    estado.compromissos = [
      { id: "a1", titulo: "Consulta", iniciaEm: daqui(2), terminaEm: daqui(2.1), situacao: "confirmed", donoId: "d" },
    ];
    comQuery(<CompromissosDoNegocio contactId="c1" conversationId={null} podeAgendar={false} aberto />);
    await waitFor(() => expect(screen.getByTestId("compromisso-do-negocio")).toBeTruthy());
    expect(screen.queryByTestId("agendar-no-negocio")).toBeNull();
    expect(screen.queryByTestId("compromisso-remarcar")).toBeNull();
  });
});
