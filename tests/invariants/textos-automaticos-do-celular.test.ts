import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * PM-027 §6 (migration 9024) — `fn_textos_automaticos_do_celular`, contra o
 * Postgres do baseline.
 *
 * O que só o banco garante:
 *   1. conta, por texto, as conversas, as vezes e as vezes até 60 s depois da
 *      mensagem do lead — com o texto normalizado (espaços e maiúsculas);
 *   2. só a organização pedida: a saudação de outra organização não soma;
 *   3. só textos em 3+ conversas, só saídas do celular, só dentro da janela;
 *   4. ninguém pela anon key nem logado executa (só o service_role).
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Tirar o filtro de organização: a saudação da OUTRA soma e o caso 2 acusa.
 * - Medir contra a mensagem anterior qualquer (e não a do lead): o caso 1 acusa.
 * - Deixar `authenticated` executar: o caso 4 acusa.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "90240000-0000-4000-8000-00000000000a";
const OUTRA = "90240000-0000-4000-8000-00000000000b";
const SAUDACAO = "Olá! Sou do escritório. Como posso te chamar?";
const BASE = new Date("2026-11-02T13:00:00Z").getTime();
const em = (seg: number) => new Date(BASE + seg * 1000).toISOString();

async function org(id: string, slug: string): Promise<{ sessao: string }> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,$2::text,$2::text,$2::text) on conflict (id) do nothing`,
    [id, slug],
  );
  const sessao = (
    await pool.query<{ id: string }>(
      `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1, gen_random_uuid()::text, 'WORKING', decode('00','hex')) returning id`,
      [id],
    )
  ).rows[0]!.id;
  return { sessao };
}

/** Uma conversa: o lead escreve em `lead`, o celular responde `texto` em `resposta` (segundos). */
async function conversa(orgId: string, sessao: string, falas: Array<{ dir: "inbound" | "outbound"; via: string; seg: number; body: string }>) {
  const contato = (
    await pool.query<{ id: string }>(`insert into contacts (organization_id, display_name) values ($1,'Lead 9024') returning id`, [orgId])
  ).rows[0]!.id;
  const conv = (
    await pool.query<{ id: string }>(
      `insert into conversations (organization_id, contact_id, channel_session_id) values ($1,$2,$3) returning id`,
      [orgId, contato, sessao],
    )
  ).rows[0]!.id;
  for (const f of falas) {
    await pool.query(
      `insert into messages (organization_id, contact_id, conversation_id, channel_session_id, direction, type, status, sent_via, body, sent_at, created_at)
       values ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9,$9)`,
      [orgId, contato, conv, sessao, f.dir, f.dir === "inbound" ? "received" : "sent", f.via, f.body, em(f.seg)],
    );
  }
}

async function contar(orgId: string): Promise<Map<string, { conversas: number; vezes: number; no_prazo: number }>> {
  const { rows } = await pool.query<{ texto: string; conversas: number; vezes: number; no_prazo: number }>(
    `select * from public.fn_textos_automaticos_do_celular($1, $2::timestamptz, 60, 3)`,
    [orgId, new Date(BASE - 3_600_000).toISOString()],
  );
  return new Map(rows.map((r) => [r.texto, { conversas: r.conversas, vezes: r.vezes, no_prazo: r.no_prazo }]));
}

describe("migration 9024 — os textos automáticos do celular", () => {
  beforeAll(async () => {
    const a = await org(ORG, "org-9024-a");
    const b = await org(OUTRA, "org-9024-b");
    const lead = (seg: number) => ({ dir: "inbound" as const, via: "external_device", seg, body: "oi" });
    const cel = (seg: number, body: string) => ({ dir: "outbound" as const, via: "external_device", seg, body });
    // A saudação em 5 conversas: 4 na hora, 1 atrasada (502 s). Uma com espaços e maiúsculas diferentes.
    await conversa(ORG, a.sessao, [lead(0), cel(3, SAUDACAO)]);
    await conversa(ORG, a.sessao, [lead(100), cel(104, SAUDACAO)]);
    await conversa(ORG, a.sessao, [lead(200), cel(205, `  ${SAUDACAO.toUpperCase()} `)]);
    await conversa(ORG, a.sessao, [lead(300), cel(302, SAUDACAO)]);
    // Atrasada: a IA respondeu no meio, mas o prazo conta da mensagem do LEAD.
    await conversa(ORG, a.sessao, [lead(400), { dir: "outbound", via: "ai", seg: 880, body: "resposta da IA" }, cel(902, SAUDACAO)]);
    // "Ok" de pessoa em 3 conversas: 1 na hora, 2 depois de minutos.
    await conversa(ORG, a.sessao, [lead(1000), cel(1020, "Ok")]);
    await conversa(ORG, a.sessao, [lead(1100), cel(1400, "Ok")]);
    await conversa(ORG, a.sessao, [lead(1200), cel(1500, "Ok")]);
    // Em só 2 conversas: não volta.
    await conversa(ORG, a.sessao, [lead(2000), cel(2001, "Texto em duas conversas")]);
    await conversa(ORG, a.sessao, [lead(2100), cel(2101, "Texto em duas conversas")]);
    // Pelo CRM (não é celular) em 3 conversas: não volta.
    for (const s of [3000, 3100, 3200]) {
      await conversa(ORG, a.sessao, [lead(s), { dir: "outbound", via: "user", seg: s + 2, body: "Mensagem pelo CRM igual" }]);
    }
    // A OUTRA organização manda a mesma saudação em 3 conversas.
    for (const s of [0, 100, 200]) await conversa(OUTRA, b.sessao, [lead(s), cel(s + 2, SAUDACAO)]);
    // Fora da janela (antes de p_desde): não conta.
    await conversa(ORG, a.sessao, [lead(-7200), cel(-7198, SAUDACAO)]);
  });

  afterAll(async () => {
    await pool.query(`delete from organizations where id = any($1::uuid[])`, [[ORG, OUTRA]]);
    await pool.end();
  });

  it("conta por texto normalizado, com o prazo medido da mensagem do lead", async () => {
    const r = await contar(ORG);
    expect(r.get(SAUDACAO.toLowerCase())).toEqual({ conversas: 5, vezes: 5, no_prazo: 4 });
    expect(r.get("ok")).toEqual({ conversas: 3, vezes: 3, no_prazo: 1 });
  });

  it("só a organização pedida: a saudação da outra não soma", async () => {
    expect((await contar(OUTRA)).get(SAUDACAO.toLowerCase())).toEqual({ conversas: 3, vezes: 3, no_prazo: 3 });
  });

  it("só texto do celular em 3+ conversas, dentro da janela", async () => {
    const r = await contar(ORG);
    expect(r.has("texto em duas conversas")).toBe(false);
    expect(r.has("mensagem pelo crm igual")).toBe(false);
    expect([...r.keys()].sort()).toEqual(["ok", SAUDACAO.toLowerCase()].sort());
  });

  it("anon e logado não executam; o service_role executa", async () => {
    const tentar = async (papel: string) => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query(`set local role ${papel}`);
        await c.query(`select * from public.fn_textos_automaticos_do_celular($1, now() - interval '90 days')`, [ORG]);
        return "executou";
      } catch (e) {
        return (e as { code?: string }).code ?? "erro";
      } finally {
        await c.query("rollback");
        c.release();
      }
    };
    expect(await tentar("anon")).toBe("42501");
    expect(await tentar("authenticated")).toBe("42501");
    expect(await tentar("service_role")).toBe("executou");
  });
});
