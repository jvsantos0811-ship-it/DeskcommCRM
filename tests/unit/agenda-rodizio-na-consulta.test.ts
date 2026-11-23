import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { horariosLivresDaOrg, type ResultadoDaConsulta } from "@/lib/agenda/consulta";

// O rodízio lê a equipe pelo client ADMIN quando há service role (RLS do
// atendente). Aqui o banco é o dublê: desliga o admin para a leitura cair nele.
vi.mock("@/lib/audit", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  isServiceRoleConfigured: () => false,
}));

/**
 * PC-052 — o RODÍZIO na consulta de horários livres, com o banco de mentira
 * do teste das exceções de data (mesma forma, mais `in`, `is`, `neq`, `order`
 * e `limit`, que a leitura da vez usa).
 *
 * O que se prova:
 *   1. sem histórico, a vez é da primeira da lista;
 *   2. depois de um compromisso da primeira, a vez é da segunda;
 *   3. a da vez SEM horário na janela cede à próxima (decisão do dono: o lead
 *      não fica sem horário);
 *   4. quem chamou escolheu o responsável: o rodízio não entra;
 *   5. quem saiu da equipe sai do rodízio.
 */

const TZ = "America/Sao_Paulo";
const ORG = "org-1";
const MARIA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JESSICA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TIPO_ID = "11111111-1111-4111-8111-111111111111";

/** 21:00–21:30 de 16/09 em São Paulo. */
const DE = new Date("2026-09-17T00:00:00.000Z");
const ATE = new Date("2026-09-17T00:30:00.000Z");
const AGORA = new Date("2026-09-16T12:00:00.000Z");
const DIA_LOCAL = "2026-09-16";
const JANELA = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: "09:00", end: "23:00" }));

interface Linha {
  [coluna: string]: unknown;
}

function clienteFalso(tabelas: Record<string, Linha[]>): SupabaseClient {
  function daTabela(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    let ordem: { coluna: string; asc: boolean } | null = null;
    let limite: number | null = null;
    const linhas = () => {
      let r = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
      if (ordem) {
        const { coluna, asc } = ordem;
        r = [...r].sort((a, b) => (String(a[coluna]) < String(b[coluna]) ? -1 : 1) * (asc ? 1 : -1));
      }
      return limite === null ? r : r.slice(0, limite);
    };
    const compara = (coluna: string, valor: unknown, ok: (a: string, b: string) => boolean) => {
      filtros.push((l) => ok(String(l[coluna]), String(valor)));
      return api;
    };
    const api = {
      select: () => api,
      eq: (coluna: string, valor: unknown) => {
        filtros.push((l) => l[coluna] === valor);
        return api;
      },
      neq: (coluna: string, valor: unknown) => {
        filtros.push((l) => l[coluna] !== valor);
        return api;
      },
      is: (coluna: string, valor: unknown) => {
        filtros.push((l) => (l[coluna] ?? null) === valor);
        return api;
      },
      in: (coluna: string, valores: unknown[]) => {
        filtros.push((l) => valores.includes(l[coluna]));
        return api;
      },
      order: (coluna: string, op?: { ascending?: boolean }) => {
        ordem = { coluna, asc: op?.ascending !== false };
        return api;
      },
      limit: (n: number) => {
        limite = n;
        return api;
      },
      gte: (coluna: string, valor: unknown) => compara(coluna, valor, (a, b) => a >= b),
      lte: (coluna: string, valor: unknown) => compara(coluna, valor, (a, b) => a <= b),
      lt: (coluna: string, valor: unknown) => compara(coluna, valor, (a, b) => a < b),
      gt: (coluna: string, valor: unknown) => compara(coluna, valor, (a, b) => a > b),
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: linhas(), error: null }).then(resolve),
    };
    return api;
  }
  return {
    from: (tabela: string) => daTabela(tabela),
    rpc: async (fn: string) => {
      if (fn === "fn_google_coverage") return { data: false, error: null };
      if (fn === "fn_agenda_ocupacao_google_do_dono" || fn === "fn_agenda_conexoes_google_do_dono") {
        return { data: [], error: null };
      }
      throw new Error(`[duble] rpc não prevista: ${fn}`);
    },
  } as unknown as SupabaseClient;
}

function banco(op: {
  ultimoDono?: string;
  jessicaBloqueada?: boolean;
  jessicaSaiu?: boolean;
}): Record<string, Linha[]> {
  return {
    calendar_event_types: [
      {
        id: TIPO_ID,
        organization_id: ORG,
        name: "Ligação",
        is_active: true,
        duration_minutes: 30,
        buffer_before_minutes: 0,
        buffer_after_minutes: 0,
        minimum_notice_minutes: 0,
        slot_interval_minutes: 30,
        booking_window_days: 365,
        default_owner_user_id: null,
        rotation_owner_user_ids: [MARIA, JESSICA],
      },
    ],
    user_organizations: [
      { organization_id: ORG, user_id: MARIA, revoked_at: null },
      { organization_id: ORG, user_id: JESSICA, revoked_at: op.jessicaSaiu ? "2026-09-01T00:00:00Z" : null },
    ],
    attendant_availability: [
      { organization_id: ORG, user_id: MARIA, schedule: { timezone: TZ, windows: JANELA } },
      { organization_id: ORG, user_id: JESSICA, schedule: { timezone: TZ, windows: JANELA } },
    ],
    calendar_availability_exceptions: op.jessicaBloqueada
      ? [
          {
            organization_id: ORG,
            user_id: JESSICA,
            exception_date: DIA_LOCAL,
            is_unavailable: true,
            start_minute: 0,
            end_minute: 1440,
          },
        ]
      : [],
    // O compromisso que decide a vez fica MESES antes da janela: não ocupa nada.
    calendar_appointments: op.ultimoDono
      ? [
          {
            organization_id: ORG,
            event_type_id: TIPO_ID,
            owner_user_id: op.ultimoDono,
            status: "confirmed",
            created_at: "2026-06-01T12:00:00Z",
            starts_at: "2026-06-02T12:00:00Z",
            ends_at: "2026-06-02T12:30:00Z",
          },
        ]
      : [],
    calendar_connections: [],
    calendar_selected_external_events: [],
  };
}

async function consultar(tabelas: Record<string, Linha[]>, ownerUserId?: string) {
  const r: ResultadoDaConsulta = await horariosLivresDaOrg(clienteFalso(tabelas), ORG, {
    eventTypeId: TIPO_ID,
    ...(ownerUserId ? { ownerUserId } : {}),
    de: DE,
    ate: ATE,
    agora: AGORA,
  });
  if (!r.ok) throw new Error(`a consulta recusou: ${r.codigo} — ${r.motivoParaOperador}`);
  return r;
}

describe("rodízio na consulta de horários (PC-052)", () => {
  it("sem histórico, a vez é da primeira da lista", async () => {
    const r = await consultar(banco({}));
    expect(r.donoId).toBe(MARIA);
    expect(r.slots.length).toBeGreaterThan(0);
  });

  it("depois de um compromisso da primeira, a vez é da segunda", async () => {
    const r = await consultar(banco({ ultimoDono: MARIA }));
    expect(r.donoId).toBe(JESSICA);
  });

  it("a da vez sem horário na janela cede à próxima", async () => {
    const r = await consultar(banco({ ultimoDono: MARIA, jessicaBloqueada: true }));
    expect(r.donoId).toBe(MARIA);
    expect(r.slots.length).toBeGreaterThan(0);
  });

  it("quem chamou escolheu o responsável: o rodízio não entra", async () => {
    const r = await consultar(banco({ ultimoDono: MARIA }), MARIA);
    expect(r.donoId).toBe(MARIA);
  });

  it("quem saiu da equipe sai do rodízio", async () => {
    const r = await consultar(banco({ ultimoDono: MARIA, jessicaSaiu: true }));
    expect(r.donoId).toBe(MARIA);
  });
});
