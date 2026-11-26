import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { SQL_TETO_DO_PLANO } from "@/lib/agent-engine/edge/llm/orcamento";

/**
 * O CRÉDITO DE IA CONTRA O POSTGRES DE VERDADE (PC-051, migration 9044).
 *
 *   1. As duas tabelas são só do servidor: anon e o admin da própria
 *      organização (JWT) recebem `permission denied` em SELECT, INSERT, UPDATE e
 *      DELETE, e na função — com a linha existindo (controle positivo).
 *   2. O teto do plano + crédito: o statement REAL do gate (`SQL_TETO_DO_PLANO`)
 *      devolve o teto do plano somado ao crédito pago que vale no mês, e o
 *      aviso do plano se fecha quando o crédito tira o gasto de cima do teto.
 *   3. As regras do João (23/11): consumo primeiro do incluído no plano, depois
 *      do crédito mais antigo; o que sobra vence no fim do mês SEGUINTE ao do
 *      pagamento; o incluído no plano não acumula; pendente e cancelado não
 *      contam.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const P = "90400000-0000-4000-8000";
const ORG = `${P}-0000000000a1`;
const ORG_B = `${P}-0000000000b2`;
const ORG_C = `${P}-0000000000c3`;
const PLANO = `${P}-0000000000d4`;
const ADMIN_DA_ORG = `${P}-0000000000e5`;
/** O estado da chave da cobrança antes deste arquivo: volta igual no fim (o banco é compartilhado). */
let moduloAntes: string | null = null;

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

async function teto(org: string): Promise<{ teto: number | null; gasto: number | null }> {
  const { rows } = await pool.query<{ teto: string | null; gasto: string | null }>(SQL_TETO_DO_PLANO, [org, "ia_usd_cents"]);
  const r = rows[0]!;
  return { teto: r.teto === null ? null : Number(r.teto), gasto: r.gasto === null ? null : Number(r.gasto) };
}

async function credito(org: string): Promise<number> {
  const { rows } = await pool.query<{ v: string }>("select public.fn_credito_de_ia_disponivel($1) as v", [org]);
  return Number(rows[0]!.v);
}

/** Gasto num instante: `mesesAtras` = 0 é o mês corrente (no dia 1, 00:30, para cair dentro dele). */
async function gastar(org: string, cents: number, mesesAtras: number): Promise<void> {
  await pool.query(
    `insert into llm_calls (organization_id, purpose, provider, model, input_tokens, output_tokens, cost_cents, latency_ms, created_at)
     values ($1, 'agent_turn', 'anthropic', 'claude-sonnet-4', 10, 10, $2, 100,
             date_trunc('month', now()) - make_interval(months => $3) + interval '30 minutes')`,
    [org, cents, mesesAtras],
  );
}

async function pagarCredito(org: string, usdCents: number, mesesAtras: number, status = "pago"): Promise<void> {
  await pool.query(
    `insert into ia_creditos (organization_id, origem, status, preco_cents, ia_usd_cents, pago_em, vence_em)
     values ($1, 'compra', $2, 10000, $3,
             case when $2 = 'pago' then date_trunc('month', now()) - make_interval(months => $4) + interval '1 hour' end,
             case when $2 = 'pago' then date_trunc('month', now()) - make_interval(months => $4) + interval '2 months' end)`,
    [org, status, usdCents, mesesAtras],
  );
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings) values
       ($1, 'inv-credito-ia-a', 'Crédito A LTDA', 'Crédito A', '{}'::jsonb),
       ($2, 'inv-credito-ia-b', 'Crédito B LTDA', 'Crédito B', '{}'::jsonb),
       ($3, 'inv-credito-ia-c', 'Crédito C LTDA', 'Crédito C', '{}'::jsonb)
     on conflict (id) do nothing`,
    [ORG, ORG_B, ORG_C],
  );
  await pool.query(
    `insert into cobranca_planos (id, nome, preco_cents, intervalo, teto_ia_usd_cents, oferece_credito_ia)
     values ($1, 'Com crédito', 70000, 'mes', 1000, true) on conflict (id) do nothing`,
    [PLANO],
  );
  await pool.query(
    `insert into cobranca_assinaturas (organization_id, plano_id, estado, trial_ate)
     select o, $1, 'trial', now() + interval '14 days' from unnest($2::uuid[]) as o
     on conflict (organization_id) do nothing`,
    [PLANO, [ORG, ORG_B, ORG_C]],
  );
  const { rows: antes } = await pool.query<{ valor: string }>(`select valor from platform_config where chave = 'MODULO_COBRANCA'`);
  moduloAntes = antes[0]?.valor ?? null;
  await pool.query(
    `insert into platform_config (chave, valor) values ('MODULO_COBRANCA', 'ligado')
     on conflict (chave) do update set valor = excluded.valor`,
  );
});

afterAll(async () => {
  if (moduloAntes === null) await pool.query(`delete from platform_config where chave = 'MODULO_COBRANCA'`);
  else await pool.query(`update platform_config set valor = $1 where chave = 'MODULO_COBRANCA'`, [moduloAntes]);
  await pool.end();
});

describe("crédito de IA (9044)", () => {
  it("⭐ só o service_role: anon e o admin da organização não leem, não escrevem nem executam", async () => {
    await pool.query(`insert into cobranca_pacotes_credito_ia (nome, preco_cents, ia_usd_cents) values ('Controle', 10000, 1500)`);
    await pagarCredito(ORG_C, 100, 0);
    const { rows } = await pool.query<{ n: number }>(
      `select (select count(*) from ia_creditos where organization_id = $1)::int
            + (select count(*) from cobranca_pacotes_credito_ia)::int as n`,
      [ORG_C],
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
    for (const papel of ["anon", "authenticated"] as const) {
      for (const tabela of ["ia_creditos", "cobranca_pacotes_credito_ia"]) {
        await expect(como(papel, `select * from ${tabela}`)).rejects.toThrow(/permission denied/);
        await expect(como(papel, `delete from ${tabela}`)).rejects.toThrow(/permission denied/);
        await expect(como(papel, `update ${tabela} set created_at = now()`)).rejects.toThrow(/permission denied/);
      }
      await expect(
        como(papel, `insert into ia_creditos (organization_id, origem, status, ia_usd_cents, motivo, pago_em, vence_em)
                      values ('${ORG_C}', 'cortesia', 'pago', 99999, 'forjado', now(), now() + interval '1 month')`),
      ).rejects.toThrow(/permission denied/);
      await expect(como(papel, `select public.fn_credito_de_ia_disponivel('${ORG_C}')`)).rejects.toThrow(/permission denied/);
    }
  });

  it("a forma: compra pede preço, cortesia pede motivo, pago pede as datas", async () => {
    const recusa = async (sql: string, restricao: string) => {
      await expect(pool.query(sql)).rejects.toThrow(new RegExp(restricao));
    };
    await recusa(
      `insert into ia_creditos (organization_id, origem, status, ia_usd_cents) values ('${ORG_C}', 'compra', 'pendente', 100)`,
      "ia_creditos_compra_tem_preco",
    );
    await recusa(
      `insert into ia_creditos (organization_id, origem, status, ia_usd_cents, pago_em, vence_em) values ('${ORG_C}', 'cortesia', 'pago', 100, now(), now())`,
      "ia_creditos_cortesia_tem_motivo",
    );
    await recusa(
      `insert into ia_creditos (organization_id, origem, status, preco_cents, ia_usd_cents) values ('${ORG_C}', 'compra', 'pago', 100, 100)`,
      "ia_creditos_pago_tem_datas",
    );
    await recusa(
      `insert into cobranca_pacotes_credito_ia (nome, preco_cents, ia_usd_cents) values ('Barato', 499, 100)`,
      "cobranca_pacotes_credito_ia_preco_cents_check",
    );
  });

  it("⭐ sem crédito o teto é o do plano; crédito pago no mês soma ao teto e fecha o aviso do plano", async () => {
    await gastar(ORG, 1200, 0);
    expect(await teto(ORG)).toEqual({ teto: 1000, gasto: 1200 });
    await pool.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       values ($1, 'budget_exceeded', 'critical', 'titulo', 'corpo', 'plano', $1)`,
      [ORG],
    );
    // Pendente e cancelado não contam.
    await pagarCredito(ORG, 500, 0, "pendente");
    await pagarCredito(ORG, 500, 0, "cancelado");
    expect((await teto(ORG)).teto).toBe(1000);
    // Pago conta: teto 1000 + 500; o gasto de 1200 sai de cima do teto e o aviso fecha.
    await pagarCredito(ORG, 500, 0);
    expect(await teto(ORG)).toEqual({ teto: 1500, gasto: 1200 });
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from agent_inbox_items where organization_id = $1 and kind = 'budget_exceeded' and ref_kind = 'plano' and status = 'open'`,
      [ORG],
    );
    expect(rows[0]!.n, "o crédito pago não fechou o aviso do plano").toBe(0);
  });

  it("⭐ o que sobra passa para o mês seguinte e vence no fim dele; o incluído no plano não acumula", async () => {
    // Mês -2: comprou 400, gastou 1100 (100 além do plano) → sobram 300, que valem até o fim do mês -1.
    await pagarCredito(ORG_B, 400, 2);
    await gastar(ORG_B, 1100, 2);
    // Mês -1: comprou 600, gastou 1500 (500 além do plano): come os 300 do mês -2 (que vencem) e 200 dos 600 → sobram 400.
    await pagarCredito(ORG_B, 600, 1);
    await gastar(ORG_B, 1500, 1);
    // Mês corrente: valem só os 400 que sobraram do mês -1; o mês -1 não deixou "incluído no plano" sobrando para cá.
    expect(await credito(ORG_B)).toBe(400);
    // E nenhum crédito vale 3 meses: o que sobrou do mês -2 não volta.
    await gastar(ORG_B, 1300, 0);
    expect(await teto(ORG_B)).toEqual({ teto: 1400, gasto: 1300 });
  });

  it("gasto abaixo do teto do plano: o crédito nem é calculado e o teto é o do plano", async () => {
    // ORG_C tem 100 de crédito pago neste mês (caso do acesso) e gasto zero.
    expect(await teto(ORG_C)).toEqual({ teto: 1000, gasto: 0 });
    expect(await credito(ORG_C)).toBe(100);
  });
});
