import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * PC-026 (migration 9028), contra o Postgres do baseline:
 *
 *  - ⭐ o nome confirmado pela IA vira o título (origem `ia`, linha do tempo
 *    "Título: … (nome confirmado pela IA)");
 *  - ⭐ a equipe edita o título → origem `pessoa`, e a IA não troca mais;
 *  - a correção da IA ("na verdade é Mariana") troca título de origem `ia`;
 *  - a lista "Perguntas do resumo" do agente tem teto de 15;
 *  - a função do gatilho não é RPC.
 *
 * O código que decide roda de verdade (`aplicarNomeConfirmado`, sobre o pool).
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});

const ORG = randomUUID();
let contato = "";
let lead = "";

beforeAll(async () => {
  await pool.query(`insert into organizations (id, slug, legal_name, display_name) values ($1::uuid, $1::text, 'PC026', 'PC026')`, [
    ORG,
  ]);
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug) values ($1, 'Funil', 'funil-9028') returning id`,
    [ORG],
  );
  const { rows: s } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position) values ($1, $2, 'Novo', 'novo-9028', 1) returning id`,
    [ORG, p[0]!.id],
  );
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name, display_name, phone_number) values ($1, null, 'Mãe ❤️', '+5531998761234') returning id`,
    [ORG],
  );
  contato = c[0]!.id;
  const { rows: l } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title) values ($1, $2, $3, $4, '+55 31 99876-1234') returning id`,
    [ORG, p[0]!.id, s[0]!.id, contato],
  );
  lead = l[0]!.id;
});

afterAll(async () => {
  await pool.query(`delete from organizations where id = $1`, [ORG]);
  await pool.end();
});

async function tituloEOrigem() {
  const { rows } = await pool.query<{ title: string; titulo_origem: string | null }>(
    `select title, titulo_origem from crm_leads where id = $1`,
    [lead],
  );
  return rows[0]!;
}

describe("PC-026 — o título é o nome de quem conversa", () => {
  it("⭐ o nome confirmado pela IA vira o título, com a linha na linha do tempo", async () => {
    const { aplicarNomeConfirmado } = await import("@/lib/leads/titulo-confirmado");
    const r = await aplicarNomeConfirmado(pool, {
      organizationId: ORG,
      contactId: contato,
      nome: "carla de souza",
      agentId: null,
      fonte: "confirmar_nome",
    });
    expect(r).toMatchObject({ status: "atualizado", titulo: "Carla de Souza" });
    expect(await tituloEOrigem()).toEqual({ title: "Carla de Souza", titulo_origem: "ia" });
    const { rows } = await pool.query(
      `select reason from crm_lead_activities where lead_id = $1 and source_module = 'titulo_confirmado'`,
      [lead],
    );
    expect(rows).toEqual([{ reason: "Título: Carla de Souza (nome confirmado pela IA)" }]);
  });

  it("a correção da IA troca o título que ela mesma deu", async () => {
    const { aplicarNomeConfirmado } = await import("@/lib/leads/titulo-confirmado");
    const r = await aplicarNomeConfirmado(pool, {
      organizationId: ORG,
      contactId: contato,
      nome: "Carla Souza Lima",
      agentId: null,
      fonte: "confirmar_nome",
    });
    expect(r.status).toBe("atualizado");
    expect(await tituloEOrigem()).toEqual({ title: "Carla Souza Lima", titulo_origem: "ia" });
  });

  it("⭐ a equipe edita o título → origem pessoa, e a IA não troca mais", async () => {
    // Um UPDATE comum, como a tela/API faz (sem declarar origem).
    await pool.query(`update crm_leads set title = 'Carla - BPC filha' where id = $1`, [lead]);
    expect(await tituloEOrigem()).toEqual({ title: "Carla - BPC filha", titulo_origem: "pessoa" });
    const { aplicarNomeConfirmado } = await import("@/lib/leads/titulo-confirmado");
    const r = await aplicarNomeConfirmado(pool, {
      organizationId: ORG,
      contactId: contato,
      nome: "Ana",
      agentId: null,
      fonte: "cartao_de_passagem",
    });
    expect(r.status).toBe("protegido");
    expect(await tituloEOrigem()).toEqual({ title: "Carla - BPC filha", titulo_origem: "pessoa" });
  });

  it("mudar outra coisa do negócio não mexe na origem do título", async () => {
    await pool.query(`update crm_leads set description = 'nota da equipe' where id = $1`, [lead]);
    expect((await tituloEOrigem()).titulo_origem).toBe("pessoa");
  });
});

describe("PC-026 — o schema", () => {
  it("as perguntas do resumo têm teto de 15", async () => {
    const r = await pool
      .query(
        `select cardinality($1::text[]) <= 15 as cabe,
                (select count(*)::int from pg_constraint where conname = 'ai_agent_versions_perguntas_do_resumo_check') as n`,
        [Array.from({ length: 16 }, (_, i) => `P${i}`)],
      );
    expect(r.rows[0]).toEqual({ cabe: false, n: 1 });
    const def = await pool.query(
      `select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'ai_agent_versions_perguntas_do_resumo_check'`,
    );
    expect(def.rows[0].d).toMatch(/cardinality\(perguntas_do_resumo\) <= 15/);
    const col = await pool.query(
      `select column_default from information_schema.columns where table_name = 'ai_agent_versions' and column_name = 'perguntas_do_resumo'`,
    );
    expect(col.rows[0].column_default).toMatch(/'\{\}'/);
  });

  it("⭐ versão PUBLICADA não muda as perguntas do resumo (mudança = versão nova)", async () => {
    const { rows: a } = await pool.query<{ id: string }>(
      `insert into ai_agents (organization_id, name, system_prompt) values ($1, 'Agente 9028', 's') returning id`,
      [ORG],
    );
    const { rows: v } = await pool.query<{ id: string }>(
      `insert into ai_agent_versions (organization_id, agent_id, version_number, system_prompt, provider, model, status, perguntas_do_resumo)
       values ($1, $2, 1, 's', 'anthropic', 'claude-sonnet-4-6', 'published', array['Já teve o bebê']) returning id`,
      [ORG, a[0]!.id],
    );
    const erro = await pool
      .query(`update ai_agent_versions set perguntas_do_resumo = array['Outra'] where id = $1`, [v[0]!.id])
      .then(() => null)
      .catch((e: { message?: string }) => e.message ?? "erro");
    expect(erro).toMatch(/imutável/);
    // Controle: um rascunho muda.
    const { rows: d } = await pool.query<{ id: string }>(
      `insert into ai_agent_versions (organization_id, agent_id, version_number, system_prompt, provider, model, status)
       values ($1, $2, 2, 's', 'anthropic', 'claude-sonnet-4-6', 'draft') returning id`,
      [ORG, a[0]!.id],
    );
    await expect(
      pool.query(`update ai_agent_versions set perguntas_do_resumo = array['Outra'] where id = $1`, [d[0]!.id]),
    ).resolves.toBeTruthy();
  });

  it("a função do gatilho não é RPC (fechada para anon e authenticated)", async () => {
    const r = await pool.query(
      `select has_function_privilege('anon', 'public.fn_crm_leads_titulo_origem()', 'execute') as anon,
              has_function_privilege('authenticated', 'public.fn_crm_leads_titulo_origem()', 'execute') as auth`,
    );
    expect(r.rows[0]).toEqual({ anon: false, auth: false });
  });
});
