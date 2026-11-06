import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * PM-025 §7 (migration 9021) — O AVISO "NINGUÉM RESPONDEU", contra o Postgres do baseline.
 *
 * O que só o banco garante:
 *   1. o vocabulário da Central aceita `ninguem_respondeu` (e continua fechado);
 *   2. um aviso ABERTO por conversa — a segunda rodada concorrente recebe 23505
 *      — e, resolvido, a conversa pode ganhar outro;
 *   3. a memória da leitura curta (`conferencias_de_fim_da_conversa`): um
 *      veredito por mensagem do lead; membro lê só a própria organização;
 *      anon não lê; logado não escreve (só o cron, com o service_role).
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Tirar o kind do CHECK: o caso 1 acusa.
 * - Tirar o índice único parcial: o caso 2 acusa.
 * - Trocar a policy por `using (true)` ou dar insert a `authenticated`: o caso 3 acusa.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "90210000-0000-4000-8000-00000000000a";
const OUTRA = "90210000-0000-4000-8000-00000000000b";
const MEMBRO = "90210000-1111-4000-8000-000000000001";
const MEMBRO_DA_OUTRA = "90210000-1111-4000-8000-000000000002";
const conversa: Record<string, string> = {};

async function semear(org: string, slug: string, user: string): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,$2::text,$2::text,$2::text) on conflict (id) do nothing`,
    [org, slug],
  );
  await pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [user, `${user}@invariant.test`]);
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,'agent', now()) on conflict do nothing`,
    [user, org],
  );
  const sess = (
    await pool.query<{ id: string }>(
      `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1, gen_random_uuid()::text, 'WORKING', decode('00','hex')) returning id`,
      [org],
    )
  ).rows[0]!.id;
  const contato = (
    await pool.query<{ id: string }>(`insert into contacts (organization_id, display_name) values ($1,'Lead 9021') returning id`, [org])
  ).rows[0]!.id;
  conversa[org] = (
    await pool.query<{ id: string }>(
      `insert into conversations (organization_id, contact_id, channel_session_id) values ($1,$2,$3) returning id`,
      [org, contato, sess],
    )
  ).rows[0]!.id;
}

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

async function aviso(org: string, status = "open") {
  return pool.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id, status)
     values ($1, 'ninguem_respondeu', 'warn', 'Um lead escreveu e ninguém respondeu', 'teste', 'conversation', $2, $3) returning id`,
    [org, conversa[org], status],
  );
}

beforeAll(async () => {
  await semear(ORG, "inv-9021-a", MEMBRO);
  await semear(OUTRA, "inv-9021-b", MEMBRO_DA_OUTRA);
});

afterAll(async () => {
  await pool.query(`delete from organizations where id = any($1::uuid[])`, [[ORG, OUTRA]]);
  await pool.end();
});

describe("aviso Ninguém respondeu no banco (migration 9021)", () => {
  it("1. o vocabulário da Central aceita o kind novo e continua fechado", async () => {
    const { rows } = await aviso(ORG);
    expect(rows).toHaveLength(1);
    await pool.query(`update agent_inbox_items set status = 'resolved', resolved_at = now() where id = $1`, [rows[0]!.id]);
    await expect(
      pool.query(
        `insert into agent_inbox_items (organization_id, kind, severity, title, ref_kind, ref_id) values ($1,'kind_que_nao_existe','warn','x','conversation',$2)`,
        [ORG, conversa[ORG]],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("2. um aviso aberto por conversa; resolvido, a conversa pode ganhar outro", async () => {
    const primeiro = await aviso(OUTRA);
    await expect(aviso(OUTRA)).rejects.toMatchObject({ code: "23505" });
    await pool.query(`update agent_inbox_items set status = 'resolved', resolved_at = now() where id = $1`, [primeiro.rows[0]!.id]);
    const segundo = await aviso(OUTRA);
    expect(segundo.rows).toHaveLength(1);
  });

  it("3a. um veredito por mensagem do lead", async () => {
    const msg = "90210000-2222-4000-8000-000000000001";
    await pool.query(
      `insert into conferencias_de_fim_da_conversa (organization_id, conversation_id, message_id, terminou) values ($1,$2,$3,false)`,
      [ORG, conversa[ORG], msg],
    );
    await expect(
      pool.query(
        `insert into conferencias_de_fim_da_conversa (organization_id, conversation_id, message_id, terminou) values ($1,$2,$3,true)`,
        [ORG, conversa[ORG], msg],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        `insert into conferencias_de_fim_da_conversa (organization_id, conversation_id, message_id, terminou, origem) values ($1,$2,gen_random_uuid(),true,'palpite')`,
        [ORG, conversa[ORG]],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("3b. membro lê só a própria organização; anon não lê; logado não escreve", async () => {
    await pool.query(
      `insert into conferencias_de_fim_da_conversa (organization_id, conversation_id, message_id, terminou) values ($1,$2,gen_random_uuid(),true)`,
      [OUTRA, conversa[OUTRA]],
    );
    const daA = await como(MEMBRO, `select organization_id from conferencias_de_fim_da_conversa`);
    expect(daA.length).toBeGreaterThan(0);
    expect(new Set(daA.map((r) => r.organization_id))).toEqual(new Set([ORG]));

    const daB = await como(MEMBRO_DA_OUTRA, `select organization_id from conferencias_de_fim_da_conversa`);
    expect(new Set(daB.map((r) => r.organization_id))).toEqual(new Set([OUTRA]));

    await expect(como(null, `select 1 from conferencias_de_fim_da_conversa`)).rejects.toMatchObject({ code: "42501" });
    await expect(
      como(
        MEMBRO,
        `insert into conferencias_de_fim_da_conversa (organization_id, conversation_id, message_id, terminou) values ($1,$2,gen_random_uuid(),true)`,
        [ORG, conversa[ORG]],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
