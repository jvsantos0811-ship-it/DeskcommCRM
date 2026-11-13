import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * PM-027 (migration 9022) — A FICHA DO LEAD DO LEITOR DA CONVERSA, contra o
 * Postgres do baseline.
 *
 * O que só o banco garante:
 *   1. uma ficha por lead; o gatilho do vocabulário recusa gatilho inventado;
 *   2. cada leitura NOVA guarda a anterior no histórico (e só a leitura nova:
 *      um update que não troca `lida_em` não duplica);
 *   3. a anonimização do contato apaga a ficha e o histórico DELE — e só dele;
 *   4. quem lê: membro que vê a organização inteira; o agent em "só os seus" não
 *      lê; o vizinho não lê; anon não lê; logado não escreve;
 *   5. uma rodada diária por organização e dia (as manuais podem repetir);
 *   6. o aviso `lead_voltou` existe e é um aberto por lead;
 *   7. o checklist por tipo de lead nasce vazio.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Tirar o `when (old.lida_em is distinct from new.lida_em)`: o caso 2 acusa.
 * - Tirar um dos deletes de `fn_apagar_ficha_do_lead_ao_anonimizar`: o caso 3 acusa.
 * - Trocar a policy por `organization_id in (fn_user_org_ids())` só: o caso 4 acusa.
 * - Tirar o índice único parcial das rodadas ou do aviso: os casos 5 e 6 acusam.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "90220000-0000-4000-8000-00000000000a";
const OUTRA = "90220000-0000-4000-8000-00000000000b";
const GERENTE = "90220000-1111-4000-8000-000000000001";
const ATENDENTE = "90220000-1111-4000-8000-000000000002";
const GERENTE_DA_OUTRA = "90220000-1111-4000-8000-000000000003";

interface Semente {
  contato: string;
  outroContato: string;
  lead: string;
  outroLead: string;
}
const s: Record<string, Semente> = {};

async function usuario(id: string, org: string, papel: string): Promise<void> {
  await pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [id, `${id}@invariant.test`]);
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,$3, now()) on conflict do nothing`,
    [id, org, papel],
  );
}

async function semear(org: string, slug: string): Promise<Semente> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,$2::text,$2::text,$2::text) on conflict (id) do nothing`,
    [org, slug],
  );
  const etapa = (
    await pool.query<{ pipeline_id: string; id: string }>(
      `select s.pipeline_id, s.id from crm_stages s join crm_pipelines p on p.id = s.pipeline_id
        where p.organization_id = $1 order by p.is_default desc, s.position limit 1`,
      [org],
    )
  ).rows[0]!;
  const contato = async (nome: string) =>
    (await pool.query<{ id: string }>(`insert into contacts (organization_id, display_name) values ($1,$2) returning id`, [org, nome]))
      .rows[0]!.id;
  const lead = async (c: string, titulo: string) =>
    (
      await pool.query<{ id: string }>(
        `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title) values ($1,$2,$3,$4,$5) returning id`,
        [org, etapa.pipeline_id, etapa.id, c, titulo],
      )
    ).rows[0]!.id;
  const c1 = await contato("Lead 9022");
  const c2 = await contato("Outro 9022");
  return { contato: c1, outroContato: c2, lead: await lead(c1, "Negócio 9022"), outroLead: await lead(c2, "Outro negócio 9022") };
}

async function ficha(org: string, lead: string, contato: string, lidaEm = "2026-11-06T09:00:00Z", gatilho = "mensagem_do_lead") {
  return pool.query(
    `insert into crm_lead_ficha (organization_id, lead_id, contact_id, ficha, modelo, versao_prompt, gatilho, lida_em)
     values ($1,$2,$3,'{"contato":"lead"}'::jsonb,'anthropic/claude-haiku-5-5','pm027-v1',$4,$5)`,
    [org, lead, contato, gatilho, lidaEm],
  );
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

const historico = async (lead: string) =>
  Number((await pool.query(`select count(*)::int as n from crm_lead_ficha_historico where lead_id = $1`, [lead])).rows[0]!.n);

beforeAll(async () => {
  s[ORG] = await semear(ORG, "inv-9022-a");
  s[OUTRA] = await semear(OUTRA, "inv-9022-b");
  await usuario(GERENTE, ORG, "manager");
  await usuario(ATENDENTE, ORG, "agent");
  await usuario(GERENTE_DA_OUTRA, OUTRA, "manager");
  await ficha(ORG, s[ORG]!.lead, s[ORG]!.contato);
  await ficha(ORG, s[ORG]!.outroLead, s[ORG]!.outroContato);
  await ficha(OUTRA, s[OUTRA]!.lead, s[OUTRA]!.contato);
});

afterAll(async () => {
  await pool.query(`delete from organizations where id = any($1::uuid[])`, [[ORG, OUTRA]]);
  await pool.end();
});

describe("Ficha do lead no banco (migration 9022)", () => {
  it("1. uma ficha por lead; gatilho fora do vocabulário é recusado", async () => {
    await expect(ficha(ORG, s[ORG]!.lead, s[ORG]!.contato)).rejects.toMatchObject({ code: "23505" });
    await expect(ficha(ORG, s[OUTRA]!.lead, null as unknown as string, undefined, "mudou_de_etapa")).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("2. a leitura nova guarda a anterior no histórico; update sem leitura nova não duplica", async () => {
    const lead = s[ORG]!.lead;
    expect(await historico(lead)).toBe(0);
    await pool.query(
      `update crm_lead_ficha set ficha = '{"contato":"cliente"}'::jsonb, gatilho = 'mensagem_da_equipe', lida_em = '2026-11-07T09:00:00Z'
        where lead_id = $1`,
      [lead],
    );
    expect(await historico(lead)).toBe(1);
    const anterior = (
      await pool.query(`select ficha->>'contato' as contato, gatilho from crm_lead_ficha_historico where lead_id = $1`, [lead])
    ).rows[0];
    expect(anterior).toEqual({ contato: "lead", gatilho: "mensagem_do_lead" });
    await pool.query(`update crm_lead_ficha set modelo = 'outro' where lead_id = $1`, [lead]);
    expect(await historico(lead)).toBe(1);
  });

  it("3. a anonimização apaga a ficha e o histórico do contato — e só dele", async () => {
    const { contato, lead, outroLead } = s[ORG]!;
    await pool.query(`update contacts set is_anonymized = true, anonymized_at = now() where id = $1`, [contato]);
    const resta = async (l: string) =>
      Number((await pool.query(`select count(*)::int as n from crm_lead_ficha where lead_id = $1`, [l])).rows[0]!.n);
    expect(await resta(lead)).toBe(0);
    expect(await historico(lead)).toBe(0);
    expect(await resta(outroLead)).toBe(1);
  });

  it("4. lê quem vê a organização inteira; atendente em 'só os seus', vizinho e anon não; logado não escreve", async () => {
    const doGerente = await como(GERENTE, `select organization_id from crm_lead_ficha`);
    expect(doGerente.length).toBeGreaterThan(0);
    expect(new Set(doGerente.map((r) => r.organization_id))).toEqual(new Set([ORG]));
    expect(await como(ATENDENTE, `select 1 from crm_lead_ficha`)).toHaveLength(0);
    expect(await como(ATENDENTE, `select 1 from crm_lead_ficha_historico`)).toHaveLength(0);
    const daOutra = await como(GERENTE_DA_OUTRA, `select organization_id from crm_lead_ficha`);
    expect(new Set(daOutra.map((r) => r.organization_id))).toEqual(new Set([OUTRA]));
    await expect(como(null, `select 1 from crm_lead_ficha`)).rejects.toMatchObject({ code: "42501" });
    await expect(como(null, `select 1 from crm_lead_ficha_historico`)).rejects.toMatchObject({ code: "42501" });
    await expect(
      como(GERENTE, `update crm_lead_ficha set modelo = 'x' where organization_id = $1`, [ORG]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      como(
        GERENTE,
        `insert into crm_lead_ficha_historico (organization_id, lead_id, ficha, modelo, versao_prompt, gatilho, lida_em)
         values ($1, $2, '{}'::jsonb, 'x', 'x', 'chat_novo', now())`,
        [ORG, s[ORG]!.outroLead],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("5. uma rodada diária por organização e dia; as manuais podem repetir", async () => {
    await pool.query(`insert into leitor_rodadas (organization_id, dia) values ($1, '2026-11-06')`, [ORG]);
    await expect(
      pool.query(`insert into leitor_rodadas (organization_id, dia) values ($1, '2026-11-06')`, [ORG]),
    ).rejects.toMatchObject({ code: "23505" });
    await pool.query(`insert into leitor_rodadas (organization_id, dia, origem) values ($1, '2026-11-06', 'manual')`, [ORG]);
    await pool.query(`insert into leitor_rodadas (organization_id, dia, origem) values ($1, '2026-11-06', 'manual')`, [ORG]);
    await expect(
      pool.query(`insert into leitor_rodadas (organization_id, dia, origem) values ($1, '2026-11-06', 'semanal')`, [ORG]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await como(GERENTE_DA_OUTRA, `select 1 from leitor_rodadas where organization_id = $1`, [ORG])).toHaveLength(0);
  });

  it("6. o aviso 'lead perdido voltou a escrever' é um aberto por lead", async () => {
    const aviso = (status = "open") =>
      pool.query(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id, status)
         values ($1, 'lead_voltou', 'info', 'Um lead perdido voltou a escrever', 'teste', 'lead', $2, $3) returning id`,
        [OUTRA, s[OUTRA]!.lead, status],
      );
    const primeiro = await aviso();
    await expect(aviso()).rejects.toMatchObject({ code: "23505" });
    await pool.query(`update agent_inbox_items set status = 'resolved', resolved_at = now() where id = $1`, [primeiro.rows[0]!.id]);
    expect((await aviso()).rows).toHaveLength(1);
  });

  it("7. o checklist de requisitos do tipo de lead nasce vazio", async () => {
    const { rows } = await pool.query(
      `select column_default, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'catalog_products' and column_name = 'requisitos'`,
    );
    expect(rows[0]).toMatchObject({ is_nullable: "NO" });
    expect(String(rows[0]!.column_default)).toContain("{}");
  });
});

describe("Leitor pelo Claude no banco (migration 9033, PC-036)", () => {
  it("8. a ficha nasce com origem leitor_do_crm; origem fora do vocabulário é recusada", async () => {
    const { rows } = await pool.query(`select origem from crm_lead_ficha where lead_id = $1`, [s[ORG]!.outroLead]);
    expect(rows[0]).toEqual({ origem: "leitor_do_crm" });
    await expect(
      pool.query(`update crm_lead_ficha set origem = 'chute' where lead_id = $1`, [s[ORG]!.outroLead]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("9. a leitura nova guarda no histórico a ORIGEM da anterior", async () => {
    const lead = s[OUTRA]!.lead;
    await pool.query(
      `update crm_lead_ficha set origem = 'leitor_0530', modelo = 'claude-sonnet-5-5 (tarefa)', lida_em = '2026-11-14T08:30:00Z'
        where lead_id = $1`,
      [lead],
    );
    await pool.query(`update crm_lead_ficha set origem = 'gestor_17h10', lida_em = '2026-11-14T20:10:00Z' where lead_id = $1`, [
      lead,
    ]);
    const { rows } = await pool.query(
      `select origem from crm_lead_ficha_historico where lead_id = $1 order by lida_em`,
      [lead],
    );
    expect(rows.map((r) => r.origem)).toEqual(["leitor_do_crm", "leitor_0530"]);
  });

  it("10. uma rodada do Claude por organização e dia", async () => {
    await pool.query(`insert into leitor_rodadas (organization_id, dia, origem) values ($1, '2026-11-14', 'claude')`, [ORG]);
    await expect(
      pool.query(`insert into leitor_rodadas (organization_id, dia, origem) values ($1, '2026-11-14', 'claude')`, [ORG]),
    ).rejects.toMatchObject({ code: "23505" });
    // A diária do mesmo dia não disputa a vaga da rodada do Claude.
    await pool.query(`insert into leitor_rodadas (organization_id, dia) values ($1, '2026-11-14')`, [ORG]);
    await pool.query(`insert into leitor_rodadas (organization_id, dia, origem) values ($1, '2026-11-14', 'claude')`, [OUTRA]);
  });
});
