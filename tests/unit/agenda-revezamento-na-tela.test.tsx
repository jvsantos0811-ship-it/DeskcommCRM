/**
 * PC-054 — "Revezar entre agendas" na edição do tipo de atendimento.
 *
 * O que se prova pela tela, como quem configura usaria:
 *   1. as agendas que aparecem são as da conta Google de QUEM ATENDE o tipo;
 *   2. agenda que não conta para conflito aparece desabilitada, com o motivo;
 *   3. salvar manda as agendas marcadas, na ordem da tela;
 *   4. sem agenda nenhuma para escolher, a caixa não aparece e salvar não mexe
 *      no revezamento (o campo nem vai no corpo).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TiposDeAgendamentoClient, type TipoRow } from "@/app/app/settings/tenant/agenda/_client";

const h = vi.hoisted(() => ({ patch: vi.fn(async () => ({ id: "x" })) }));

vi.mock("@/lib/api/client", () => ({ apiClient: { patch: h.patch, post: vi.fn(), delete: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/agenda/AgendasConectadas", () => ({ AgendasConectadas: () => null }));
vi.mock("@/components/agenda/PrazosDePresenca", () => ({ PrazosDePresenca: () => null }));
vi.mock("@/components/agenda/ClientePelaAgenda", () => ({ ClientePelaAgenda: () => null }));
vi.mock("@/components/agenda/DiasBloqueados", () => ({ DiasBloqueados: () => null }));

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DONO = "user-dono";
const MARIA = "agenda-maria";
const JESSICA = "agenda-jessica";
const PESSOAL = "agenda-pessoal";

const TIPO: TipoRow = {
  id: ID,
  name: "Ligação",
  slug: "ligacao",
  description: null,
  category: "call",
  duration_minutes: 40,
  location_kind: "phone",
  location_details: null,
  default_owner_user_id: DONO,
  rotation_calendar_ids: [MARIA],
  requires_confirmation: false,
  is_active: true,
  default_price_cents: null,
  reminder_enabled: false,
  reminder_minutes_before: 1440,
  reminder_extra_offsets_minutes: null,
  reminder_body: null,
  reminder_bodies: null,
};

function desenhar(tipo: TipoRow, agendasPorDono: Parameters<typeof TiposDeAgendamentoClient>[0]["agendasPorDono"]) {
  render(
    <TiposDeAgendamentoClient
      tiposIniciais={[tipo]}
      pessoas={[{ id: DONO, papel: "admin", nome: "João" }]}
      podeEditar
      usuarioAtualId={DONO}
      podeConfigurarGoogle={false}
      clientePelaAgendaLigado={false}
      colegasPodemMexerNaAgendaLigado={true}
      podeMudarAgendaDosColegas={false}
      podeLigarClientePelaAgenda={false}
      meetAbertoLigado={false}
      podeMudarMeetAberto={false}
      agendasPorDono={agendasPorDono}
    />,
  );
}

afterEach(() => {
  cleanup();
  h.patch.mockClear();
});

describe("revezar entre agendas — a tela (PC-054)", () => {
  it("mostra as agendas de quem atende, desabilita a que não conta conflito e salva as marcadas", async () => {
    desenhar(TIPO, {
      [DONO]: [
        { id: MARIA, nome: "Maria Vitória", motivo: null },
        { id: JESSICA, nome: "Jessica", motivo: null },
        { id: PESSOAL, nome: "Pessoal", motivo: "nao_conta_conflito" },
      ],
      "outra-pessoa": [{ id: "agenda-alheia", nome: "Alheia", motivo: null }],
    });
    await userEvent.click(screen.getByTestId(`editar-${ID}`));

    const caixa = screen.getByTestId(`editar-revezamento-${ID}`);
    const maria = within(caixa).getByRole("checkbox", { name: /Maria Vitória/ });
    const jessica = within(caixa).getByRole("checkbox", { name: /Jessica/ });
    const pessoal = within(caixa).getByRole("checkbox", { name: /Pessoal/ });
    expect(maria).toBeChecked();
    expect(jessica).not.toBeChecked();
    expect(pessoal).toBeDisabled();
    expect(within(caixa).getByText(/não conta para conflito/)).toBeTruthy();
    expect(within(caixa).queryByText("Alheia"), "apareceu agenda de outra pessoa").toBeNull();

    await userEvent.click(jessica);
    await userEvent.click(screen.getByTestId(`salvar-${ID}`));

    expect(h.patch).toHaveBeenCalledTimes(1);
    const corpo = (h.patch.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(corpo.rotation_calendar_ids).toEqual([MARIA, JESSICA]);
  });

  it("sem agenda para escolher, a caixa não aparece e o revezamento não vai no corpo", async () => {
    desenhar({ ...TIPO, rotation_calendar_ids: null }, {});
    await userEvent.click(screen.getByTestId(`editar-${ID}`));
    expect(screen.queryByTestId(`editar-revezamento-${ID}`)).toBeNull();
    await userEvent.click(screen.getByTestId(`salvar-${ID}`));
    const corpo = (h.patch.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect("rotation_calendar_ids" in corpo).toBe(false);
  });
});
