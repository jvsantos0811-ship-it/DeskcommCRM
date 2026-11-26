import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";

// A vez é lida pelo client ADMIN quando há service role. Aqui o banco é o
// dublê: desliga o admin para todas as leituras caírem nele.
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));

const { alterarAgendamentoHandler, marcarAgendamentoHandler } = await import(
  "@/app/api/v1/agenda/agendamentos/_handler"
);
const { horariosLivresDaOrg } = await import("@/lib/agenda/consulta");

/**
 * PC-054 — REVEZAMENTO ENTRE AGENDAS, da consulta à gravação, com o banco de
 * mentira de `pessoa-marca-fora-da-grade.test.ts` (mais as duas funções da
 * migration 9045, `in`, `order` e `limit`).
 *
 * O caso real: uma conta Google (a de quem atende) com a agenda da Maria
 * (destino) e a da Jessica. O tipo reveza entre as duas.
 *
 * Os critérios de aceite do PC-054 que este arquivo prova:
 *   - tipo sem revezamento: igual a hoje (destino único);
 *   - Maria ocupada às 10h no Google: às 10h aparece livre e marca na Jessica;
 *   - as duas livres: as marcações alternam pela vez;
 *   - mesmo instante em agendas diferentes: aceito; na mesma agenda: 409;
 *   - agenda que deixa de valer sai do revezamento sem derrubar a consulta;
 *   - remarcar fica na mesma agenda.
 * O que o Postgres faz (o claim manda o evento para a agenda escolhida, o
 * índice por agenda) está em `tests/invariants/agenda-revezamento-entre-agendas.test.ts`.
 */

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const DONO = "bbbbbbbb-0000-4000-8000-00000000000b";
const TIPO = "cccccccc-0000-4000-8000-00000000000c";
const CONEXAO = "eeeeeeee-0000-4000-8000-00000000000e";
const MARIA = "dddddddd-0000-4000-8000-0000000000d1";
const JESSICA = "dddddddd-0000-4000-8000-0000000000d2";

const PESSOA: Actor = { type: "user", id: DONO, role: "admin" };
const AGENTE: Actor = { type: "ai_agent", id: "run-1", role: "agent" };

/** Segunda, 05/10/2026, 09:00 em São Paulo — relógio fixo (a grade desconta aviso mínimo de AGORA). */
const AGORA = new Date("2026-10-05T12:00:00.000Z");
// Quarta, 07/10/2026. São Paulo é UTC-3: 10:00 local = 13:00Z.
const DEZ = "2026-10-07T13:00:00.000Z";
const ONZE = "2026-10-07T14:00:00.000Z";
const MEIO_DIA = "2026-10-07T15:00:00.000Z";
const DEZ_E_MEIA = "2026-10-07T13:30:00.000Z";

type Linha = Record<string, unknown>;

function instante(valor: unknown): number {
  return new Date(String(valor)).getTime();
}

interface Banco {
  tabelas: Record<string, Linha[]>;
  client: SupabaseClient;
  /** Chamadas de RPC, para provar quando o caminho antigo (sem revezamento) é que rodou. */
  rpcs: string[];
}

function bancoEmMemoria(tabelas: Record<string, Linha[]>): Banco {
  const rpcs: string[] = [];
  const leitura = (tabela: string) => {
    const filtros: Array<(linha: Linha) => boolean> = [];
    let ordem: { coluna: string; asc: boolean } | null = null;
    let limite: number | null = null;
    const linhas = () => {
      // `fantasma` é a linha que nasceu entre a conferência e a gravação: a
      // leitura não a vê, a unicidade do INSERT vê (a corrida do duplo clique).
      let r = (tabelas[tabela] ?? []).filter((l) => !l.fantasma && filtros.every((f) => f(l)));
      if (ordem) {
        const { coluna, asc } = ordem;
        r = [...r].sort((a, b) => (String(a[coluna]) < String(b[coluna]) ? -1 : 1) * (asc ? 1 : -1));
      }
      return limite === null ? r : r.slice(0, limite);
    };
    const cadeia = {
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), cadeia),
      neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), cadeia),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), cadeia),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), cadeia),
      lt: (c: string, v: unknown) => (filtros.push((l) => instante(l[c]) < instante(v)), cadeia),
      gt: (c: string, v: unknown) => (filtros.push((l) => instante(l[c]) > instante(v)), cadeia),
      gte: (c: string, v: unknown) => (filtros.push((l) => String(l[c]) >= String(v)), cadeia),
      lte: (c: string, v: unknown) => (filtros.push((l) => String(l[c]) <= String(v)), cadeia),
      order: (c: string, op?: { ascending?: boolean }) => ((ordem = { coluna: c, asc: op?.ascending !== false }), cadeia),
      limit: (n: number) => ((limite = n), cadeia),
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve({ data: linhas(), error: null }).then(ok, falha),
    };
    return cadeia;
  };

  const vivo = (l: Linha) =>
    (l.status === "pending" || l.status === "confirmed") && l.lead_presence !== "nao_vai" && l.owner_user_id;
  const agendaDaChave = (l: Linha) => (l.target_calendar_id as string | null | undefined) ?? "destino";

  const client = {
    from: (tabela: string) => ({
      select: () => leitura(tabela),
      insert: (linha: Linha) => {
        // A guarda de duplo clique por agenda (migration 9045): mesmo dono, mesmo
        // instante, mesma agenda (sem agenda = a de destino).
        const colide =
          tabela === "calendar_appointments" &&
          vivo(linha) &&
          (tabelas.calendar_appointments ?? []).some(
            (l) =>
              vivo(l) &&
              l.organization_id === linha.organization_id &&
              l.owner_user_id === linha.owner_user_id &&
              instante(l.starts_at) === instante(linha.starts_at) &&
              agendaDaChave(l) === agendaDaChave(linha),
          );
        const gravada = { id: `novo-${(tabelas[tabela] ?? []).length + 1}`, created_at: AGORA.toISOString(), ...linha };
        if (!colide) (tabelas[tabela] ??= []).push(gravada);
        const resposta = colide
          ? { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }
          : { data: gravada, error: null };
        return {
          select: () => ({ single: async () => resposta }),
          then: (ok: (v: unknown) => unknown) => Promise.resolve(resposta).then(ok),
        };
      },
    }),
    rpc: async (fn: string, args: Linha) => {
      rpcs.push(fn);
      if (fn === "fn_google_coverage") return { data: false, error: null };
      const conexoesDoDono = () =>
        (tabelas.calendar_connections ?? []).filter((c) => c.organization_id === args.p_org && c.user_id === args.p_owner);
      const agendaDoEvento = (e: Linha) =>
        (tabelas.calendar_connection_calendars ?? []).find(
          (k) =>
            k.organization_id === e.organization_id &&
            k.connection_id === e.connection_id &&
            k.external_calendar_id === e.external_calendar_id,
        );
      const eventosDoDono = () =>
        (tabelas.calendar_selected_external_events ?? []).filter(
          (e) =>
            e.organization_id === args.p_org &&
            conexoesDoDono().some((c) => c.id === e.connection_id) &&
            instante(e.starts_at) < instante(args.p_ate) &&
            instante(e.ends_at) > instante(args.p_de),
        );
      const situacao = (e: Linha) => conexoesDoDono().find((c) => c.id === e.connection_id)?.status ?? null;
      if (fn === "fn_agenda_ocupacao_google_do_dono") {
        return {
          data: eventosDoDono().map((e) => ({
            starts_at: e.starts_at,
            ends_at: e.ends_at,
            transparency: e.transparency,
            status: e.status,
            connection_status: situacao(e),
          })),
          error: null,
        };
      }
      if (fn === "fn_agenda_conexoes_google_do_dono") {
        return { data: conexoesDoDono().map((c) => ({ status: c.status, last_sync_at: c.last_sync_at })), error: null };
      }
      // As duas da migration 9045, com o que o corpo SQL aplica.
      if (fn === "fn_agenda_revezamento_do_dono") {
        const lista = (args.p_agendas as string[]) ?? [];
        const linhas = (tabelas.calendar_connection_calendars ?? []).filter(
          (k) =>
            k.organization_id === args.p_org &&
            conexoesDoDono().some((c) => c.id === k.connection_id) &&
            (lista.includes(String(k.id)) || k.is_destination === true),
        );
        return {
          data: linhas.map((k) => ({
            agenda_id: k.id,
            connection_id: k.connection_id,
            external_calendar_id: k.external_calendar_id,
            nome: lista.includes(String(k.id)) ? k.name : null,
            na_lista: lista.includes(String(k.id)),
            destino: k.is_destination === true,
            disponivel: k.available !== false,
            aceita_escrita: ["owner", "writer"].includes(String(k.access_role ?? "owner")),
            conta_conflito: k.counts_for_conflicts !== false,
          })),
          error: null,
        };
      }
      if (fn === "fn_agenda_ocupacao_google_das_agendas") {
        const lista = (args.p_agendas as string[]) ?? [];
        return {
          data: eventosDoDono()
            .map((e) => ({ e, k: agendaDoEvento(e) }))
            .filter(({ k }) => !k || lista.includes(String(k.id)))
            .map(({ e, k }) => ({
              agenda_id: k?.id ?? null,
              starts_at: e.starts_at,
              ends_at: e.ends_at,
              transparency: e.transparency,
              status: e.status,
              connection_status: situacao(e),
            })),
          error: null,
        };
      }
      if (fn === "fn_appointment_change") {
        const linha = (tabelas.calendar_appointments ?? []).find((l) => l.id === args.p_id);
        if (!linha) return { data: null, error: { code: "P0002", message: "não achou" } };
        Object.assign(linha, args.p_patch as Linha, { revision: Number(linha.revision) + 1 });
        return { data: { ...linha }, error: null };
      }
      if (fn === "fn_colegas_podem_mexer_na_agenda") return { data: true, error: null };
      if (fn === "emit_event") return { data: null, error: null };
      throw new Error(`[dublê] rpc não prevista: ${fn}`);
    },
  } as unknown as SupabaseClient;

  return { tabelas, client, rpcs };
}

/** Um compromisso do CRM na agenda do dono — por padrão confirmado e sem agenda escolhida. */
function compromisso(id: string, inicio: string, fim: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: ORG,
    event_type_id: TIPO,
    owner_user_id: DONO,
    contact_id: null,
    starts_at: inicio,
    ends_at: fim,
    status: "confirmed",
    time_zone: "America/Sao_Paulo",
    revision: 1,
    created_at: "2026-10-01T12:00:00.000Z",
    target_calendar_id: null,
    google_connection_id: null,
    google_calendar_id: null,
    ...extra,
  };
}

/** Um evento do Google numa agenda da conta do dono. */
function eventoDoGoogle(agendaExterna: string, inicio: string, fim: string): Linha {
  return {
    organization_id: ORG,
    connection_id: CONEXAO,
    external_calendar_id: agendaExterna,
    starts_at: inicio,
    ends_at: fim,
    transparency: "opaque",
    status: "confirmed",
  };
}

function agenda(
  args: {
    revezamento?: string[] | null;
    compromissos?: Linha[];
    eventos?: Linha[];
    jessicaNaoContaConflito?: boolean;
  } = {},
): Banco {
  return bancoEmMemoria({
    calendar_event_types: [
      {
        id: TIPO,
        organization_id: ORG,
        name: "Ligação",
        is_active: true,
        duration_minutes: 60,
        buffer_before_minutes: 0,
        buffer_after_minutes: 0,
        minimum_notice_minutes: 120,
        slot_interval_minutes: null,
        booking_window_days: 30,
        default_owner_user_id: DONO,
        rotation_owner_user_ids: null,
        rotation_calendar_ids: args.revezamento === undefined ? [MARIA, JESSICA] : args.revezamento,
        requires_confirmation: false,
        location_kind: "phone",
        location_details: null,
      },
    ],
    attendant_availability: [
      {
        organization_id: ORG,
        user_id: DONO,
        schedule: { timezone: "America/Sao_Paulo", windows: [{ dow: 3, start: "09:00", end: "18:00" }] },
      },
    ],
    calendar_availability_exceptions: [],
    calendar_connections: [
      { id: CONEXAO, organization_id: ORG, user_id: DONO, status: "healthy", last_sync_at: AGORA.toISOString() },
    ],
    calendar_connection_calendars: [
      {
        id: MARIA,
        organization_id: ORG,
        connection_id: CONEXAO,
        external_calendar_id: "maria@grupo",
        name: "Maria Vitória",
        is_destination: true,
        available: true,
        access_role: "writer",
        counts_for_conflicts: true,
      },
      {
        id: JESSICA,
        organization_id: ORG,
        connection_id: CONEXAO,
        external_calendar_id: "jessica@grupo",
        name: "Jessica",
        is_destination: false,
        available: true,
        access_role: "writer",
        counts_for_conflicts: !args.jessicaNaoContaConflito,
      },
    ],
    calendar_appointments: args.compromissos ?? [],
    calendar_selected_external_events: args.eventos ?? [],
  });
}

function ctx(actor: Actor): HandlerCtx {
  return { organization_id: ORG, actor, requestId: "req-1" };
}

function criados(banco: Banco): Linha[] {
  return (banco.tabelas.calendar_appointments ?? []).filter((l) => String(l.id).startsWith("novo-"));
}

async function slotsDoDia(banco: Banco) {
  const r = await horariosLivresDaOrg(banco.client, ORG, {
    eventTypeId: TIPO,
    de: new Date("2026-10-07T12:00:00.000Z"),
    ate: new Date("2026-10-07T21:00:00.000Z"),
    agora: AGORA,
  });
  if (!r.ok) throw new Error(`a consulta recusou: ${r.codigo}`);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("consulta com revezamento entre agendas (PC-054)", () => {
  it("Maria ocupada às 10h no Google: às 10h aparece livre, na agenda da Jessica", async () => {
    const r = await slotsDoDia(agenda({ eventos: [eventoDoGoogle("maria@grupo", DEZ, ONZE)] }));
    const dez = r.slots.find((s) => s.inicio.toISOString() === DEZ);
    expect(dez, "o horário sumiu: a ocupação da Maria bloqueou a conta inteira").toBeDefined();
    expect(dez?.agendaId).toBe(JESSICA);
    // Onde as duas estão livres, a vez (sem histórico) é da primeira: Maria.
    expect(r.slots.find((s) => s.inicio.toISOString() === ONZE)?.agendaId).toBe(MARIA);
  });

  it("as duas ocupadas no mesmo horário: ele não aparece", async () => {
    const r = await slotsDoDia(
      agenda({
        eventos: [eventoDoGoogle("maria@grupo", DEZ, ONZE)],
        compromissos: [compromisso("ag-j", DEZ, ONZE, { target_calendar_id: JESSICA })],
      }),
    );
    expect(r.slots.some((s) => s.inicio.toISOString() === DEZ)).toBe(false);
  });

  it("compromisso sem agenda escolhida e ainda fora do Google ocupa a de DESTINO (onde vai cair)", async () => {
    const r = await slotsDoDia(agenda({ compromissos: [compromisso("ag-sem", DEZ, ONZE)] }));
    expect(r.slots.find((s) => s.inicio.toISOString() === DEZ)?.agendaId).toBe(JESSICA);
  });

  it("compromisso já no Google conta na agenda onde o evento está", async () => {
    const r = await slotsDoDia(
      agenda({
        compromissos: [
          compromisso("ag-g", DEZ, ONZE, { google_connection_id: CONEXAO, google_calendar_id: "jessica@grupo" }),
        ],
      }),
    );
    expect(r.slots.find((s) => s.inicio.toISOString() === DEZ)?.agendaId).toBe(MARIA);
  });

  it("evento de agenda fora do catálogo ocupa TODAS (o erro barato)", async () => {
    const r = await slotsDoDia(agenda({ eventos: [eventoDoGoogle("desconhecida@grupo", DEZ, ONZE)] }));
    expect(r.slots.some((s) => s.inicio.toISOString() === DEZ)).toBe(false);
  });

  it("agenda que não conta para conflito sai do revezamento, sem derrubar a consulta", async () => {
    const r = await slotsDoDia(
      agenda({ jessicaNaoContaConflito: true, eventos: [eventoDoGoogle("maria@grupo", DEZ, ONZE)] }),
    );
    expect(r.revezamento?.agendas.map((a) => a.id)).toEqual([MARIA]);
    expect(r.slots.some((s) => s.inicio.toISOString() === DEZ)).toBe(false);
    expect(r.slots.length).toBeGreaterThan(0);
  });

  it("tipo sem revezamento: a regra de sempre (ocupação do dono inteiro, sem agenda no horário)", async () => {
    const banco = agenda({ revezamento: null, eventos: [eventoDoGoogle("maria@grupo", DEZ, ONZE)] });
    const r = await slotsDoDia(banco);
    expect(r.revezamento).toBeUndefined();
    expect(r.slots.some((s) => s.inicio.toISOString() === DEZ)).toBe(false);
    expect(r.slots.every((s) => s.agendaId === undefined)).toBe(true);
    expect(banco.rpcs).toContain("fn_agenda_ocupacao_google_do_dono");
    expect(banco.rpcs).not.toContain("fn_agenda_revezamento_do_dono");
  });
});

describe("marcar com revezamento entre agendas (PC-054)", () => {
  it("as duas livres: as marcações alternam pela vez", async () => {
    const banco = agenda();
    const primeira = await marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: DEZ });
    const segunda = await marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: ONZE });
    const terceira = await marcarAgendamentoHandler(banco.client, ctx(AGENTE), {
      event_type_id: TIPO,
      starts_at: MEIO_DIA,
    });
    expect(criados(banco).map((l) => l.target_calendar_id)).toEqual([MARIA, JESSICA, MARIA]);
    expect(primeira.agenda_nome).toBe("Maria Vitória");
    expect(segunda.agenda_nome).toBe("Jessica");
    expect(terceira.target_calendar_id).toBe(MARIA);
  });

  it("Maria ocupada às 10h no Google: a IA marca às 10h, na Jessica", async () => {
    const banco = agenda({ eventos: [eventoDoGoogle("maria@grupo", DEZ, ONZE)] });
    await marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: DEZ });
    expect(criados(banco).map((l) => l.target_calendar_id)).toEqual([JESSICA]);
  });

  it("mesmo instante em agendas diferentes: aceito", async () => {
    const banco = agenda({ compromissos: [compromisso("ag-m", DEZ, ONZE, { target_calendar_id: MARIA })] });
    await marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: DEZ });
    expect(criados(banco).map((l) => l.target_calendar_id)).toEqual([JESSICA]);
  });

  it("as duas ocupadas: recusa nomeada, nada gravado", async () => {
    const banco = agenda({
      eventos: [eventoDoGoogle("maria@grupo", DEZ, ONZE), eventoDoGoogle("jessica@grupo", DEZ, ONZE)],
    });
    await expect(
      marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: DEZ }),
    ).rejects.toMatchObject({ status: 422, code: "agenda_horario_indisponivel" });
    expect(criados(banco)).toHaveLength(0);
  });

  it("mesmo instante na MESMA agenda, na corrida do duplo clique: 409, não erro interno", async () => {
    // A linha fantasma nasceu entre a conferência e a gravação, na agenda da vez.
    const banco = agenda({
      compromissos: [compromisso("ag-corrida", DEZ, ONZE, { target_calendar_id: MARIA, fantasma: true })],
    });
    await expect(
      marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: DEZ }),
    ).rejects.toMatchObject({ status: 409, code: "agenda_horario_indisponivel" });
  });

  it("a PESSOA (encaixe fora da grade) marca na primeira agenda livre no horário", async () => {
    const banco = agenda({ eventos: [eventoDoGoogle("maria@grupo", DEZ_E_MEIA, "2026-10-07T14:30:00.000Z")] });
    await marcarAgendamentoHandler(banco.client, ctx(PESSOA), { event_type_id: TIPO, starts_at: DEZ_E_MEIA });
    expect(criados(banco).map((l) => l.target_calendar_id)).toEqual([JESSICA]);
  });

  it("tipo sem revezamento: grava sem agenda escolhida (vai para o destino, como sempre)", async () => {
    const banco = agenda({ revezamento: null });
    const r = await marcarAgendamentoHandler(banco.client, ctx(AGENTE), { event_type_id: TIPO, starts_at: DEZ });
    expect(criados(banco).map((l) => l.target_calendar_id)).toEqual([null]);
    expect(r.agenda_nome).toBeUndefined();
  });
});

describe("remarcar com revezamento entre agendas (PC-054)", () => {
  const naMaria = () =>
    compromisso("ag-remarcar", MEIO_DIA, "2026-10-07T16:00:00.000Z", {
      target_calendar_id: MARIA,
      google_connection_id: CONEXAO,
      google_calendar_id: "maria@grupo",
    });

  it("fica na MESMA agenda: horário livre só na outra é recusado", async () => {
    const banco = agenda({ compromissos: [naMaria()], eventos: [eventoDoGoogle("maria@grupo", DEZ, ONZE)] });
    await expect(
      alterarAgendamentoHandler(banco.client, ctx(AGENTE), { id: "ag-remarcar", starts_at: DEZ }),
    ).rejects.toMatchObject({ status: 422, code: "agenda_horario_indisponivel" });
  });

  it("horário livre na agenda dele: remarca, e a agenda não muda", async () => {
    const banco = agenda({ compromissos: [naMaria()], eventos: [eventoDoGoogle("maria@grupo", DEZ, ONZE)] });
    await alterarAgendamentoHandler(banco.client, ctx(AGENTE), { id: "ag-remarcar", starts_at: ONZE });
    const linha = banco.tabelas.calendar_appointments?.find((l) => l.id === "ag-remarcar");
    expect(linha?.starts_at).toBe(ONZE);
    expect(linha?.target_calendar_id).toBe(MARIA);
  });

  it("a consulta para remarcar (com o compromisso) oferece só a agenda dele", async () => {
    const banco = agenda({ compromissos: [naMaria()], eventos: [eventoDoGoogle("maria@grupo", DEZ, ONZE)] });
    const r = await horariosLivresDaOrg(banco.client, ORG, {
      eventTypeId: TIPO,
      ownerUserId: DONO,
      de: new Date("2026-10-07T12:00:00.000Z"),
      ate: new Date("2026-10-07T21:00:00.000Z"),
      agora: AGORA,
      ignorarAgendamentoId: "ag-remarcar",
    });
    if (!r.ok) throw new Error(r.codigo);
    expect(r.revezamento?.agendas.map((a) => a.id)).toEqual([MARIA]);
    expect(r.slots.some((s) => s.inicio.toISOString() === DEZ)).toBe(false);
    // O próprio compromisso não ocupa o destino da remarcação (#1084).
    expect(r.slots.some((s) => s.inicio.toISOString() === MEIO_DIA)).toBe(true);
  });
});
