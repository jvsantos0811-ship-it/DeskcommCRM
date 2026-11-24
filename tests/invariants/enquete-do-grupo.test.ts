import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * ENQUETE DO GRUPO NO POSTGRES DE VERDADE (PC-050, migration 9041).
 *
 *   1. As três tabelas são só do servidor: anon e o admin da própria
 *      organização (JWT) recebem `permission denied` em SELECT, INSERT, UPDATE e
 *      DELETE — com as linhas da própria organização existindo (controle).
 *   2. A forma: código, pergunta, opções (1 a 12), campo do voto só como NOME,
 *      um voto por contato e enquete; apagar a enquete leva os votos dela.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const P = "90410000-0000-4000-8000";
const ORG = `${P}-0000000000a1`;
const ADMIN_DA_ORG = `${P}-0000000000e5`;
let contato = "";
let enquete = "";

async function como(papel: "anon" | "authenticated", sql: string): Promise<unknown> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${papel}`);
    if (papel === "authenticated") {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN_DA_ORG, role: "authenticated" })]);
    }
    return (await c.query(sql)).rows;
  } finally {
    await c.query("rollback");
    c.release();
  }
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1, 'inv-enquete-a', 'Enquete A LTDA', 'Enquete A', '{}'::jsonb) on conflict (id) do nothing`,
    [ORG],
  );
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1, 'Votante') returning id`,
    [ORG],
  );
  contato = c[0]!.id;
  await pool.query(`insert into enquetes_config (organization_id, ligada, campo_do_voto) values ($1, true, 'campos_personalizados.ia_origem')`, [ORG]);
  const { rows: e } = await pool.query<{ id: string }>(
    `insert into enquetes_do_grupo (organization_id, codigo, pergunta, opcoes)
     values ($1, 'reparadora', 'Quer saber?', '[{"valor":"Sim","significado":"","chamar":true}]'::jsonb) returning id`,
    [ORG],
  );
  enquete = e[0]!.id;
  await pool.query(`insert into enquetes_votos (organization_id, enquete_id, contact_id, opcao) values ($1, $2, $3, 'Sim')`, [ORG, enquete, contato]);
});

afterAll(async () => {
  await pool.end();
});

describe("enquete do grupo (9041)", () => {
  it("⭐ só o service_role: anon e o admin da organização não leem nem escrevem", async () => {
    for (const papel of ["anon", "authenticated"] as const) {
      for (const tabela of ["enquetes_config", "enquetes_do_grupo", "enquetes_votos"]) {
        await expect(como(papel, `select * from ${tabela}`)).rejects.toThrow(/permission denied/);
        await expect(como(papel, `delete from ${tabela}`)).rejects.toThrow(/permission denied/);
        await expect(como(papel, `update ${tabela} set updated_at = now()`)).rejects.toThrow(/permission denied/);
      }
      await expect(
        como(papel, `insert into enquetes_votos (organization_id, enquete_id, contact_id, opcao) values ('${ORG}', '${enquete}', '${contato}', 'x')`),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("a forma: código, opções de 1 a 12, campo só como nome, um voto por contato e enquete", async () => {
    await expect(
      pool.query(`insert into enquetes_do_grupo (organization_id, codigo, pergunta, opcoes) values ($1, 'Com Espaço', 'p', '[{"valor":"a"}]'::jsonb)`, [ORG]),
    ).rejects.toThrow(/enquetes_do_grupo_codigo_check/);
    await expect(
      pool.query(`insert into enquetes_do_grupo (organization_id, codigo, pergunta, opcoes) values ($1, 'vazia', 'p', '[]'::jsonb)`, [ORG]),
    ).rejects.toThrow(/enquetes_do_grupo_opcoes_check/);
    await expect(
      pool.query(`update enquetes_config set campo_do_voto = 'a; drop table x' where organization_id = $1`, [ORG]),
    ).rejects.toThrow(/enquetes_config_campo_do_voto_check/);
    await expect(
      pool.query(`insert into enquetes_votos (organization_id, enquete_id, contact_id, opcao) values ($1, $2, $3, 'Sim')`, [ORG, enquete, contato]),
    ).rejects.toThrow(/enquetes_votos_um_por_contato/);
  });

  it("apagar a enquete leva os votos dela", async () => {
    await pool.query(`delete from enquetes_do_grupo where id = $1`, [enquete]);
    const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from enquetes_votos where enquete_id = $1`, [enquete]);
    expect(rows[0]!.n).toBe(0);
  });
});
