import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * 9014 — CHAVES DA AGÊNCIA, contra o Postgres do baseline.
 *
 * Uma chave com escopo `agencia:*` alcança TODAS as organizações pelas portas
 * `/api/mcp/agencia*`. O perigo é o admin de um escritório gravar esse escopo
 * numa chave da própria org e ler os outros escritórios. Este arquivo prova que
 * o gatilho `trg_api_tokens_guarda_da_agencia` só deixa a chave nascer certa —
 * e que a chave comum segue exatamente como era.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

const ORG = "9014aaaa-0000-4000-8000-000000000001";
const DONO = "9014aaaa-0000-4000-8000-0000000000d0";
const ADMIN_DA_ORG = "9014aaaa-0000-4000-8000-0000000000a1";
const SUPORTE = "9014aaaa-0000-4000-8000-000000000051";

let seq = 0;
const IPS = "{160.79.104.0/21}";

async function inserir(opcoes: {
  criadaPor?: string;
  nome?: string;
  scopes?: unknown;
  ips?: string | null;
}): Promise<string> {
  seq += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into api_tokens (organization_id, created_by, name, prefix, token_hash, scopes, ips_permitidos)
     values ($1, $2, $3, $4, $5::bytea, $6::jsonb, $7::cidr[]) returning id`,
    [
      ORG,
      opcoes.criadaPor ?? DONO,
      opcoes.nome ?? "gestor-leitura",
      `dsk_9014${String(seq).padStart(4, "0")}`,
      `\\x${String(seq).padStart(64, "0")}`,
      JSON.stringify(opcoes.scopes ?? ["agencia:leitura"]),
      opcoes.ips === undefined ? IPS : opcoes.ips,
    ],
  );
  return rows[0]!.id;
}

async function revogarTudo(): Promise<void> {
  await pool.query(`update api_tokens set revoked_at = now() where organization_id = $1 and revoked_at is null`, [ORG]);
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, 'agencia-9014', 'A9014', 'A9014')`,
    [ORG],
  );
  for (const [id, email] of [
    [DONO, "dono-9014@invariant.test"],
    [ADMIN_DA_ORG, "admin-9014@invariant.test"],
    [SUPORTE, "suporte-9014@invariant.test"],
  ] as const) {
    await pool.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
  }
  await pool.query(
    `insert into platform_admins (user_id, granted_by, scope, mfa_required, reason) values ($1, $1, 'full', false, '9014')`,
    [DONO],
  );
  await pool.query(
    `insert into platform_admins (user_id, granted_by, scope, mfa_required, reason) values ($1, $2, 'support_readonly', false, '9014')`,
    [SUPORTE, DONO],
  );
});

afterAll(async () => {
  await pool.query(`delete from api_tokens where organization_id = $1`, [ORG]);
  await pool.query(`delete from platform_admins where user_id in ($1, $2)`, [DONO, SUPORTE]);
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.query(`delete from auth.users where id in ($1, $2, $3)`, [DONO, ADMIN_DA_ORG, SUPORTE]);
  await pool.end();
});

describe("9014 — a chave da agência só nasce certa", () => {
  it("o dono da instalação (platform admin full) cria a chave de Leitura", async () => {
    await revogarTudo();
    const id = await inserir({});
    const { rows } = await pool.query(`select ips_permitidos::text[] as ips from api_tokens where id = $1`, [id]);
    expect(rows[0].ips).toEqual(["160.79.104.0/21"]);
  });

  it("o admin de um escritório NÃO cria (é o vazamento entre escritórios)", async () => {
    await revogarTudo();
    await expect(inserir({ criadaPor: ADMIN_DA_ORG })).rejects.toThrow(/dono da instalação/);
  });

  it("o platform admin só de leitura (suporte) NÃO cria", async () => {
    await revogarTudo();
    await expect(inserir({ criadaPor: SUPORTE })).rejects.toThrow(/dono da instalação/);
  });

  it("o dono revogado NÃO cria", async () => {
    await revogarTudo();
    await pool.query(`update platform_admins set revoked_at = now() where user_id = $1`, [DONO]);
    try {
      await expect(inserir({})).rejects.toThrow(/dono da instalação/);
    } finally {
      await pool.query(`update platform_admins set revoked_at = null where user_id = $1`, [DONO]);
    }
  });

  it("sem lista de IPs, ou com lista vazia, NÃO cria", async () => {
    await revogarTudo();
    await expect(inserir({ ips: null })).rejects.toThrow(/IPs permitidos/);
    await expect(inserir({ ips: "{}" })).rejects.toThrow(/IPs permitidos/);
  });

  it("escopo da agência junto com outro escopo NÃO cria (nem mcp:write, nem role)", async () => {
    await revogarTudo();
    await expect(inserir({ scopes: ["agencia:leitura", "mcp:write"] })).rejects.toThrow(/exatamente um escopo/);
    await expect(inserir({ scopes: ["agencia:leitura", "agencia:admin"] })).rejects.toThrow(/exatamente um escopo/);
  });

  it("escopo agencia:* desconhecido e nome trocado NÃO criam", async () => {
    await revogarTudo();
    await expect(inserir({ scopes: ["agencia:tudo"] })).rejects.toThrow(/desconhecido/);
    await expect(inserir({ nome: "operador-admin" })).rejects.toThrow(/nome fixo/);
    await expect(inserir({ scopes: ["agencia:admin"], nome: "gestor-leitura" })).rejects.toThrow(/nome fixo/);
  });

  it("uma chave VIVA por porta; depois de revogar, cria outra", async () => {
    await revogarTudo();
    await inserir({});
    await expect(inserir({})).rejects.toMatchObject({ code: "23505" });
    await revogarTudo();
    await expect(inserir({})).resolves.toBeTruthy();
    // A outra porta não disputa a vaga da primeira.
    await expect(inserir({ scopes: ["agencia:admin"], nome: "operador-admin" })).resolves.toBeTruthy();
  });
});

describe("9014 — depois de criada, a chave da agência é imutável", () => {
  it("não troca escopo, IPs, nome nem organização; revogar pode; revogada não volta", async () => {
    await revogarTudo();
    const id = await inserir({});
    await expect(
      pool.query(`update api_tokens set ips_permitidos = '{0.0.0.0/0}' where id = $1`, [id]),
    ).rejects.toThrow(/não pode ser alterada/);
    await expect(
      pool.query(`update api_tokens set scopes = '["agencia:admin"]' where id = $1`, [id]),
    ).rejects.toThrow(/não pode ser alterada/);
    await pool.query(`update api_tokens set last_used_at = now() where id = $1`, [id]);
    await pool.query(`update api_tokens set revoked_at = now(), revoked_by = $2 where id = $1`, [id, DONO]);
    await expect(pool.query(`update api_tokens set revoked_at = null where id = $1`, [id])).rejects.toThrow(
      /revogada não volta/,
    );
  });

  it("chave comum NÃO vira chave da agência por UPDATE", async () => {
    const id = await inserir({ scopes: ["mcp:read"], nome: "integracao", ips: null });
    await expect(
      pool.query(`update api_tokens set scopes = '["agencia:leitura"]' where id = $1`, [id]),
    ).rejects.toThrow(/não pode ser alterada/);
  });
});

describe("9014 — chave comum segue como era", () => {
  it("o admin do escritório cria chave comum sem IPs, e altera escopo dela", async () => {
    const id = await inserir({ criadaPor: ADMIN_DA_ORG, scopes: ["mcp:read"], nome: "minha", ips: null });
    await pool.query(`update api_tokens set scopes = '["mcp:read","mcp:write"]' where id = $1`, [id]);
    const { rows } = await pool.query(`select scopes from api_tokens where id = $1`, [id]);
    expect(rows[0].scopes).toEqual(["mcp:read", "mcp:write"]);
  });

  it("a função da guarda não é executável por anon nem authenticated", async () => {
    const { rows } = await pool.query<{ anon: boolean; auth: boolean }>(
      `select has_function_privilege('anon', 'public.fn_api_tokens_guarda_da_agencia()', 'execute') as anon,
              has_function_privilege('authenticated', 'public.fn_api_tokens_guarda_da_agencia()', 'execute') as auth`,
    );
    expect(rows[0]).toEqual({ anon: false, auth: false });
  });
});
