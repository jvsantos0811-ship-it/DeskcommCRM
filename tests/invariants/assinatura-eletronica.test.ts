/**
 * ASSINATURA ELETRÔNICA INTEGRADA (PC-030, migration 9027).
 *
 * Contra o que o `baseline.sql` instala de verdade:
 *
 *   1. ⭐ `assinatura_eletronica_contas` guarda a chave da API do serviço:
 *      nenhum papel do PostgREST lê nem escreve (permission denied, não "zero
 *      linhas"), e não há policy que um dia a abra por engano;
 *   2. os CHECKs da conta recusam serviço fora da lista, ambiente desconhecido
 *      e prazo fora de 1–60 dias; a aprovação da equipe nasce DESLIGADA
 *      (decisão do João, 10/11/2026);
 *   3. ⭐ `contrato_modelos`: o membro da organização A lê o modelo de A e
 *      ZERO do de B (e o de B, o contrário); a sessão não escreve — criar,
 *      mudar e aprovar são do servidor; `anon` não lê nada;
 *   4. a aprovação é inteira ou não é: data sem nome (ou nome sem data) é
 *      recusada;
 *   5. ⭐ `crm_contracts` aceita o modelo só da MESMA organização (o servidor
 *      escreve com service_role, que ignora RLS) — controle positivo com o
 *      modelo da própria;
 *   6. os vocabulários cresceram sem perder o antigo: `expirado`, `zapsign` e
 *      `origem_envio` (`pessoa`/`ia`), e o resto continua recusado;
 *   7. a função nova da trava fechada para `anon` e `authenticated`.
 *
 * Roda contra Postgres real via `pnpm test:db` (não roda no `test:unit`).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_VIEWER, countAs, seedGov, sql, writeCountAs } from "./gov-helpers";

const ORG_B = "dddddddd-9027-4000-8000-000000000001";
const USER_B = "dddddddd-9027-4000-8000-000000000002";
const MODELO_A = "eeeeeeee-9027-4000-8000-000000000011";
const MODELO_B = "eeeeeeee-9027-4000-8000-000000000012";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});

async function codigoDoErro(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "erro";
  }
}

/** Roda uma consulta como `anon` ou `authenticated` e devolve o código do erro (ou null). */
async function erroComo(papel: "anon" | "authenticated", consulta: string): Promise<string | null> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${papel}`);
    await c.query(consulta);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "erro";
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

beforeAll(async () => {
  seedGov();
  sql(`
    insert into auth.users (id, email)
      values ('${USER_B}', 'pc030-org-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'inv-pc030-b', 'PC-030 Org B', 'PC-030 B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USER_B}', '${ORG_B}', 'admin', now())
      on conflict do nothing;
    delete from public.crm_contracts where modelo_id in ('${MODELO_A}', '${MODELO_B}');
    delete from public.contrato_modelos where id in ('${MODELO_A}', '${MODELO_B}');
    delete from public.assinatura_eletronica_contas where organization_id in ('${GOV_ORG}', '${ORG_B}');
    insert into public.contrato_modelos (id, organization_id, nome, corpo)
      values ('${MODELO_A}', '${GOV_ORG}', 'BPC/LOAS', 'Contrato de prestação de serviços de {{nome_completo}}.'),
             ('${MODELO_B}', '${ORG_B}', 'BPC/LOAS', 'Contrato de prestação de serviços de {{nome_completo}}.');
  `);
});

afterAll(async () => {
  sql(`
    delete from public.crm_contracts where modelo_id in ('${MODELO_A}', '${MODELO_B}');
    delete from public.contrato_modelos where id in ('${MODELO_A}', '${MODELO_B}');
    delete from public.assinatura_eletronica_contas where organization_id in ('${GOV_ORG}', '${ORG_B}');
  `);
  await pool.end();
});

describe("assinatura eletrônica — o que o baseline instala (9027)", () => {
  it("⭐ a conta (com a chave do serviço) é só do servidor: nenhum grant, nenhuma policy, RLS ligada", async () => {
    const grants = await pool.query(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'assinatura_eletronica_contas'
          and grantee in ('anon', 'authenticated', 'PUBLIC')`,
    );
    expect(grants.rows).toEqual([]);
    const policies = await pool.query(
      `select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = 'assinatura_eletronica_contas'`,
    );
    expect(policies.rows[0].n).toBe(0);
    const rls = await pool.query(`select relrowsecurity from pg_class where oid = 'public.assinatura_eletronica_contas'::regclass`);
    expect(rls.rows[0].relrowsecurity).toBe(true);

    // Recusa de verdade, pelo papel — não "zero linhas" que uma policy nova mudaria.
    await pool.query(
      `insert into assinatura_eletronica_contas (organization_id, provedor, chave_last4) values ($1, 'zapsign', '1234')`,
      [GOV_ORG],
    );
    expect(await erroComo("authenticated", "select * from public.assinatura_eletronica_contas")).toBe("42501");
    expect(await erroComo("anon", "select * from public.assinatura_eletronica_contas")).toBe("42501");
    // Controle positivo: a linha existe (o superusuário a vê).
    expect(sql(`select count(*) from public.assinatura_eletronica_contas where organization_id = '${GOV_ORG}';`).trim()).toBe("1");
  });

  it("os CHECKs da conta recusam serviço, ambiente e prazo fora do lugar; a aprovação nasce desligada", async () => {
    for (const [coluna, valor] of [
      ["provedor", "clicksign"],
      ["ambiente", "homologacao"],
      ["prazo_para_assinar_dias", 0],
      ["prazo_para_assinar_dias", 61],
    ] as const) {
      const erro = await codigoDoErro(() =>
        pool.query(
          `insert into assinatura_eletronica_contas (organization_id, provedor, ${coluna === "provedor" ? "ambiente" : coluna})
           values ($1, ${coluna === "provedor" ? "$2, 'teste'" : "'zapsign', $2"})`,
          [ORG_B, valor],
        ),
      );
      expect(erro, `${coluna}=${valor}`).toBe("23514");
    }
    const r = await pool.query(
      `insert into assinatura_eletronica_contas (organization_id, provedor) values ($1, 'zapsign')
       returning aprovacao_da_equipe, prazo_para_assinar_dias, ambiente`,
      [ORG_B],
    );
    expect(r.rows[0]).toEqual({ aprovacao_da_equipe: false, prazo_para_assinar_dias: 7, ambiente: "producao" });
  });

  it("o caminho do aviso do serviço é único entre organizações (o token do caminho decide a organização)", async () => {
    await pool.query(
      `update assinatura_eletronica_contas set aviso_path_token = 'caminho-9027-unico-aaaaaaaa' where organization_id = $1`,
      [GOV_ORG],
    );
    expect(
      await codigoDoErro(() =>
        pool.query(
          `update assinatura_eletronica_contas set aviso_path_token = 'caminho-9027-unico-aaaaaaaa' where organization_id = $1`,
          [ORG_B],
        ),
      ),
    ).toBe("23505");
  });

  it("⭐ modelos: cada organização lê só os seus (controle positivo + isolamento nos dois sentidos)", () => {
    expect(countAs(GOV_VIEWER, `select count(*) from public.contrato_modelos where id = '${MODELO_A}';`)).toBe(1);
    expect(countAs(GOV_VIEWER, `select count(*) from public.contrato_modelos where id = '${MODELO_B}';`)).toBe(0);
    expect(countAs(USER_B, `select count(*) from public.contrato_modelos where id = '${MODELO_B}';`)).toBe(1);
    expect(countAs(USER_B, `select count(*) from public.contrato_modelos where id = '${MODELO_A}';`)).toBe(0);
  });

  it("⭐ modelos: a sessão não escreve (criar, mudar e aprovar são do servidor); anon não lê", async () => {
    const grants = sql(`
      select coalesce(string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type), '')
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'contrato_modelos'
         and grantee in ('anon', 'authenticated', 'PUBLIC');
    `).trim();
    expect(grants).toBe("authenticated:SELECT");
    expect(await erroComo("anon", "select * from public.contrato_modelos")).toBe("42501");
    expect(
      await erroComo("authenticated", `insert into public.contrato_modelos (organization_id, nome, corpo) values ('${ORG_B}', 'x', 'texto')`),
    ).toBe("42501");
    // A escrita pela sessão é recusada pelo papel; nenhuma linha muda.
    expect(() =>
      writeCountAs(USER_B, `update public.contrato_modelos set aprovado_em = now(), aprovado_por_nome = 'Dr. Fulano' where id = '${MODELO_B}'`),
    ).toThrow(/permission denied/);
    expect(sql(`select count(*) from public.contrato_modelos where id = '${MODELO_B}' and aprovado_em is null;`).trim()).toBe("1");
  });

  it("a aprovação é inteira: data sem nome, ou nome sem data, é recusada", async () => {
    expect(
      await codigoDoErro(() => pool.query(`update contrato_modelos set aprovado_em = now() where id = $1`, [MODELO_A])),
    ).toBe("23514");
    expect(
      await codigoDoErro(() =>
        pool.query(`update contrato_modelos set aprovado_por_nome = 'Dra. Ana' where id = $1`, [MODELO_A]),
      ),
    ).toBe("23514");
    await expect(
      pool.query(`update contrato_modelos set aprovado_em = now(), aprovado_por_nome = 'Dra. Ana' where id = $1`, [MODELO_A]),
    ).resolves.toBeTruthy();
  });

  it("⭐ o contrato aceita o modelo só da MESMA organização", async () => {
    const erro = await pool
      .query(`insert into crm_contracts (organization_id, titulo, modelo_id) values ($1, 'x', $2)`, [GOV_ORG, MODELO_B])
      .then(() => null)
      .catch((e: { code?: string; message?: string }) => `${e.code}:${e.message}`);
    expect(erro).toBe("23514:crm_contract_modelo_org_mismatch");

    // Trocar o modelo de um contrato existente pelo do vizinho também é recusado.
    const id = randomUUID();
    await pool.query(`insert into crm_contracts (id, organization_id, titulo, modelo_id, modelo_versao) values ($1, $2, 'x', $3, 1)`, [
      id,
      GOV_ORG,
      MODELO_A,
    ]);
    expect(
      await codigoDoErro(() => pool.query(`update crm_contracts set modelo_id = $2 where id = $1`, [id, MODELO_B])),
    ).toBe("23514");
  });

  it("os vocabulários cresceram sem perder o antigo, e o resto continua recusado", async () => {
    const ok = async (campos: string, valores: string) =>
      pool.query(`insert into crm_contracts (organization_id, titulo, ${campos}) values ($1, 'x', ${valores})`, [GOV_ORG]);
    await expect(ok("status", "'expirado'")).resolves.toBeTruthy();
    await expect(ok("provedor_assinatura", "'zapsign'")).resolves.toBeTruthy();
    await expect(ok("origem_envio", "'ia'")).resolves.toBeTruthy();
    expect(await codigoDoErro(() => ok("status", "'aprovado'"))).toBe("23514");
    expect(await codigoDoErro(() => ok("provedor_assinatura", "'clicksign'"))).toBe("23514");
    expect(await codigoDoErro(() => ok("origem_envio", "'robo'"))).toBe("23514");
    const padrao = await pool.query(
      `insert into crm_contracts (organization_id, titulo) values ($1, 'x') returning origem_envio, provedor_assinatura, status`,
      [GOV_ORG],
    );
    expect(padrao.rows[0]).toEqual({ origem_envio: "pessoa", provedor_assinatura: "manual", status: "rascunho" });
  });

  it("a função da trava não é RPC: fechada para anon e authenticated", async () => {
    const r = await pool.query(
      `select has_function_privilege('anon', 'public.fn_crm_contracts_modelo_da_org()', 'execute') as anon,
              has_function_privilege('authenticated', 'public.fn_crm_contracts_modelo_da_org()', 'execute') as auth`,
    );
    expect(r.rows[0]).toEqual({ anon: false, auth: false });
  });

  it("apagar o modelo não apaga o contrato que ele gerou (o documento sobrevive)", async () => {
    const modelo = randomUUID();
    const contrato = randomUUID();
    await pool.query(`insert into contrato_modelos (id, organization_id, nome, corpo) values ($1, $2, 'Temporário', 'texto do contrato')`, [
      modelo,
      GOV_ORG,
    ]);
    await pool.query(`insert into crm_contracts (id, organization_id, titulo, modelo_id, modelo_versao) values ($1, $2, 'x', $3, 1)`, [
      contrato,
      GOV_ORG,
      modelo,
    ]);
    await pool.query(`delete from contrato_modelos where id = $1`, [modelo]);
    const r = await pool.query(`select modelo_id, modelo_versao from crm_contracts where id = $1`, [contrato]);
    expect(r.rows[0]).toEqual({ modelo_id: null, modelo_versao: 1 });
  });
});
