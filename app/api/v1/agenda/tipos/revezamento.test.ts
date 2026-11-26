/**
 * PC-054 — a rota de tipos confere o REVEZAMENTO ENTRE AGENDAS antes de gravar.
 *
 * O que se prova, sempre pelo efeito (a linha gravada, ou nenhuma escrita):
 *   1. duas agendas da conta Google de quem atende, utilizáveis: grava na ordem, sem repetidos;
 *   2. lista vazia grava nulo (sem revezamento);
 *   3. uma agenda só é recusada (revezar pede duas);
 *   4. agenda da conta de OUTRA pessoa, ou de outra organização, é recusada;
 *   5. agenda que não conta para conflito (ou não aceita publicação) é recusada;
 *   6. trocar quem atende com agendas da pessoa anterior é recusado;
 *   7. a leitura das agendas filtra a organização da sessão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agenda/consulta", () => ({ listaTiposDeAtendimento: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const DONO = "77777777-7777-4777-8777-777777777777";
const OUTRA_PESSOA = "88888888-8888-4888-8888-888888888888";
const TIPO = "44444444-4444-4444-8444-444444444444";
const MARIA = "aaaaaaaa-0000-4000-8000-0000000000a1";
const JESSICA = "aaaaaaaa-0000-4000-8000-0000000000a2";
const DA_OUTRA_PESSOA = "aaaaaaaa-0000-4000-8000-0000000000a3";
const DA_OUTRA_ORG = "aaaaaaaa-0000-4000-8000-0000000000a4";

type Linha = Record<string, unknown>;

interface Agenda {
  id: string;
  organization_id: string;
  available: boolean;
  access_role: string;
  counts_for_conflicts: boolean;
  calendar_connections: { user_id: string; organization_id: string };
}

function agenda(id: string, extra: Partial<Agenda> = {}): Agenda {
  return {
    id,
    organization_id: ORG,
    available: true,
    access_role: "writer",
    counts_for_conflicts: true,
    calendar_connections: { user_id: DONO, organization_id: ORG },
    ...extra,
  };
}

function makeAdmin(tipos: Linha[], agendas: Agenda[]) {
  const escritas: Array<{ op: string; campos: Linha }> = [];
  const orgsLidasNasAgendas: unknown[] = [];
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      if (tabela === "calendar_connection_calendars") {
        let ids: unknown[] = [];
        let org: unknown = null;
        const c = {
          select: () => c,
          eq(k: string, v: unknown) {
            if (k === "organization_id") {
              org = v;
              orgsLidasNasAgendas.push(v);
            }
            return c;
          },
          in(_k: string, v: unknown[]) {
            ids = v;
            return c;
          },
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({
              data: agendas.filter((a) => a.organization_id === org && ids.includes(a.id)),
              error: null,
            }).then(resolve),
        };
        return c;
      }
      expect(tabela, "a rota mexeu em outra tabela").toBe("calendar_event_types");
      const filtros: Linha = {};
      let op: "insert" | "update" | "select" = "select";
      let campos: Linha = {};
      const api = {
        select: () => api,
        insert(v: Linha) {
          op = "insert";
          campos = v;
          return api;
        },
        update(v: Linha) {
          op = "update";
          campos = v;
          return api;
        },
        eq(k: string, v: unknown) {
          filtros[k] = v;
          return api;
        },
        single: async () => {
          escritas.push({ op, campos });
          return { data: { id: "novo", slug: "novo" }, error: null };
        },
        maybeSingle: async () => {
          const alvo = tipos.find((t) => Object.entries(filtros).every(([k, v]) => t[k] === v)) ?? null;
          if (op === "update") {
            escritas.push({ op, campos });
            if (alvo) Object.assign(alvo, campos);
            return { data: alvo ? { id: alvo.id } : null, error: null };
          }
          return { data: alvo, error: null };
        },
      };
      return api;
    },
  } as unknown as ReturnType<typeof createAdminClient>);
  return { escritas, orgsLidasNasAgendas };
}

function authOk(): void {
  const user: AuthUser = {
    id: USER,
    email: "manager@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: "manager" }],
  };
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user, org: { orgId: ORG, name: "Org", role: "manager" } });
}

function req(metodo: "POST" | "PATCH", body: unknown) {
  return new NextRequest("http://localhost/api/v1/agenda/tipos", {
    method: metodo,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function tipo(extra: Linha = {}): Linha {
  return { id: TIPO, organization_id: ORG, default_owner_user_id: DONO, rotation_calendar_ids: null, ...extra };
}

const TODAS = [
  agenda(MARIA),
  agenda(JESSICA),
  agenda(DA_OUTRA_PESSOA, { calendar_connections: { user_id: OUTRA_PESSOA, organization_id: ORG } }),
  agenda(DA_OUTRA_ORG, { organization_id: OUTRA_ORG, calendar_connections: { user_id: DONO, organization_id: OUTRA_ORG } }),
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("revezamento entre agendas na rota de tipos (PC-054)", () => {
  it("duas agendas de quem atende: grava na ordem, sem repetidos", async () => {
    authOk();
    const tipos = [tipo()];
    const { orgsLidasNasAgendas } = makeAdmin(tipos, TODAS);
    const { PATCH } = await import("./route");
    const res = await PATCH(req("PATCH", { id: TIPO, rotation_calendar_ids: [JESSICA, MARIA, JESSICA] }));
    expect(res.status).toBe(200);
    expect(tipos[0]?.rotation_calendar_ids).toEqual([JESSICA, MARIA]);
    expect(orgsLidasNasAgendas).toEqual([ORG]);
  });

  it("lista vazia grava nulo (sem revezamento)", async () => {
    authOk();
    const tipos = [tipo({ rotation_calendar_ids: [MARIA, JESSICA] })];
    makeAdmin(tipos, TODAS);
    const { PATCH } = await import("./route");
    const res = await PATCH(req("PATCH", { id: TIPO, rotation_calendar_ids: [] }));
    expect(res.status).toBe(200);
    expect(tipos[0]?.rotation_calendar_ids).toBeNull();
  });

  it("uma agenda só é recusada, sem escrever", async () => {
    authOk();
    const { escritas } = makeAdmin([tipo()], TODAS);
    const { PATCH } = await import("./route");
    const res = await PATCH(req("PATCH", { id: TIPO, rotation_calendar_ids: [MARIA] }));
    expect(res.status).toBe(422);
    expect(escritas).toHaveLength(0);
  });

  it("agenda da conta de outra pessoa é recusada", async () => {
    authOk();
    const { escritas } = makeAdmin([tipo()], TODAS);
    const { PATCH } = await import("./route");
    const res = await PATCH(req("PATCH", { id: TIPO, rotation_calendar_ids: [MARIA, DA_OUTRA_PESSOA] }));
    expect(res.status).toBe(422);
    expect(escritas).toHaveLength(0);
  });

  it("agenda de outra organização é recusada (a leitura filtra a organização da sessão)", async () => {
    authOk();
    const { escritas } = makeAdmin([tipo()], TODAS);
    const { PATCH } = await import("./route");
    const res = await PATCH(req("PATCH", { id: TIPO, rotation_calendar_ids: [MARIA, DA_OUTRA_ORG] }));
    expect(res.status).toBe(422);
    expect(escritas).toHaveLength(0);
  });

  it("agenda que não conta para conflito, ou não aceita publicação, é recusada", async () => {
    authOk();
    for (const torta of [agenda(JESSICA, { counts_for_conflicts: false }), agenda(JESSICA, { access_role: "reader" })]) {
      const { escritas } = makeAdmin([tipo()], [agenda(MARIA), torta]);
      const { PATCH } = await import("./route");
      const res = await PATCH(req("PATCH", { id: TIPO, rotation_calendar_ids: [MARIA, JESSICA] }));
      expect(res.status).toBe(422);
      expect(escritas).toHaveLength(0);
    }
  });

  it("trocar quem atende com agendas da pessoa anterior é recusado", async () => {
    authOk();
    const { escritas } = makeAdmin([tipo({ rotation_calendar_ids: [MARIA, JESSICA] })], TODAS);
    const { PATCH } = await import("./route");
    const res = await PATCH(req("PATCH", { id: TIPO, default_owner_user_id: OUTRA_PESSOA }));
    expect(res.status).toBe(422);
    expect(escritas).toHaveLength(0);
  });

  it("sem quem atende não há revezamento", async () => {
    authOk();
    const { escritas } = makeAdmin([], TODAS);
    const { POST } = await import("./route");
    const res = await POST(
      req("POST", {
        name: "Ligação",
        category: "outro",
        duration_minutes: 40,
        location_kind: "phone",
        rotation_calendar_ids: [MARIA, JESSICA],
      }),
    );
    expect(res.status).toBe(422);
    expect(escritas).toHaveLength(0);
  });

  it("POST com quem atende e duas agendas dele grava a lista", async () => {
    authOk();
    const { escritas } = makeAdmin([], TODAS);
    const { POST } = await import("./route");
    const res = await POST(
      req("POST", {
        name: "Ligação",
        category: "outro",
        duration_minutes: 40,
        location_kind: "phone",
        default_owner_user_id: DONO,
        rotation_calendar_ids: [MARIA, JESSICA],
      }),
    );
    expect(res.status).toBe(201);
    expect(escritas[0]?.campos.rotation_calendar_ids).toEqual([MARIA, JESSICA]);
  });
});
