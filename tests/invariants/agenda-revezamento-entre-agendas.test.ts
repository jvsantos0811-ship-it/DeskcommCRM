import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_AGENT_B, GOV_ORG, seedGov } from "./gov-helpers";

/**
 * PC-054 — REVEZAMENTO ENTRE AGENDAS no Postgres (migration 9045), sob `set role`
 * e JWT de verdade.
 *
 * O que os testes de unidade não alcançam, e este arquivo mede:
 *   1. O CLAIM do Google (`fn_google_appointment`) manda o compromisso com
 *      `target_calendar_id` para ESSA agenda; sem ela, para a de destino (como
 *      sempre); com uma agenda que não é de uma conexão de quem atende, não
 *      grava em lugar nenhum e deixa o motivo.
 *   2. A guarda de duplo clique (`calendar_appointments_sem_duplicata_idx`) é
 *      por agenda: mesmo instante em agendas diferentes entra; na mesma agenda,
 *      23505; sem agenda escolhida, continua valendo como antes.
 *   3. `fn_agenda_revezamento_do_dono` e `fn_agenda_ocupacao_google_das_agendas`
 *      respondem igual a dono e a atendente (atravessam a RLS da conexão),
 *      recusam outra organização e `anon`, devolvem o nome só das agendas da
 *      lista e a ocupação por agenda sem o título do evento.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG_VIZINHA = randomUUID();
const USUARIO_DA_VIZINHA = randomUUID();
const CONEXAO = randomUUID();
const CONEXAO_DO_COLEGA = randomUUID();
const MARIA = randomUUID();
const JESSICA = randomUUID();
const PESSOAL = randomUUID();
const DO_COLEGA = randomUUID();

const DEZ = "2030-03-12T13:00:00.000Z";
const ONZE = "2030-03-12T14:00:00.000Z";
const JANELA: [string, string] = ["2030-03-12T12:00:00.000Z", "2030-03-12T15:00:00.000Z"];
const TITULO_SIGILOSO = "Cirurgia sigilosa — paciente Fulano";

type Ator = { tipo: "usuario"; id: string } | { tipo: "anon" } | { tipo: "service_role" };

async function como(ator: Ator, sqlText: string, args: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (ator.tipo === "usuario") {
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: ator.id, role: "authenticated" }),
      ]);
    } else if (ator.tipo === "anon") {
      await client.query("set local role anon");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    } else {
      await client.query("set local role service_role");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    }
    return await client.query(sqlText, args);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

const usuario = (id: string): Ator => ({ tipo: "usuario", id });

async function compromisso(extra: { target?: string | null; inicio?: string; fim?: string; dono?: string } = {}) {
  const id = randomUUID();
  await pool.query(
    `insert into calendar_appointments(id, organization_id, title, starts_at, ends_at, owner_user_id, target_calendar_id)
     values ($1, $2, 'Ligação', $3, $4, $5, $6)`,
    [id, GOV_ORG, extra.inicio ?? DEZ, extra.fim ?? ONZE, extra.dono ?? GOV_AGENT_A, extra.target ?? null],
  );
  return id;
}

async function claim(id: string) {
  await pool.query("select public.fn_google_appointment($1, $2, 'claim', '{}'::jsonb)", [GOV_ORG, id]);
  const { rows } = await pool.query(
    "select google_connection_id, google_calendar_id, google_sync_error from calendar_appointments where id = $1",
    [id],
  );
  return rows[0] as { google_connection_id: string | null; google_calendar_id: string | null; google_sync_error: string | null };
}

beforeAll(async () => {
  seedGov();
  await pool.query("insert into auth.users(id, email) values ($1, $2)", [
    USUARIO_DA_VIZINHA,
    `${USUARIO_DA_VIZINHA}@invariant.test`,
  ]);
  await pool.query(
    "insert into organizations(id, slug, display_name, legal_name) values ($1, $2, 'Vizinha', 'Vizinha')",
    [ORG_VIZINHA, `vizinha-${ORG_VIZINHA}`],
  );
  await pool.query(
    "insert into user_organizations(organization_id, user_id, role, accepted_at) values ($1, $2, 'admin', now())",
    [ORG_VIZINHA, USUARIO_DA_VIZINHA],
  );

  // A conta Google de quem atende (um `agent`), com a agenda da Maria (destino),
  // a da Jessica e uma pessoal; e a conta de um colega, para o claim recusar.
  for (const [conexao, dono] of [
    [CONEXAO, GOV_AGENT_A],
    [CONEXAO_DO_COLEGA, GOV_AGENT_B],
  ] as const) {
    await pool.query(
      `insert into calendar_connections(id, organization_id, user_id, provider, account_email, status, last_sync_at)
       values ($1, $2, $3, 'google_calendar', $4, 'healthy', now())`,
      [conexao, GOV_ORG, dono, `${conexao}@invariant.test`],
    );
  }
  for (const [id, conexao, externa, nome, destino] of [
    [MARIA, CONEXAO, "maria@grupo", "Maria Vitória", true],
    [JESSICA, CONEXAO, "jessica@grupo", "Jessica", false],
    [PESSOAL, CONEXAO, "pessoal@grupo", "Pessoal", false],
    [DO_COLEGA, CONEXAO_DO_COLEGA, "colega@grupo", "Colega", true],
  ] as const) {
    await pool.query(
      `insert into calendar_connection_calendars(id, organization_id, connection_id, external_calendar_id, name, is_destination, counts_for_conflicts, access_role)
       values ($1, $2, $3, $4, $5, $6, true, 'writer')`,
      [id, GOV_ORG, conexao, externa, nome, destino],
    );
  }
  // A Maria tem um compromisso pessoal às 10h; um evento sem linha no catálogo também.
  for (const [externa, evento] of [
    ["maria@grupo", "ev-maria"],
    ["sem-catalogo@grupo", "ev-solto"],
  ] as const) {
    await pool.query(
      `insert into calendar_external_events(organization_id, connection_id, external_calendar_id, external_event_id, title, starts_at, ends_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [GOV_ORG, CONEXAO, externa, evento, TITULO_SIGILOSO, DEZ, ONZE],
    );
  }
});

afterAll(() => pool.end());

describe("o claim do Google manda o compromisso para a agenda do revezamento", () => {
  it("com agenda escolhida: vai para ELA", async () => {
    const r = await claim(await compromisso({ target: JESSICA, inicio: "2030-03-13T13:00:00Z", fim: "2030-03-13T14:00:00Z" }));
    expect(r.google_connection_id).toBe(CONEXAO);
    expect(r.google_calendar_id).toBe("jessica@grupo");
    expect(r.google_sync_error).toBeNull();
  });

  it("sem agenda escolhida: vai para a de destino, como sempre", async () => {
    const r = await claim(await compromisso({ inicio: "2030-03-14T13:00:00Z", fim: "2030-03-14T14:00:00Z" }));
    expect(r.google_calendar_id).toBe("maria@grupo");
  });

  it("agenda da conta de OUTRA pessoa: não grava em lugar nenhum e deixa o motivo", async () => {
    const r = await claim(await compromisso({ target: DO_COLEGA, inicio: "2030-03-15T13:00:00Z", fim: "2030-03-15T14:00:00Z" }));
    expect(r.google_calendar_id, "o revezamento gravou na agenda de outra pessoa").toBeNull();
    expect(r.google_sync_error).toMatch(/revezamento/);
  });
});

describe("a guarda de duplo clique é por agenda", () => {
  const INICIO = "2030-03-20T13:00:00Z";
  const FIM = "2030-03-20T14:00:00Z";

  it("mesmo instante em agendas diferentes do mesmo responsável: entra", async () => {
    await compromisso({ target: MARIA, inicio: INICIO, fim: FIM });
    await expect(compromisso({ target: JESSICA, inicio: INICIO, fim: FIM })).resolves.toBeTypeOf("string");
  });

  it("mesmo instante na MESMA agenda: 23505", async () => {
    await expect(compromisso({ target: JESSICA, inicio: INICIO, fim: FIM })).rejects.toMatchObject({ code: "23505" });
  });

  it("sem agenda escolhida, a guarda continua como antes", async () => {
    const inicio = "2030-03-21T13:00:00Z";
    const fim = "2030-03-21T14:00:00Z";
    await compromisso({ inicio, fim });
    await expect(compromisso({ inicio, fim })).rejects.toMatchObject({ code: "23505" });
  });
});

describe("fn_agenda_revezamento_do_dono", () => {
  const SQL = "select * from public.fn_agenda_revezamento_do_dono($1, $2, $3) order by nome nulls last";

  it("dono e atendente recebem o mesmo: as agendas pedidas (com nome) e o destino", async () => {
    const args = [GOV_ORG, GOV_AGENT_A, [JESSICA, PESSOAL]];
    const doDono = (await como(usuario(GOV_AGENT_A), SQL, args)).rows;
    const doColega = (await como(usuario(GOV_AGENT_B), SQL, args)).rows;
    expect(doColega).toEqual(doDono);
    const porId = new Map(doDono.map((l) => [l.agenda_id, l]));
    expect(porId.get(JESSICA)).toMatchObject({ nome: "Jessica", na_lista: true, destino: false, aceita_escrita: true, conta_conflito: true });
    expect(porId.get(PESSOAL)).toMatchObject({ nome: "Pessoal", na_lista: true });
    // O destino volta sem nome: ele não foi pedido.
    expect(porId.get(MARIA)).toMatchObject({ nome: null, na_lista: false, destino: true });
    expect(porId.has(DO_COLEGA), "veio agenda de outra pessoa").toBe(false);
  });

  it("outra organização recebe zero, mesmo passando o p_org certo; anon não executa", async () => {
    const r = await como(usuario(USUARIO_DA_VIZINHA), SQL, [GOV_ORG, GOV_AGENT_A, [JESSICA]]);
    expect(r.rowCount).toBe(0);
    await expect(como({ tipo: "anon" }, SQL, [GOV_ORG, GOV_AGENT_A, [JESSICA]])).rejects.toMatchObject({ code: "42501" });
  });
});

describe("fn_agenda_ocupacao_google_das_agendas", () => {
  const SQL = "select * from public.fn_agenda_ocupacao_google_das_agendas($1, $2, $3, $4, $5)";

  it("ocupação por agenda: a da Maria vem marcada; a sem catálogo vem com agenda nula; o título não aparece", async () => {
    const r = await como(usuario(GOV_AGENT_B), SQL, [GOV_ORG, GOV_AGENT_A, [MARIA, JESSICA], ...JANELA]);
    const agendas = r.rows.map((l) => l.agenda_id).sort((a, b) => String(a).localeCompare(String(b)));
    expect(agendas).toEqual([MARIA, null].sort((a, b) => String(a).localeCompare(String(b))));
    expect(r.fields.map((f) => f.name)).toEqual([
      "agenda_id",
      "starts_at",
      "ends_at",
      "transparency",
      "status",
      "connection_status",
    ]);
    expect(JSON.stringify(r.rows)).not.toContain("Cirurgia");
  });

  it("agenda fora da lista não vem (só a sem catálogo, que ocupa todas)", async () => {
    const r = await como(usuario(GOV_AGENT_A), SQL, [GOV_ORG, GOV_AGENT_A, [JESSICA], ...JANELA]);
    expect(r.rows.map((l) => l.agenda_id)).toEqual([null]);
  });

  it("outra organização recebe zero; anon não executa; service_role lê", async () => {
    expect((await como(usuario(USUARIO_DA_VIZINHA), SQL, [GOV_ORG, GOV_AGENT_A, [MARIA], ...JANELA])).rowCount).toBe(0);
    await expect(como({ tipo: "anon" }, SQL, [GOV_ORG, GOV_AGENT_A, [MARIA], ...JANELA])).rejects.toMatchObject({
      code: "42501",
    });
    expect((await como({ tipo: "service_role" }, SQL, [GOV_ORG, GOV_AGENT_A, [MARIA], ...JANELA])).rowCount).toBe(2);
  });
});
