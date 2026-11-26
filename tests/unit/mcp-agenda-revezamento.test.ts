import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type * as AgendaConsulta from "@/lib/agenda/consulta";
import type { ResultadoDaConsulta } from "@/lib/agenda/consulta";
import type { McpContext } from "@/lib/mcp/types";

/**
 * PC-054 — o que as ferramentas MCP de agenda mudaram com o revezamento entre agendas:
 *   1. `crm_find_free_slots` com `appointment_id` (remarcar) consulta a agenda do
 *      próprio compromisso — e o campo só vale para compromisso desta organização
 *      e, num turno de atendimento, do contato desta conversa;
 *   2. `crm_book_appointment` diz em que agenda o compromisso ficou (`agenda`);
 *   3. `crm_list_appointments` diz a agenda de cada compromisso, pelo nome, lido
 *      só na organização do turno.
 */

vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  marcarAgendamentoHandler: vi.fn(),
  alterarAgendamentoHandler: vi.fn(),
  cancelarAgendamentoHandler: vi.fn(),
}));

vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof AgendaConsulta>();
  return { ...real, horariosLivresDaOrg: vi.fn(), listaAgendamentos: vi.fn(), idDoTipoPorSlug: vi.fn() };
});

vi.mock("@/lib/mcp/tools/_users", () => ({ resolveUserNames: vi.fn(async () => new Map()) }));

const { horariosLivresDaOrg, listaAgendamentos, idDoTipoPorSlug } = await import("@/lib/agenda/consulta");
const { crmFindFreeSlots, crmListAppointments, crmBookAppointment } = await import("@/lib/mcp/tools/agendamento");
const handlers = await import("@/app/api/v1/agenda/agendamentos/_handler");

const ORG = "org-1";
const COMPROMISSO = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const OUTRO_CONTATO = "33333333-3333-4333-8333-333333333333";
const DONO = "44444444-4444-4444-8444-444444444444";
const AGENDA_JESSICA = "55555555-5555-4555-8555-555555555555";

type Linha = Record<string, unknown>;

/** Banco mínimo: `calendar_appointments` e `calendar_connection_calendars`, com os filtros aplicados. */
function clienteFalso(tabelas: Record<string, Linha[]>, lidas: Array<{ tabela: string; org: unknown }>) {
  return {
    from: (tabela: string) => {
      const filtros: Array<(l: Linha) => boolean> = [];
      const api = {
        select: () => api,
        eq: (c: string, v: unknown) => {
          if (c === "organization_id") lidas.push({ tabela, org: v });
          filtros.push((l) => l[c] === v);
          return api;
        },
        in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), api),
        maybeSingle: async () => ({
          data: (tabelas[tabela] ?? []).find((l) => filtros.every((f) => f(l))) ?? null,
          error: null,
        }),
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l))), error: null }).then(
            ok,
          ),
      };
      return api;
    },
  } as unknown as SupabaseClient;
}

function ctx(supabase: SupabaseClient, contatoDoTurno?: string): McpContext {
  return {
    organizationId: ORG,
    role: "agent",
    actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase,
    ...(contatoDoTurno ? { contatoDoTurno } : {}),
  } as McpContext;
}

const SUCESSO: ResultadoDaConsulta = {
  ok: true,
  slots: [],
  fusoDaRegra: "America/Sao_Paulo",
  publicouHorarios: true,
  fusoSuposto: false,
  fontesDefasadas: [],
  agendaExternaNuncaLida: false,
  googleCoberturaParcial: false,
};

const TABELAS: Record<string, Linha[]> = {
  calendar_appointments: [{ id: COMPROMISSO, organization_id: ORG, owner_user_id: DONO, contact_id: CONTATO }],
  calendar_connection_calendars: [
    { id: AGENDA_JESSICA, organization_id: ORG, name: "Jessica" },
    { id: "agenda-de-outra-org", organization_id: "org-2", name: "Alheia" },
  ],
};

beforeEach(() => {
  vi.mocked(horariosLivresDaOrg).mockReset();
  vi.mocked(horariosLivresDaOrg).mockResolvedValue(SUCESSO);
});

describe("crm_find_free_slots para remarcar (PC-054)", () => {
  it("com o compromisso: consulta a agenda dele (o dono dele e o compromisso como o que muda)", async () => {
    const lidas: Array<{ tabela: string; org: unknown }> = [];
    await crmFindFreeSlots.handler(
      { event_type_slug: "ligacao", appointment_id: COMPROMISSO },
      ctx(clienteFalso(TABELAS, lidas), CONTATO),
    );
    const args = vi.mocked(horariosLivresDaOrg).mock.calls[0]?.[2];
    expect(args?.ignorarAgendamentoId).toBe(COMPROMISSO);
    expect(args?.ownerUserId).toBe(DONO);
    expect(lidas).toContainEqual({ tabela: "calendar_appointments", org: ORG });
  });

  it("compromisso de OUTRO contato, num turno de atendimento: o campo é ignorado", async () => {
    await crmFindFreeSlots.handler(
      { event_type_slug: "ligacao", appointment_id: COMPROMISSO },
      ctx(clienteFalso(TABELAS, []), OUTRO_CONTATO),
    );
    const args = vi.mocked(horariosLivresDaOrg).mock.calls[0]?.[2];
    expect(args?.ignorarAgendamentoId).toBeUndefined();
    expect(args?.ownerUserId).toBeNull();
  });

  it("compromisso que não existe nesta organização: o campo é ignorado", async () => {
    await crmFindFreeSlots.handler(
      { event_type_slug: "ligacao", appointment_id: "99999999-9999-4999-8999-999999999999" },
      ctx(clienteFalso(TABELAS, [])),
    );
    expect(vi.mocked(horariosLivresDaOrg).mock.calls[0]?.[2].ignorarAgendamentoId).toBeUndefined();
  });
});

describe("crm_book_appointment diz em que agenda ficou (PC-054)", () => {
  it("com revezamento, `agenda` traz o nome da agenda", async () => {
    vi.mocked(idDoTipoPorSlug).mockResolvedValue({ id: "tipo-1" } as never);
    vi.mocked(handlers.marcarAgendamentoHandler).mockResolvedValue({
      id: "novo",
      starts_at: "2026-10-07T13:00:00.000Z",
      ends_at: "2026-10-07T13:40:00.000Z",
      time_zone: "America/Sao_Paulo",
      status: "confirmed",
      target_calendar_id: AGENDA_JESSICA,
      agenda_nome: "Jessica",
    });
    const r = (await crmBookAppointment.handler(
      { event_type_slug: "ligacao", starts_at: "2026-10-07T13:00:00.000Z", contact_id: CONTATO },
      ctx(clienteFalso(TABELAS, [])),
    )) as { marcado: boolean; agenda?: string };
    expect(r.marcado).toBe(true);
    expect(r.agenda).toBe("Jessica");
  });

  it("sem revezamento, não há `agenda`", async () => {
    vi.mocked(idDoTipoPorSlug).mockResolvedValue({ id: "tipo-1" } as never);
    vi.mocked(handlers.marcarAgendamentoHandler).mockResolvedValue({
      id: "novo",
      starts_at: "2026-10-07T13:00:00.000Z",
      ends_at: "2026-10-07T13:40:00.000Z",
      time_zone: "America/Sao_Paulo",
      status: "confirmed",
    });
    const r = (await crmBookAppointment.handler(
      { event_type_slug: "ligacao", starts_at: "2026-10-07T13:00:00.000Z", contact_id: CONTATO },
      ctx(clienteFalso(TABELAS, [])),
    )) as Record<string, unknown>;
    expect("agenda" in r).toBe(false);
  });
});

describe("crm_list_appointments diz a agenda de cada compromisso (PC-054)", () => {
  it("pelo nome, lido só na organização do turno; sem agenda escolhida, nulo", async () => {
    vi.mocked(listaAgendamentos).mockResolvedValue({
      ok: true,
      agendamentos: [
        {
          id: "a1",
          titulo: "Ligação",
          iniciaEm: "2026-10-07T13:00:00.000Z",
          terminaEm: "2026-10-07T13:40:00.000Z",
          fuso: "America/Sao_Paulo",
          situacao: "confirmed",
          agendaId: AGENDA_JESSICA,
          donoId: DONO,
          contatoId: CONTATO,
          contatoNome: null,
        },
        {
          id: "a2",
          titulo: "Ligação",
          iniciaEm: "2026-10-08T13:00:00.000Z",
          terminaEm: "2026-10-08T13:40:00.000Z",
          fuso: "America/Sao_Paulo",
          situacao: "confirmed",
          agendaId: "agenda-de-outra-org",
          donoId: DONO,
          contatoId: CONTATO,
          contatoNome: null,
        },
        {
          id: "a3",
          titulo: "Ligação",
          iniciaEm: "2026-10-09T13:00:00.000Z",
          terminaEm: "2026-10-09T13:40:00.000Z",
          fuso: "America/Sao_Paulo",
          situacao: "confirmed",
          agendaId: null,
          donoId: DONO,
          contatoId: CONTATO,
          contatoNome: null,
        },
      ],
      proximo: null,
    });
    const r = (await crmListAppointments.handler({ contact_id: CONTATO }, ctx(clienteFalso(TABELAS, [])))) as {
      compromissos: Array<{ id: string; agenda: string | null }>;
    };
    expect(r.compromissos.map((c) => [c.id, c.agenda])).toEqual([
      ["a1", "Jessica"],
      ["a2", null],
      ["a3", null],
    ]);
  });
});
