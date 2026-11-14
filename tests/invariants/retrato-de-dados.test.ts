import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { calcularQualidade, sinaisDaLinha, type LinhaDaQualidade } from "@/lib/dados/qualidade";
import { leadDoRetrato, MINUTOS_ENTRE_ATUALIZACOES, DIAS_GUARDADOS, type LinhaDoRetrato } from "@/lib/dados/retrato";
import { MINUTOS_ENTRE_RECALCULOS_PELA_FICHA } from "@/lib/dados/gerar-retrato";

/**
 * v3 §8 (migration 9020) — O RETRATO DIÁRIO DE DADOS, contra o Postgres do baseline.
 *
 *  - ⭐ RLS: quem vê a organização inteira (gerente, leitor, atendente com
 *    "todos") lê o retrato; o atendente em "só os seus" NÃO lê (o retrato soma
 *    os leads dos colegas); quem é de outra organização não lê nada;
 *  - escrita só pelo service_role: `authenticated` só tem SELECT, e as funções
 *    de gravar e de listar não rodam para `authenticated` nem `anon`;
 *  - o dia é o do FUSO da organização (Tóquio já está no dia seguinte quando São
 *    Paulo ainda não), e o fuso desconhecido vale São Paulo;
 *  - o cron só lista a organização operante que já passou das 06:00 no relógio
 *    dela e ainda não tem o retrato do dia;
 *  - upsert por (organização, dia): rodar o cron duas vezes não duplica;
 *  - "Atualizar agora": recusado antes de 30 minutos, aceito depois;
 *  - limpeza: retrato com mais de 90 dias sai; mais de 7 dias fica sem a lista;
 *  - ⭐ `fn_dados_leads_do_retrato`: só o universo do painel, com a mesma nota do
 *    quadro — os leads A do retrato são os leads A do `?nivel=A&recorte=painel`;
 *    o atendente em "só os seus" recebe só os dele; outra organização, nada.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "90200000-0000-4000-8000-00000000000a";
const OUTRA = "90200000-0000-4000-8000-00000000000b";
const TOQUIO = "90200000-0000-4000-8000-00000000000c";
const PARADA = "90200000-0000-4000-8000-00000000000d";
const FUSO_RUIM = "90200000-0000-4000-8000-00000000000e";
const LIMPEZA = "90200000-0000-4000-8000-00000000000f";
const GERENTE = "90200000-1111-4000-8000-000000000001";
const LEITOR = "90200000-1111-4000-8000-000000000002";
const ATENDENTE = "90200000-1111-4000-8000-000000000003";
const ATENDENTE_DA_OUTRA = "90200000-1111-4000-8000-000000000004";

const NOSSAS = [ORG, OUTRA, TOQUIO, PARADA, FUSO_RUIM, LIMPEZA];

interface Funil {
  pipeline: string;
  triagem: string;
  proposta: string;
  outroFunil: string;
  outraEtapa: string;
}
const funil: Record<string, Funil> = {};
const L: Record<string, string> = {};

async function semearOrg(id: string, slug: string, fuso: string, extra: { status?: string } = {}): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, timezone, settings, status, suspended_kind)
     values ($1,$2::text,$2::text,$2::text,$3, jsonb_build_object('visibility_mode','own'), $4,
             case when $4 = 'suspended' then 'administrativa' end)
     on conflict (id) do nothing`,
    [id, slug, fuso, extra.status ?? "active"],
  );
  await pool.query(`update crm_pipelines set is_default = false where organization_id = $1`, [id]);
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position, is_default) values ($1,'Prev','prev-9020',100,true) returning id`,
    [id],
  );
  const { rows: p2 } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position, is_default) values ($1,'Outro','outro-9020',200,false) returning id`,
    [id],
  );
  const etapa = async (pipeline: string, nome: string, slug: string, pos: number, chance: number) => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position, win_probability, is_won, is_lost)
       values ($1,$2,$3,$4,$5,$6,false,false) returning id`,
      [id, pipeline, nome, slug, pos, chance],
    );
    return rows[0]!.id;
  };
  funil[id] = {
    pipeline: p[0]!.id,
    triagem: await etapa(p[0]!.id, "Triagem", "triagem-9020", 1, 10),
    proposta: await etapa(p[0]!.id, "Proposta", "proposta-9020", 2, 70),
    outroFunil: p2[0]!.id,
    outraEtapa: await etapa(p2[0]!.id, "Outra", "outra-9020", 1, 10),
  };
}

async function membro(org: string, user: string, papel: string): Promise<void> {
  await pool.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [user, `${user}@invariant.test`]);
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at) values ($1,$2,$3, now()) on conflict do nothing`,
    [user, org, papel],
  );
}

async function lead(
  titulo: string,
  k: { org?: string; etapa?: "triagem" | "proposta"; outroFunil?: boolean; dono?: string | null; source?: string; valor?: number },
): Promise<string> {
  const org = k.org ?? ORG;
  const f = funil[org]!;
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title, status, owner_user_id, source, value_cents, created_at)
     values ($1,$2,$3,$4,'open',$5,$6,$7, now() - interval '2 hours') returning id`,
    [
      org,
      k.outroFunil ? f.outroFunil : f.pipeline,
      k.outroFunil ? f.outraEtapa : f[k.etapa ?? "triagem"],
      titulo,
      k.dono === undefined ? GERENTE : k.dono,
      k.source ?? "whatsapp",
      k.valor ?? null,
    ],
  );
  return rows[0]!.id;
}

async function como(user: string, sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    const { rows } = await c.query(sql, params);
    return rows;
  } finally {
    await c.query("rollback");
    c.release();
  }
}

interface Gravacao {
  retrato_dia: string;
  retrato_gerado_em: Date;
  gravado: boolean;
  motivo: string;
  proximo_em: Date | null;
  apagados: number;
}

async function gravar(org: string, origem: string, agora: string, soSeFaltar = false): Promise<Gravacao> {
  const { rows } = await pool.query<Gravacao>(
    `select retrato_dia::text, retrato_gerado_em, gravado, motivo, proximo_em, apagados
       from public.fn_dados_gravar_retrato($1, $2, 1, '{"leads": 1}'::jsonb, '[{"id":"x"}]'::jsonb,
                                           '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $3, $4::timestamptz)`,
    [org, origem, soSeFaltar, agora],
  );
  return rows[0]!;
}

async function retratos(org: string): Promise<Array<{ dia: string; origem: string; leads: unknown }>> {
  const { rows } = await pool.query(
    `select dia::text, origem, leads from crm_dados_retrato where organization_id = $1 order by dia`,
    [org],
  );
  return rows as Array<{ dia: string; origem: string; leads: unknown }>;
}

beforeAll(async () => {
  await pool.query(`delete from crm_dados_retrato where organization_id = any($1::uuid[])`, [NOSSAS]);
  await semearOrg(ORG, "org-9020-a", "America/Sao_Paulo");
  await semearOrg(OUTRA, "org-9020-b", "America/Sao_Paulo");
  await semearOrg(TOQUIO, "org-9020-c", "Asia/Tokyo");
  await semearOrg(PARADA, "org-9020-d", "America/Sao_Paulo", { status: "suspended" });
  await semearOrg(FUSO_RUIM, "org-9020-e", "Lua/Base_Alfa");
  await semearOrg(LIMPEZA, "org-9020-f", "America/Sao_Paulo");
  await membro(ORG, GERENTE, "manager");
  await membro(ORG, LEITOR, "viewer");
  await membro(ORG, ATENDENTE, "agent");
  await membro(OUTRA, ATENDENTE_DA_OUTRA, "agent");

  L.doGerente = await lead("Lead do gerente", { etapa: "proposta", valor: 600000 });
  L.doAtendente = await lead("Lead do atendente", { dono: ATENDENTE });
  L.manual = await lead("Cadastro manual", { source: "manual" });
  L.importado = await lead("Base importada", { source: "importado_zernio" });
  L.teste = await lead("Teste do escritório", {});
  L.outroFunil = await lead("No outro funil", { outroFunil: true });
  L.daOutra = await lead("Lead da outra", { org: OUTRA, dono: ATENDENTE_DA_OUTRA });

  // Qualificado pela linha do tempo: entrou na Proposta (70%) há 3 h e voltou à Triagem.
  L.voltou = await lead("Voltou para a triagem", {});
  await pool.query(
    `insert into crm_lead_activities (organization_id, lead_id, source_module, type, payload, performed_at)
     values ($1,$2,'crm','stage_changed', jsonb_build_object('to_stage_id', $3::text), now() - interval '3 hours')`,
    [ORG, L.voltou, funil[ORG]!.proposta],
  );

  // O retrato de hoje da ORG e o da OUTRA, para a RLS ter o que (não) mostrar.
  await gravar(ORG, "cron", new Date().toISOString());
  await gravar(OUTRA, "cron", new Date().toISOString());
});

afterAll(async () => {
  await pool.query(`delete from crm_dados_retrato where organization_id = any($1::uuid[])`, [NOSSAS]);
  await pool.end();
});

describe("9020 — a tabela e quem escreve", () => {
  it("RLS ligada, uma policy só de leitura; authenticated só SELECT; anon nada", async () => {
    const { rows } = await pool.query(
      `select c.relrowsecurity as rls,
              (select string_agg(p.polname || ':' || p.polcmd::text, ',') from pg_policy p where p.polrelid = c.oid) as policies,
              has_table_privilege('authenticated', c.oid, 'select') as aut_select,
              has_table_privilege('authenticated', c.oid, 'insert') as aut_insert,
              has_table_privilege('authenticated', c.oid, 'update') as aut_update,
              has_table_privilege('authenticated', c.oid, 'delete') as aut_delete,
              has_table_privilege('anon', c.oid, 'select') as anon_select
         from pg_class c where c.oid = 'public.crm_dados_retrato'::regclass`,
    );
    expect(rows[0]).toEqual({
      rls: true,
      policies: "tenant_isolation_crm_dados_retrato_select:r",
      aut_select: true,
      aut_insert: false,
      aut_update: false,
      aut_delete: false,
      anon_select: false,
    });
  });

  it("gravar e listar só rodam para o service_role; os leads do retrato são SECURITY INVOKER", async () => {
    const { rows } = await pool.query(
      `select p.proname, p.prosecdef,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as autenticado,
              has_function_privilege('service_role', p.oid, 'execute') as servico
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('fn_dados_gravar_retrato','fn_dados_orgs_sem_retrato','fn_dados_leads_do_retrato','fn_dados_fuso_da_org')
        order by p.proname`,
    );
    expect(rows).toEqual([
      { proname: "fn_dados_fuso_da_org", prosecdef: false, anon: false, autenticado: false, servico: true },
      { proname: "fn_dados_gravar_retrato", prosecdef: false, anon: false, autenticado: false, servico: true },
      { proname: "fn_dados_leads_do_retrato", prosecdef: false, anon: false, autenticado: true, servico: true },
      { proname: "fn_dados_orgs_sem_retrato", prosecdef: false, anon: false, autenticado: false, servico: true },
    ]);
  });

  it("o gerente não grava pela REST: nem insert direto, nem a função", async () => {
    await expect(
      como(GERENTE, `insert into crm_dados_retrato (organization_id, dia) values ($1, current_date + 1)`, [ORG]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      como(
        GERENTE,
        `select * from public.fn_dados_gravar_retrato($1,'manual',1,'{}','[]','[]','[]','[]','[]')`,
        [ORG],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("9020 — ⭐ quem lê o retrato", () => {
  const ler = (user: string, org: string) =>
    como(user, `select count(*)::int as n from crm_dados_retrato where organization_id = $1`, [org]).then((r) => r[0]!.n);

  it("gerente e leitor leem o retrato da própria organização", async () => {
    expect(await ler(GERENTE, ORG)).toBe(1);
    expect(await ler(LEITOR, ORG)).toBe(1);
  });

  it("⭐ o atendente em \"só os seus\" não lê o retrato (ele soma os leads dos colegas)", async () => {
    expect(await ler(ATENDENTE, ORG)).toBe(0);
    const [ve] = await como(ATENDENTE, `select public.fn_dados_ve_a_org_inteira($1) as ve`, [ORG]);
    expect(ve!.ve).toBe(false);
  });

  it("o atendente com \"todos os leads\" lê", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`update organizations set settings = settings || '{"visibility_mode":"all"}' where id = $1`, [ORG]);
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ATENDENTE, role: "authenticated" })]);
      const { rows } = await c.query(`select count(*)::int as n from crm_dados_retrato where organization_id = $1`, [ORG]);
      expect(rows[0]!.n).toBe(1);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("⭐ quem é de outra organização não lê nada, nem pedindo pelo id", async () => {
    expect(await ler(ATENDENTE_DA_OUTRA, ORG)).toBe(0);
    expect(await ler(GERENTE, OUTRA)).toBe(0);
    const [ve] = await como(GERENTE, `select public.fn_dados_ve_a_org_inteira($1) as ve`, [OUTRA]);
    expect(ve!.ve).toBe(false);
  });
});

describe("9020 — o dia no fuso da organização e a hora do cron", () => {
  it("às 20:00 UTC de 05/11 São Paulo ainda está no dia 5 e Tóquio já está no dia 6", async () => {
    const agora = "2026-11-05T20:00:00Z";
    const sp = await gravar(LIMPEZA, "cron", agora);
    const tq = await gravar(TOQUIO, "cron", agora);
    expect(sp.retrato_dia).toBe("2026-11-05");
    expect(tq.retrato_dia).toBe("2026-11-06");
    await pool.query(`delete from crm_dados_retrato where organization_id = any($1::uuid[])`, [[LIMPEZA, TOQUIO]]);
  });

  it("fuso desconhecido vale São Paulo (não derruba o cron)", async () => {
    const r = await gravar(FUSO_RUIM, "cron", "2026-11-06T02:00:00Z");
    expect(r.retrato_dia).toBe("2026-11-05"); // 23:00 em São Paulo
    const { rows } = await pool.query(`select fuso from crm_dados_retrato where organization_id = $1`, [FUSO_RUIM]);
    expect(rows[0]!.fuso).toBe("America/Sao_Paulo");
    await pool.query(`delete from crm_dados_retrato where organization_id = $1`, [FUSO_RUIM]);
  });

  const listadas = async (agora: string) => {
    const { rows } = await pool.query<{ organization_id: string; dia: string }>(
      `select organization_id, dia::text from public.fn_dados_orgs_sem_retrato($1::timestamptz, 6)
        where organization_id = any($2::uuid[])`,
      [agora, [LIMPEZA, TOQUIO, PARADA]],
    );
    return new Map(rows.map((r) => [r.organization_id, r.dia]));
  };

  it("o cron só lista quem já passou das 06:00 no próprio relógio, e nunca a organização parada", async () => {
    // 08:30 UTC = 05:30 em São Paulo e 17:30 em Tóquio.
    const cedo = await listadas("2026-11-05T08:30:00Z");
    expect(cedo.has(LIMPEZA)).toBe(false);
    expect(cedo.get(TOQUIO)).toBe("2026-11-05");
    expect(cedo.has(PARADA)).toBe(false);
    // 09:30 UTC = 06:30 em São Paulo.
    const depois = await listadas("2026-11-05T09:30:00Z");
    expect(depois.get(LIMPEZA)).toBe("2026-11-05");
    expect(depois.has(PARADA)).toBe(false);
  });

  it("depois de gravado, a organização sai da lista do dia (e volta no dia seguinte)", async () => {
    await gravar(LIMPEZA, "cron", "2026-11-05T09:31:00Z");
    expect((await listadas("2026-11-05T10:30:00Z")).has(LIMPEZA)).toBe(false);
    expect((await listadas("2026-11-06T09:30:00Z")).get(LIMPEZA)).toBe("2026-11-06");
    await pool.query(`delete from crm_dados_retrato where organization_id = $1`, [LIMPEZA]);
  });
});

describe("9020 — upsert, intervalo de 30 minutos e limpeza", () => {
  it("rodar o cron duas vezes no mesmo dia não duplica nem refaz", async () => {
    const a = await gravar(LIMPEZA, "cron", "2026-11-05T09:10:00Z", true);
    const b = await gravar(LIMPEZA, "cron", "2026-11-05T10:10:00Z", true);
    expect(a).toMatchObject({ gravado: true, motivo: "gravado" });
    expect(b).toMatchObject({ gravado: false, motivo: "ja_existe" });
    expect(new Date(b.retrato_gerado_em).toISOString()).toBe("2026-11-05T09:10:00.000Z");
    expect(await retratos(LIMPEZA)).toHaveLength(1);
  });

  it(`"Atualizar agora": recusado antes de ${MINUTOS_ENTRE_ATUALIZACOES} min do último retrato, aceito depois — e na mesma linha do dia`, async () => {
    const quase = new Date(Date.parse("2026-11-05T09:10:00Z") + (MINUTOS_ENTRE_ATUALIZACOES - 1) * 60_000).toISOString();
    const r1 = await gravar(LIMPEZA, "manual", quase);
    expect(r1).toMatchObject({ gravado: false, motivo: "recente" });
    expect(new Date(r1.proximo_em!).toISOString()).toBe(
      new Date(Date.parse("2026-11-05T09:10:00Z") + MINUTOS_ENTRE_ATUALIZACOES * 60_000).toISOString(),
    );
    const passou = new Date(Date.parse("2026-11-05T09:10:00Z") + (MINUTOS_ENTRE_ATUALIZACOES + 1) * 60_000).toISOString();
    const r2 = await gravar(LIMPEZA, "manual", passou);
    expect(r2).toMatchObject({ gravado: true, motivo: "gravado" });
    const rs = await retratos(LIMPEZA);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.origem).toBe("manual");
    // O cron não tem o limite (ele já não refaz o do dia) e o catálogo também não.
    const r3 = await gravar(LIMPEZA, "catalogo", new Date(Date.parse(passou) + 60_000).toISOString());
    expect(r3.gravado).toBe(true);
  });

  it(`retrato com mais de ${DIAS_GUARDADOS} dias sai; com mais de 7 fica sem a lista de leads`, async () => {
    await pool.query(`delete from crm_dados_retrato where organization_id = $1`, [LIMPEZA]);
    const dia = (d: number) => new Date(Date.parse("2026-11-05T12:00:00Z") - d * 86_400_000).toISOString();
    for (const d of [100, 91, 90, 8, 7]) await gravar(LIMPEZA, "cron", dia(d), true);
    const hoje = await gravar(LIMPEZA, "cron", dia(0), true);
    // O de 100 dias já saiu quando o de 8 dias foi gravado (a limpeza corre a
    // cada gravação); o de hoje leva o de 91 dias.
    expect(hoje.apagados).toBe(1);
    const rs = await retratos(LIMPEZA);
    expect(rs.map((r) => r.dia)).toEqual(["2026-08-07", "2026-10-28", "2026-10-29", "2026-11-05"]);
    expect(rs.map((r) => (r.leads as unknown[]).length)).toEqual([0, 0, 1, 1]);
  });

  it(`9034 — recálculo pela ficha: recusado antes de ${MINUTOS_ENTRE_RECALCULOS_PELA_FICHA} min do último retrato, aceito depois`, async () => {
    await pool.query(`delete from crm_dados_retrato where organization_id = $1`, [LIMPEZA]);
    const base = Date.parse("2026-11-06T10:00:00Z");
    expect((await gravar(LIMPEZA, "cron", new Date(base).toISOString(), true)).gravado).toBe(true);
    const quase = new Date(base + (MINUTOS_ENTRE_RECALCULOS_PELA_FICHA - 1) * 60_000).toISOString();
    const r1 = await gravar(LIMPEZA, "ficha", quase);
    expect(r1).toMatchObject({ gravado: false, motivo: "recente" });
    expect(new Date(r1.proximo_em!).toISOString()).toBe(new Date(base + MINUTOS_ENTRE_RECALCULOS_PELA_FICHA * 60_000).toISOString());
    const passou = new Date(base + (MINUTOS_ENTRE_RECALCULOS_PELA_FICHA + 1) * 60_000).toISOString();
    const r2 = await gravar(LIMPEZA, "ficha", passou);
    expect(r2).toMatchObject({ gravado: true, motivo: "gravado" });
    const rs = await retratos(LIMPEZA);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.origem).toBe("ficha");
    // O "Atualizar agora" segue com os 30 minutos dele, contados do último retrato (o da ficha).
    expect(await gravar(LIMPEZA, "manual", new Date(Date.parse(passou) + 60_000).toISOString())).toMatchObject({ motivo: "recente" });
  });

  it("origem fora do vocabulário é recusada", async () => {
    await expect(gravar(LIMPEZA, "qualquer", new Date().toISOString())).rejects.toThrow(/origem inválida/);
  });
});

describe("9020 — ⭐ os leads do retrato: o universo do painel, com a nota do quadro", () => {
  it("só o universo: funil padrão, sem cadastro manual, base importada nem card de teste", async () => {
    const { rows } = await pool.query(`select lead_id from public.fn_dados_leads_do_retrato($1, 50)`, [ORG]);
    const ids = new Set(rows.map((r) => r.lead_id));
    expect(ids).toEqual(new Set([L.doGerente, L.doAtendente, L.voltou]));
  });

  it("qualificado: a entrada numa etapa ≥ 50% pela linha do tempo, ou a etapa atual", async () => {
    const { rows } = await pool.query(
      `select lead_id, qualificado_em is not null as q, etapa, valor_cents from public.fn_dados_leads_do_retrato($1, 50)`,
      [ORG],
    );
    const m = new Map(rows.map((r) => [r.lead_id, r]));
    expect(m.get(L.voltou)).toMatchObject({ q: true, etapa: "Triagem" });
    expect(m.get(L.doGerente)).toMatchObject({ q: true, etapa: "Proposta", valor_cents: "600000" });
    expect(m.get(L.doAtendente)).toMatchObject({ q: false });
  });

  it("⭐ a nota do retrato é a do quadro: os mesmos leads em cada nível", async () => {
    const agora = new Date();
    const { rows: doRetrato } = await pool.query(`select * from public.fn_dados_leads_do_retrato($1, 50)`, [ORG]);
    const { rows: doQuadro } = await pool.query(
      `select * from public.fn_dados_qualidade_do_lead($1, $2) where no_universo`,
      [ORG, funil[ORG]!.pipeline],
    );
    const nivelDoRetrato = new Map(
      doRetrato.map((r) => {
        const l = leadDoRetrato(JSON.parse(JSON.stringify(r)) as LinhaDoRetrato, agora, "America/Sao_Paulo");
        return [l.id, [l.nivel, l.nota]];
      }),
    );
    const nivelDoQuadro = new Map(
      doQuadro.map((r) => {
        const q = calcularQualidade(sinaisDaLinha(JSON.parse(JSON.stringify(r)) as LinhaDaQualidade), agora);
        return [r.lead_id as string, [q.nivel, q.nota]];
      }),
    );
    expect(nivelDoRetrato).toEqual(nivelDoQuadro);
  });

  it("⭐ o atendente em \"só os seus\" recebe só os dele; quem é de outra organização, nada", async () => {
    const meus = await como(ATENDENTE, `select lead_id from public.fn_dados_leads_do_retrato($1, 50)`, [ORG]);
    expect(meus.map((r) => r.lead_id)).toEqual([L.doAtendente]);
    const daOutra = await como(ATENDENTE_DA_OUTRA, `select lead_id from public.fn_dados_leads_do_retrato($1, 50)`, [ORG]);
    expect(daOutra).toEqual([]);
    const cruzado = await como(GERENTE, `select lead_id from public.fn_dados_leads_do_retrato($1, 50)`, [OUTRA]);
    expect(cruzado).toEqual([]);
  });
});
