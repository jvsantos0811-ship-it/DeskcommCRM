import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * PM-027 (migration 9023) — A BATERIA DO LEITOR, contra o Postgres do baseline.
 *
 *   1. um caso ativo por id; a versão nova de um gabarito convive com a antiga
 *      (desativada), e a mesma versão não repete;
 *   2. nenhum usuário do app lê os casos nem os resultados (a conversa congelada
 *      é de um escritório e a aprovação vale para todos); anon não lê nada;
 *   3. o placar das rodadas é legível por quem está logado (só números) e
 *      ninguém logado escreve;
 *   4. a anonimização do contato apaga o caso dele e, em cascata, os resultados;
 *      o caso inventado (sem origem) fica.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Dar select de leitor_bateria_casos a authenticated: o caso 2 acusa.
 * - Tirar o gatilho da anonimização: o caso 4 acusa.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "90230000-0000-4000-8000-00000000000a";
const MEMBRO = "90230000-1111-4000-8000-000000000001";
let contato = "";
let rodada = "";

async function como(user: string | null, sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(user ? "set local role authenticated" : "set local role anon");
    if (user) {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    }
    const { rows } = await c.query(sql, params);
    return rows;
  } finally {
    await c.query("rollback");
    c.release();
  }
}

const caso = (casoId: string, versao: number, ativo: boolean, comOrigem: boolean) =>
  pool.query<{ id: string }>(
    `insert into leitor_bateria_casos (caso_id, versao, ativo, origem_organization_id, origem_contact_id, relogio, conversa, gabarito)
     values ($1,$2,$3,$4,$5,'2026-11-05T21:40:00-03:00','[2026-11-05T10:00] Contato: oi','{"tipo":"parcial","ficha":{}}'::jsonb) returning id`,
    [casoId, versao, ativo, comOrigem ? ORG : null, comOrigem ? contato : null],
  );

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,'inv-9023','inv-9023','inv-9023') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [MEMBRO, `${MEMBRO}@invariant.test`]);
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,'admin', now()) on conflict do nothing`,
    [MEMBRO, ORG],
  );
  contato = (await pool.query<{ id: string }>(`insert into contacts (organization_id, display_name) values ($1,'Caso 9023') returning id`, [ORG]))
    .rows[0]!.id;
  rodada = (
    await pool.query<{ id: string }>(
      `insert into leitor_bateria_rodadas (provider, model_id, juiz_provider, juiz_model_id, status, acertos, casos_total)
       values ('anthropic','claude-haiku-5-5','anthropic','claude-opus-5-5','terminada', 77, 78) returning id`,
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await pool.query(`delete from leitor_bateria_rodadas where id = $1`, [rodada]);
  await pool.query(`delete from leitor_bateria_casos where caso_id like 'INV9023-%'`);
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

describe("bateria do Leitor no banco (migration 9023)", () => {
  it("1. um caso ativo por id; versão nova convive com a antiga; a mesma versão não repete", async () => {
    await caso("INV9023-B01", 1, false, false);
    await caso("INV9023-B01", 2, true, false);
    await expect(caso("INV9023-B01", 3, true, false)).rejects.toMatchObject({ code: "23505" });
    await expect(caso("INV9023-B01", 2, false, false)).rejects.toMatchObject({ code: "23505" });
  });

  it("2. nenhum usuário do app lê casos nem resultados; anon não lê nada", async () => {
    await expect(como(MEMBRO, `select 1 from leitor_bateria_casos`)).rejects.toMatchObject({ code: "42501" });
    await expect(como(MEMBRO, `select 1 from leitor_bateria_resultados`)).rejects.toMatchObject({ code: "42501" });
    for (const t of ["leitor_bateria_casos", "leitor_bateria_resultados", "leitor_bateria_rodadas"]) {
      await expect(como(null, `select 1 from ${t}`)).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("3. o placar das rodadas é legível por quem está logado, e ninguém logado escreve", async () => {
    const r = await como(MEMBRO, `select acertos, casos_total from leitor_bateria_rodadas where id = $1`, [rodada]);
    expect(r).toEqual([{ acertos: 77, casos_total: 78 }]);
    await expect(
      como(MEMBRO, `update leitor_bateria_rodadas set aprovado = true where id = $1`, [rodada]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("4. a anonimização apaga o caso do contato e os resultados dele; o inventado fica", async () => {
    const real = (await caso("INV9023-EQ1", 1, true, true)).rows[0]!.id;
    await pool.query(
      `insert into leitor_bateria_resultados (rodada_id, caso_uuid, caso_id, caso_versao, passou_sem_juiz, acerto)
       values ($1, $2, 'INV9023-EQ1', 1, true, true)`,
      [rodada, real],
    );
    await pool.query(`update contacts set is_anonymized = true, anonymized_at = now() where id = $1`, [contato]);
    const resta = async (sql: string, p: unknown[]) => Number((await pool.query(sql, p)).rows[0]!.n);
    expect(await resta(`select count(*)::int as n from leitor_bateria_casos where id = $1`, [real])).toBe(0);
    expect(await resta(`select count(*)::int as n from leitor_bateria_resultados where caso_uuid = $1`, [real])).toBe(0);
    expect(await resta(`select count(*)::int as n from leitor_bateria_casos where caso_id = 'INV9023-B01'`, [])).toBe(2);
  });
});
