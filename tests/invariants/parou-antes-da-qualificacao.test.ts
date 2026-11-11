import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { classificarParouAntes, type LinhaDoRitmo } from "@/lib/dados/parou-antes";

/**
 * PC-025 (migration 9029) — `fn_dados_ritmo_da_conversa`, contra o Postgres do
 * baseline, e a regra "parou antes da qualificação" em cima dela.
 *
 *  - ⭐ o cenário do aceite: 4 cards (só a 1ª mensagem; conversou e parou;
 *    chegou ao Qualificado; perdido) → a) = 1, b) = 1;
 *  - N de 24 para 72 h muda o resultado; etapa "fora desta medida" não entra;
 *  - "chegou ao marco" vale pela etapa atual OU pela linha do tempo (o card que
 *    passou pelo Qualificado e voltou para a Triagem não conta como "parou");
 *  - só o período de ENTRADA, só o funil pedido, sem base importada nem teste;
 *  - RLS: outra organização não lê nada; `anon` não executa a função;
 *  - a função não lê o texto das mensagens (o corpo dela não cita `body`).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "90290000-0000-4000-8000-00000000000a";
const OUTRA = "90290000-0000-4000-8000-00000000000b";
const GERENTE = "90290000-1111-4000-8000-000000000001";
const DE_FORA = "90290000-1111-4000-8000-000000000002";

let funil = "";
let outroFunil = "";
let sessao = "";
const etapa: Record<string, string> = {};
const posicao: Record<string, number> = {};
const L: Record<string, string> = {};

const agora = new Date();
const horasAtras = (h: number) => new Date(agora.getTime() - h * 3_600_000).toISOString();

async function membro(org: string, user: string, papel: string): Promise<void> {
  await pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [user, `${user}@invariant.test`]);
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,$3, now()) on conflict do nothing`,
    [user, org, papel],
  );
}

async function card(
  nome: string,
  k: { etapa: string; status?: "open" | "won" | "lost"; criadoHa?: number; source?: string; titulo?: string; doOutroFunil?: boolean },
  conversa: Array<[direcao: "inbound" | "outbound", horasAtras: number]>,
): Promise<string> {
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1,$2) returning id`,
    [ORG, nome],
  );
  const { rows: v } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, status, last_message_at)
     values ($1,$2,$3,'open', now()) returning id`,
    [ORG, c[0]!.id, sessao],
  );
  for (const [direcao, h] of conversa) {
    await pool.query(
      `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, created_at, sent_at)
       values ($1,$2,$3,$4,'text',$5,$6,$7,'texto que a medida nunca lê', $8, $8)`,
      [ORG, v[0]!.id, sessao, c[0]!.id, direcao, direcao === "inbound" ? "received" : "sent", direcao === "inbound" ? "external_device" : "ai", horasAtras(h)],
    );
  }
  const status = k.status ?? "open";
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, status, source, lost_reason, closed_at, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, case when $6 = 'open' then null else now() end, $9) returning id`,
    [
      ORG,
      k.doOutroFunil ? outroFunil : funil,
      etapa[k.etapa],
      c[0]!.id,
      k.titulo ?? nome,
      status,
      k.source ?? "whatsapp",
      status === "lost" ? "price" : null,
      horasAtras(k.criadoHa ?? 100),
    ],
  );
  return rows[0]!.id;
}

async function ritmo(user: string | null, horasDoPeriodo = 24 * 30): Promise<LinhaDoRitmo[]> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    if (user) {
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    }
    const { rows } = await c.query(
      `select * from fn_dados_ritmo_da_conversa($1, $2, $3, $4, $5)`,
      [ORG, funil, horasAtras(horasDoPeriodo), new Date(agora.getTime() + 60_000).toISOString(), posicao.qualificado],
    );
    return rows.map((r) => ({
      ...r,
      criado_em: new Date(r.criado_em).toISOString(),
      primeira_do_cliente_em: r.primeira_do_cliente_em ? new Date(r.primeira_do_cliente_em).toISOString() : null,
      primeira_resposta_em: r.primeira_resposta_em ? new Date(r.primeira_resposta_em).toISOString() : null,
      ultima_do_cliente_em: r.ultima_do_cliente_em ? new Date(r.ultima_do_cliente_em).toISOString() : null,
    })) as LinhaDoRitmo[];
  } finally {
    await c.query("rollback");
    c.release();
  }
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "org-9029"],
    [OUTRA, "outra-9029"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name, timezone) values ($1,$2::text,$2::text,$2::text,'America/Sao_Paulo')
       on conflict (id) do nothing`,
      [id, slug],
    );
  }
  await membro(ORG, GERENTE, "manager");
  await membro(OUTRA, DE_FORA, "manager");
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position) values ($1,'Prev','prev-9029',100) returning id`,
    [ORG],
  );
  funil = p[0]!.id;
  const { rows: p2 } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position) values ($1,'Outro','outro-9029',200) returning id`,
    [ORG],
  );
  outroFunil = p2[0]!.id;
  const etapas: Array<[string, number, boolean, string?]> = [
    ["triagem", 1, false],
    ["analise", 2, false],
    ["qualificado", 3, false],
    ["assinatura", 4, false],
    ["perdido", 9, true],
  ];
  for (const [slug, pos, perdida] of etapas) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
       values ($1,$2,$3,$4,$5,false,$6) returning id`,
      [ORG, funil, slug, `${slug}-9029`, pos, perdida],
    );
    etapa[slug] = rows[0]!.id;
    posicao[slug] = pos;
  }
  const { rows: o } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position) values ($1,$2,'Outra','outra-9029',1) returning id`,
    [ORG, outroFunil],
  );
  etapa.outra = o[0]!.id;
  const { rows: s } = await pool.query<{ id: string }>(
    `insert into channel_sessions (organization_id, waha_session_name, webhook_secret_encrypted)
     values ($1, 'sessao-9029', '\\x00'::bytea) returning id`,
    [ORG],
  );
  sessao = s[0]!.id;

  // O cenário do aceite.
  L.soPrimeira = await card("Só a primeira", { etapa: "triagem" }, [["inbound", 100], ["outbound", 99]]);
  L.parou = await card("Conversou e parou", { etapa: "triagem" }, [
    ["inbound", 100],
    ["outbound", 99],
    ["inbound", 50],
    ["outbound", 49],
    ["inbound", 30],
  ]);
  L.qualificado = await card("Chegou ao Qualificado", { etapa: "qualificado" }, [
    ["inbound", 100],
    ["outbound", 99],
    ["inbound", 30],
  ]);
  L.perdido = await card("Perdido", { etapa: "perdido", status: "lost" }, [
    ["inbound", 100],
    ["outbound", 99],
    ["inbound", 30],
  ]);
  // Passou pelo Qualificado e voltou: a linha do tempo diz que chegou ao marco.
  L.voltou = await card("Passou e voltou", { etapa: "triagem" }, [
    ["inbound", 100],
    ["outbound", 99],
    ["inbound", 30],
  ]);
  await pool.query(
    `insert into crm_lead_activities (organization_id, lead_id, source_module, type, payload, performed_at)
     values ($1,$2,'crm','stage_changed', jsonb_build_object('from_stage_id',$3::text,'to_stage_id',$4::text), now() - interval '40 hours')`,
    [ORG, L.voltou, etapa.triagem, etapa.qualificado],
  );
  // Fora do universo: base importada, teste, outro funil, entrou antes do período.
  L.importado = await card("Importado", { etapa: "triagem", source: "importado_zernio" }, [["inbound", 100], ["outbound", 99]]);
  L.teste = await card("Teste", { etapa: "triagem", titulo: "Teste da equipe" }, [["inbound", 100], ["outbound", 99]]);
  L.doOutroFunil = await card("Outro funil", { etapa: "outra", doOutroFunil: true }, [["inbound", 100], ["outbound", 99]]);
  L.antigo = await card("Antigo", { etapa: "triagem", criadoHa: 24 * 60 }, [["inbound", 24 * 60], ["outbound", 24 * 60 - 1]]);
});

afterAll(async () => {
  await pool.end();
});

describe("fn_dados_ritmo_da_conversa (9029)", () => {
  it("os fatos de cada card: só direção e horário", async () => {
    const linhas = await ritmo(GERENTE);
    const porId = new Map(linhas.map((l) => [l.lead_id, l]));
    expect(Number(porId.get(L.soPrimeira!)!.respostas_depois)).toBe(0);
    expect(Number(porId.get(L.parou!)!.respostas_depois)).toBe(2);
    expect(porId.get(L.parou!)!.ultima_do_cliente_em).toBe(horasAtras(30));
    expect(porId.get(L.qualificado!)!.chegou_ao_marco).toBe(true);
    expect(porId.get(L.voltou!)!.chegou_ao_marco).toBe(true);
    expect(porId.get(L.parou!)!.chegou_ao_marco).toBe(false);
  });

  it("só o funil pedido, o período de entrada e o universo do painel", async () => {
    const ids = (await ritmo(GERENTE)).map((l) => l.lead_id);
    expect(ids).not.toContain(L.importado);
    expect(ids).not.toContain(L.teste);
    expect(ids).not.toContain(L.doOutroFunil);
    expect(ids).not.toContain(L.antigo);
    expect(ids).toEqual(expect.arrayContaining([L.soPrimeira, L.parou, L.qualificado, L.perdido, L.voltou]));
  });

  it("⭐ o cenário do aceite: a) = 1, b) = 1; N de 24 para 72 h muda", async () => {
    const linhas = await ritmo(GERENTE);
    const opcoes = { agora, fora: new Set<string>(), diaDe: (iso: string) => iso.slice(0, 10) };
    const r24 = classificarParouAntes(linhas, { ...opcoes, horas: 24 });
    expect(r24.so_primeira).toBe(1);
    expect(r24.parou).toBe(1);
    expect(r24.cards.map((c) => c.id).sort()).toEqual([L.parou, L.soPrimeira].sort());
    const r72 = classificarParouAntes(linhas, { ...opcoes, horas: 72 });
    expect(r72.parou).toBe(0);
    expect(r72.so_primeira).toBe(1);
  });

  it("etapa fora da medida não entra", async () => {
    const linhas = await ritmo(GERENTE);
    const r = classificarParouAntes(linhas, {
      agora,
      horas: 24,
      fora: new Set([etapa.triagem!]),
      diaDe: (iso: string) => iso.slice(0, 10),
    });
    expect(r.so_primeira).toBe(0);
    expect(r.parou).toBe(0);
  });

  it("RLS: outra organização não lê nada; anon não executa", async () => {
    expect(await ritmo(DE_FORA)).toEqual([]);
    const { rows } = await pool.query<{ pode: boolean }>(
      `select has_function_privilege('anon', 'public.fn_dados_ritmo_da_conversa(uuid, uuid, timestamptz, timestamptz, numeric)', 'execute') as pode`,
    );
    expect(rows[0]!.pode).toBe(false);
  });

  it("o corpo da função não lê o texto das mensagens", async () => {
    const { rows } = await pool.query<{ corpo: string }>(
      `select prosrc as corpo from pg_proc where proname = 'fn_dados_ritmo_da_conversa'`,
    );
    expect(rows[0]!.corpo).not.toMatch(/\bbody\b|\bcontent\b|\btext_body\b/);
  });
});
