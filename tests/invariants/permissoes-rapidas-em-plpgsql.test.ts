import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Migration 9031 — as funções de permissão em PL/pgSQL e a Qualidade do lead
 * com dois caminhos, contra o Postgres do baseline.
 *
 * A correção é de VELOCIDADE; o que este arquivo guarda é que ela continue
 * instalada e que a regra de acesso não tenha mudado:
 *
 *  - ⭐ as três funções que a RLS chama a cada linha estão em PL/pgSQL (em SQL
 *    com SECURITY DEFINER o Postgres as replaneja por linha), e o invólucro de
 *    `fn_dados_qualidade_do_lead` também. Um `create or replace` posterior no
 *    baseline que as devolva a SQL — foi o que a reaplicação do baseline fez na
 *    produção em 11/11/2026 — reprova aqui;
 *  - a escada de quem vê (plataforma, papel, dono, modo de visibilidade) dá a
 *    mesma resposta de antes, caso a caso;
 *  - ⭐ `fn_dados_qualidade_do_lead_org_inteira` é SECURITY DEFINER e por isso
 *    carrega a pergunta de acesso no corpo: chamada direto por quem não vê a
 *    organização inteira, ou por quem é de outra, devolve zero linhas;
 *  - os dois caminhos devolvem as mesmas linhas para quem vê tudo.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "90310000-0000-4000-8000-00000000000a";
const OUTRA = "90310000-0000-4000-8000-00000000000b";
const GERENTE = "90310000-1111-4000-8000-000000000001";
const ATENDENTE = "90310000-1111-4000-8000-000000000002";
const OUTRO_ATENDENTE = "90310000-1111-4000-8000-000000000003";
const GERENTE_DA_OUTRA = "90310000-1111-4000-8000-000000000004";
const SEM_VINCULO = "90310000-1111-4000-8000-000000000005";

async function semearOrg(id: string, slug: string): Promise<{ pipeline: string; etapa: string }> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1,$2::text,$2::text,$2::text, jsonb_build_object('visibility_mode','own')) on conflict (id) do nothing`,
    [id, slug],
  );
  const { rows } = await pool.query<{ pipeline: string; etapa: string }>(
    `select p.id as pipeline, s.id as etapa
       from crm_pipelines p join crm_stages s on s.pipeline_id = p.id
      where p.organization_id = $1 and p.is_default and not s.is_won and not s.is_lost
      order by s.position limit 1`,
    [id],
  );
  return rows[0]!;
}

async function membro(org: string, user: string, papel: string): Promise<void> {
  await pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [user, `${user}@invariant.test`]);
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,$3, now()) on conflict do nothing`,
    [user, org, papel],
  );
}

async function negocio(org: string, f: { pipeline: string; etapa: string }, titulo: string, dono: string | null): Promise<string> {
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1,$2) returning id`,
    [org, `Contato ${titulo}`],
  );
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, status, owner_user_id, source)
     values ($1,$2,$3,$4,$5,'open',$6,'whatsapp') returning id`,
    [org, f.pipeline, f.etapa, c[0]!.id, titulo, dono],
  );
  return rows[0]!.id;
}

async function como<T extends Record<string, unknown>>(user: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(user === null ? "set local role anon" : "set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(user === null ? { role: "anon" } : { sub: user, role: "authenticated" }),
    ]);
    const { rows } = await c.query<T>(sql, params);
    return rows;
  } finally {
    await c.query("rollback");
    c.release();
  }
}

const L: Record<string, string> = {};

beforeAll(async () => {
  const f = await semearOrg(ORG, "org-9031-a");
  const g = await semearOrg(OUTRA, "org-9031-b");
  await membro(ORG, GERENTE, "manager");
  await membro(ORG, ATENDENTE, "agent");
  await membro(ORG, OUTRO_ATENDENTE, "agent");
  await membro(OUTRA, GERENTE_DA_OUTRA, "manager");
  await pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [SEM_VINCULO, `${SEM_VINCULO}@invariant.test`]);
  L.doAtendente = await negocio(ORG, f, "Do atendente", ATENDENTE);
  L.doOutro = await negocio(ORG, f, "Do outro atendente", OUTRO_ATENDENTE);
  L.semDono = await negocio(ORG, f, "Sem dono", null);
  L.daOutraOrg = await negocio(OUTRA, g, "Da outra organização", GERENTE_DA_OUTRA);
});

afterAll(async () => {
  await pool.end();
});

describe("9031 — as funções que a RLS chama por linha estão em PL/pgSQL", () => {
  it("as três de permissão e o invólucro da Qualidade do lead: plpgsql; as auxiliares existem", async () => {
    const { rows } = await pool.query<{ proname: string; lanname: string; prosecdef: boolean }>(
      `select p.proname, l.lanname, p.prosecdef
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_language l on l.oid = p.prolang
        where n.nspname = 'public'
          and p.proname in ('fn_user_role_in_org','fn_can_view_conversation','fn_can_view_lead',
                            'fn_dados_qualidade_do_lead','fn_dados_qualidade_do_lead_org_inteira',
                            'fn_dados_qualidade_do_lead_por_linha')
        order by 1`,
    );
    expect(rows).toEqual([
      { proname: "fn_can_view_conversation", lanname: "plpgsql", prosecdef: true },
      { proname: "fn_can_view_lead", lanname: "plpgsql", prosecdef: true },
      { proname: "fn_dados_qualidade_do_lead", lanname: "plpgsql", prosecdef: false },
      { proname: "fn_dados_qualidade_do_lead_org_inteira", lanname: "sql", prosecdef: true },
      { proname: "fn_dados_qualidade_do_lead_por_linha", lanname: "sql", prosecdef: false },
      { proname: "fn_user_role_in_org", lanname: "plpgsql", prosecdef: true },
    ]);
  });

  it("a auxiliar da organização inteira carrega a pergunta de acesso no corpo", async () => {
    const { rows } = await pool.query<{ def: string }>(
      `select pg_get_functiondef('public.fn_dados_qualidade_do_lead_org_inteira(uuid,uuid)'::regprocedure) as def`,
    );
    expect(rows[0]!.def).toContain("where l.organization_id = p_org and public.fn_dados_ve_a_org_inteira(p_org)");
  });
});

describe("9031 — a regra de acesso é a de antes", () => {
  it("o papel na organização: o de quem é membro, nulo para quem não é", async () => {
    const papel = async (user: string, org: string) =>
      (await como<{ r: string | null }>(user, `select public.fn_user_role_in_org($1) as r`, [org]))[0]!.r;
    expect(await papel(GERENTE, ORG)).toBe("manager");
    expect(await papel(ATENDENTE, ORG)).toBe("agent");
    expect(await papel(GERENTE, OUTRA)).toBeNull();
    expect(await papel(SEM_VINCULO, ORG)).toBeNull();
  });

  it.each([
    ["fn_can_view_lead"],
    ["fn_can_view_conversation"],
  ])("%s: gerente vê tudo; atendente segue o modo de visibilidade; de fora, nada", async (fn) => {
    const ve = async (user: string, org: string, dono: string | null) =>
      (await como<{ v: boolean }>(user, `select public.${fn}($1, $2) as v`, [org, dono]))[0]!.v;
    // Gerente: a organização inteira, e nada da outra.
    expect(await ve(GERENTE, ORG, OUTRO_ATENDENTE)).toBe(true);
    expect(await ve(GERENTE, ORG, null)).toBe(true);
    expect(await ve(GERENTE, OUTRA, null)).toBe(false);
    expect(await ve(SEM_VINCULO, ORG, null)).toBe(false);
    // Atendente em 'own': só o dele.
    expect(await ve(ATENDENTE, ORG, ATENDENTE)).toBe(true);
    expect(await ve(ATENDENTE, ORG, OUTRO_ATENDENTE)).toBe(false);
    expect(await ve(ATENDENTE, ORG, null)).toBe(false);
    // 'own_and_unassigned' (o padrão) e 'all', na mesma transação desfeita.
    const comModo = async (modo: string | null, dono: string | null) => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query(
          modo === null
            ? `update organizations set settings = settings - 'visibility_mode' where id = $1`
            : `update organizations set settings = jsonb_set(settings, '{visibility_mode}', to_jsonb($2::text)) where id = $1`,
          modo === null ? [ORG] : [ORG, modo],
        );
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ATENDENTE, role: "authenticated" })]);
        const { rows } = await c.query<{ v: boolean }>(`select public.${fn}($1, $2) as v`, [ORG, dono]);
        return rows[0]!.v;
      } finally {
        await c.query("rollback");
        c.release();
      }
    };
    expect(await comModo(null, null)).toBe(true);
    expect(await comModo(null, OUTRO_ATENDENTE)).toBe(false);
    expect(await comModo("all", OUTRO_ATENDENTE)).toBe(true);
  });

  it("a RLS do funil: o gerente lê os três negócios; o atendente, só o dele; ninguém lê a outra organização", async () => {
    const ids = async (user: string) =>
      (await como<{ id: string }>(user, `select id from crm_leads where organization_id in ($1, $2) order by title`, [ORG, OUTRA])).map((r) => r.id);
    expect((await ids(GERENTE)).sort()).toEqual([L.doAtendente, L.doOutro, L.semDono].sort());
    expect(await ids(ATENDENTE)).toEqual([L.doAtendente]);
    expect(await ids(SEM_VINCULO)).toEqual([]);
  });
});

describe("9031 — a Qualidade do lead pelos dois caminhos", () => {
  const leads = async (user: string, fn: string, org = ORG) =>
    (await como<{ lead_id: string }>(user, `select lead_id from public.${fn}($1, null)`, [org])).map((r) => r.lead_id).sort();

  it("quem vê a organização inteira recebe as mesmas linhas pelo invólucro, pelo caminho direto e pelo caminho por linha", async () => {
    const esperado = [L.doAtendente, L.doOutro, L.semDono].sort();
    expect(await leads(GERENTE, "fn_dados_qualidade_do_lead")).toEqual(esperado);
    expect(await leads(GERENTE, "fn_dados_qualidade_do_lead_org_inteira")).toEqual(esperado);
    expect(await leads(GERENTE, "fn_dados_qualidade_do_lead_por_linha")).toEqual(esperado);
    const linha = async (fn: string) =>
      JSON.stringify(await como(GERENTE, `select * from public.${fn}($1, null) order by lead_id`, [ORG]));
    expect(await linha("fn_dados_qualidade_do_lead_org_inteira")).toBe(await linha("fn_dados_qualidade_do_lead_por_linha"));
  });

  it("o atendente em 'só os seus' recebe só o dele pelo invólucro", async () => {
    expect(await leads(ATENDENTE, "fn_dados_qualidade_do_lead")).toEqual([L.doAtendente]);
  });

  it("⭐ o caminho direto (SECURITY DEFINER), chamado por quem não vê a organização inteira, devolve zero linhas", async () => {
    expect(await leads(ATENDENTE, "fn_dados_qualidade_do_lead_org_inteira")).toEqual([]);
    expect(await leads(GERENTE_DA_OUTRA, "fn_dados_qualidade_do_lead_org_inteira")).toEqual([]);
    expect(await leads(SEM_VINCULO, "fn_dados_qualidade_do_lead_org_inteira")).toEqual([]);
    expect(await leads(GERENTE_DA_OUTRA, "fn_dados_qualidade_do_lead")).toEqual([]);
  });

  it("anon não executa nenhuma das três", async () => {
    for (const fn of ["fn_dados_qualidade_do_lead", "fn_dados_qualidade_do_lead_org_inteira", "fn_dados_qualidade_do_lead_por_linha"]) {
      await expect(como(null, `select 1 from public.${fn}($1, null)`, [ORG])).rejects.toThrow(/permission denied/);
    }
  });
});
