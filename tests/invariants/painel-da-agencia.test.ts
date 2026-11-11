import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * PC-028 (migration 9030) — o painel da agência, contra o Postgres do baseline.
 *
 *  - ⭐ só o dono da instalação: `anon` e `authenticated` (mesmo admin da
 *    organização) não leem nem escrevem `agencia_clientes`, `agencia_pagamentos`
 *    e `agencia_config`, e não executam as duas funções;
 *  - `fn_agencia_numeros` conta certo num cenário conhecido: leads do período
 *    (sem importado e teste), qualificados, passados para a equipe, ganhos,
 *    conversas e mensagens da IA, modelos por categoria (sem categoria = marketing;
 *    janela grátis do anúncio), custo de IA = a soma de `llm_calls` do período;
 *  - `fn_agencia_por_agente`: custo e contatos por agente;
 *  - a configuração nasce com uma linha.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "90300000-0000-4000-8000-00000000000a";
const ADMIN_DA_ORG = "90300000-1111-4000-8000-000000000001";
let funil = "";
let triagem = "";
let qualificado = "";
let sessao = "";
let agente = "";

const desde = new Date(Date.now() - 10 * 86_400_000).toISOString();
const ate = new Date(Date.now() + 60_000).toISOString();
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

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

async function contatoComConversa(nome: string, extraContato = "'{}'::jsonb", criadoHa = 48): Promise<{ contato: string; conversa: string }> {
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source_metadata, created_at) values ($1,$2, ${extraContato}, $3) returning id`,
    [ORG, nome, horasAtras(criadoHa)],
  );
  const { rows: v } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, status) values ($1,$2,$3,'open') returning id`,
    [ORG, c[0]!.id, sessao],
  );
  return { contato: c[0]!.id, conversa: v[0]!.id };
}

async function mensagem(alvo: { contato: string; conversa: string }, direcao: "inbound" | "outbound", h: number, extra: { via?: string; modelo?: string } = {}) {
  await pool.query(
    `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, template_name, created_at, sent_at)
     values ($1,$2,$3,$4,'text',$5,$6,$7,'nunca lido', $8, $9, $9)`,
    [ORG, alvo.conversa, sessao, alvo.contato, direcao, direcao === "inbound" ? "received" : "sent", extra.via ?? (direcao === "inbound" ? "external_device" : "crm"), extra.modelo ?? null, horasAtras(h)],
  );
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,'org-9030','org-9030','org-9030') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(`insert into auth.users (id, email) values ($1,'a9030@invariant.test') on conflict do nothing`, [ADMIN_DA_ORG]);
  await pool.query(`insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,'admin', now()) on conflict do nothing`, [ADMIN_DA_ORG, ORG]);
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position) values ($1,'Prev','prev-9030',100) returning id`,
    [ORG],
  );
  funil = p[0]!.id;
  const etapa = async (nome: string, pos: number, chance: number) =>
    (
      await pool.query<{ id: string }>(
        `insert into crm_stages (organization_id, pipeline_id, name, slug, position, win_probability) values ($1,$2,$3,$3,$4,$5) returning id`,
        [ORG, funil, `${nome}-9030`, pos, chance],
      )
    ).rows[0]!.id;
  triagem = await etapa("triagem", 1, 10);
  qualificado = await etapa("qualificado", 2, 70);
  sessao = (
    await pool.query<{ id: string }>(
      `insert into channel_sessions (organization_id, waha_session_name, webhook_secret_encrypted) values ($1,'sessao-9030','\\x00'::bytea) returning id`,
      [ORG],
    )
  ).rows[0]!.id;
  agente = (
    await pool.query<{ id: string }>(`insert into ai_agents (organization_id, name, system_prompt) values ($1,'Recepção 9030','p') returning id`, [ORG])
  ).rows[0]!.id;

  // Leads do período: 3 válidos (1 qualificado), 1 importado e 1 de teste fora.
  for (const [titulo, stage, source] of [
    ["Maria", triagem, "whatsapp"],
    ["Joana", qualificado, "whatsapp"],
    ["Carla", triagem, "meta_ads"],
    ["Importada", triagem, "importado_zernio"],
    ["Teste da equipe", triagem, "whatsapp"],
  ] as const) {
    await pool.query(
      `insert into crm_leads (organization_id, pipeline_id, stage_id, title, source, created_at) values ($1,$2,$3,$4,$5, now() - interval '2 days')`,
      [ORG, funil, stage, titulo, source],
    );
  }
  // Ganho no período.
  await pool.query(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title, status, closed_at, created_at) values ($1,$2,$3,'Fechou','won', now() - interval '1 day', now() - interval '30 days')`,
    [ORG, funil, qualificado],
  );

  // Conversas da IA: duas conversas, três mensagens da IA.
  const a = await contatoComConversa("Contato A");
  const b = await contatoComConversa("Contato B");
  await mensagem(a, "inbound", 40);
  await mensagem(a, "outbound", 39, { via: "ai" });
  await mensagem(a, "outbound", 38, { via: "ai" });
  await mensagem(b, "outbound", 20, { via: "ai" });
  // Modelos: um de utilidade, um sem categoria (= marketing), um na janela do anúncio (grátis).
  await pool.query(
    `insert into meta_templates (organization_id, waba_id, name, language, status, category, components, contract_hash)
     values ($1,'waba-9030','lembrete_9030','pt_BR','APPROVED','UTILITY','[]'::jsonb,'h')`,
    [ORG],
  );
  await mensagem(a, "outbound", 10, { modelo: "lembrete_9030" });
  await mensagem(b, "outbound", 10, { modelo: "sem_categoria_9030" });
  const doAnuncio = await contatoComConversa("Contato do anúncio", `'{"ad_id":"123"}'::jsonb`, 24);
  await mensagem(doAnuncio, "outbound", 5, { modelo: "sem_categoria_9030" });

  // Custo de IA: 120 + 80 no período (agente), 50 fora de agente; 999 fora do período.
  for (const [custo, h, comAgente] of [
    [120, 30, true],
    [80, 20, true],
    [50, 10, false],
    [999, 24 * 20, true],
  ] as const) {
    await pool.query(
      `insert into llm_calls (organization_id, contact_id, provider, model, cost_cents, agent_id, created_at) values ($1,$2,'anthropic','x',$3,$4,$5)`,
      [ORG, a.contato, custo, comAgente ? agente : null, horasAtras(h)],
    );
  }
  // Passagem para a equipe no período.
  await pool.query(
    `insert into passagens_de_atendimento (organization_id, contact_id, conversation_id, motor, origem, motivo_codigo, body)
     values ($1, $2, $3, 'crm', 'pedido_explicito', 'requested_human', 'resumo')`,
    [ORG, a.contato, a.conversa],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("o painel da agência (9030)", () => {
  it("⭐ só o service_role: anon e o admin da organização não leem, não escrevem nem executam", async () => {
    // Controle positivo: as linhas DA PRÓPRIA organização existem — a recusa
    // não é "tabela vazia", é falta de acesso.
    await pool.query(`insert into agencia_clientes (organization_id, plano) values ($1,'Controle') on conflict (organization_id) do nothing`, [ORG]);
    await pool.query(`insert into agencia_pagamentos (organization_id, tipo, pago_em, valor_cents, forma) values ($1,'outro',current_date,100,'pix')`, [ORG]);
    const { rows: existe } = await pool.query<{ n: number }>(
      `select (select count(*) from agencia_clientes where organization_id = $1)::int + (select count(*) from agencia_pagamentos where organization_id = $1)::int as n`,
      [ORG],
    );
    expect(existe[0]!.n).toBeGreaterThanOrEqual(2);
    for (const papel of ["anon", "authenticated"] as const) {
      for (const tabela of ["agencia_clientes", "agencia_pagamentos", "agencia_config"]) {
        await expect(como(papel, `select * from ${tabela}`)).rejects.toThrow(/permission denied/);
        await expect(como(papel, `delete from ${tabela}`)).rejects.toThrow(/permission denied/);
      }
      await expect(como(papel, `insert into agencia_clientes (organization_id, plano) values ('${ORG}','x')`)).rejects.toThrow(/permission denied/);
      await expect(como(papel, `update agencia_clientes set plano = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(
        como(papel, `insert into agencia_pagamentos (organization_id, tipo, pago_em, valor_cents, forma) values ('${ORG}','outro',current_date,1,'pix')`),
      ).rejects.toThrow(/permission denied/);
      await expect(como(papel, `update agencia_config set cotacao_usd_brl = 1`)).rejects.toThrow(/permission denied/);
      await expect(como(papel, `select * from fn_agencia_numeros(now() - interval '1 day', now())`)).rejects.toThrow(/permission denied/);
      await expect(como(papel, `select * from fn_agencia_por_agente(now() - interval '1 day', now())`)).rejects.toThrow(/permission denied/);
    }
  });

  it("a configuração nasce com uma linha e os padrões", async () => {
    const { rows } = await pool.query(`select cotacao_usd_brl, alerta_custo_pct, precos_whatsapp from agencia_config`);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].alerta_custo_pct)).toBe(15);
    expect(rows[0].precos_whatsapp).toMatchObject({ marketing: 35 });
  });

  it("os números da organização num cenário conhecido", async () => {
    const { rows } = await pool.query(`select * from fn_agencia_numeros($1, $2) where organization_id = $3`, [desde, ate, ORG]);
    const n = rows[0]!;
    expect(n.leads_recebidos).toBe(3);
    expect(n.qualificados).toBe(1);
    expect(n.ganhos).toBe(1);
    expect(n.passados_para_equipe).toBe(1);
    expect(n.conversas_ia).toBe(2);
    expect(n.mensagens_ia).toBe(3);
    expect(n.modelos_utilidade).toBe(1);
    expect(n.modelos_marketing).toBe(1);
    expect(n.modelos_gratis_anuncio).toBe(1);
    expect(Number(n.ia_custo_usd_cents)).toBe(250);
    expect(n.ultima_conversa_nova_em).not.toBeNull();
  });

  it("custo e contatos por agente", async () => {
    const { rows } = await pool.query(
      `select agent_id, custo_usd_cents::numeric as custo, contatos from fn_agencia_por_agente($1, $2) where organization_id = $3 order by custo desc`,
      [desde, ate, ORG],
    );
    expect(rows.map((r) => [r.agent_id, Number(r.custo), r.contatos])).toEqual([
      [agente, 200, 1],
      [null, 50, 1],
    ]);
  });
});
