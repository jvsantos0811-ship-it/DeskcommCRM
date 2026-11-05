import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { conferirInteresse } from "@/lib/mcp/conferencia-de-campos";
import { blocoDosCamposDoNegocio } from "@/lib/agent-engine/agent/campos-do-negocio-no-turno";
import { normalizarNomeDoTipo } from "@/lib/leads/tipo-de-lead";
import { pgComoSupabase } from "../pg-como-supabase";

/**
 * v3 §1 (migration 9018) — O VALOR DO NEGÓCIO PELO TIPO DE LEAD, contra o
 * Postgres do baseline.
 *
 *  - gravar o interesse (`custom_fields.servico`) num negócio sem valor preenche
 *    `value_cents` com o valor do tipo, e a linha do tempo registra;
 *  - valor de pessoa nunca é sobrescrito — nem por mudança de interesse, nem por
 *    mudança de preço;
 *  - mudar o preço propaga só para quem a regra preencheu, e só negócio aberto;
 *  - criar um tipo novo preenche os abertos com aquele interesse e sem valor;
 *  - ⭐ isolamento: o tipo de outra organização com o MESMO nome nunca é usado.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "90180000-0000-4000-8000-00000000000a";
const OUTRA = "90180000-0000-4000-8000-00000000000b";
const funil: Record<string, { pipeline: string; aberta: string; ganha: string }> = {};

async function semearOrg(id: string, slug: string): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,$2::text,$2::text,$2::text) on conflict (id) do nothing`,
    [id, slug],
  );
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position) values ($1,'Prev','prev-9018',100) returning id`,
    [id],
  );
  const pipeline = p[0]!.id;
  const { rows: a } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position) values ($1,$2,'Novo','novo-9018',1) returning id`,
    [id, pipeline],
  );
  const { rows: g } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won) values ($1,$2,'Contratado','ganho-9018',2,true) returning id`,
    [id, pipeline],
  );
  funil[id] = { pipeline, aberta: a[0]!.id, ganha: g[0]!.id };
}

async function tipo(org: string, nome: string, preco: number, extra: { ativo?: boolean } = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into catalog_products (organization_id, codigo, nome, preco_cents, tipo_de_lead, controla_estoque, ativo)
     values ($1, $2, $3, $4, true, false, $5) returning id`,
    [org, `tl-${nome}-${Math.random().toString(36).slice(2, 8)}`, nome, preco, extra.ativo ?? true],
  );
  return rows[0]!.id;
}

async function negocio(org: string, titulo: string, campos: Record<string, unknown> = {}, valor: number | null = null): Promise<string> {
  const f = funil[org]!;
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, title, custom_fields, value_cents)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [org, f.pipeline, f.aberta, titulo, JSON.stringify(campos), valor],
  );
  return rows[0]!.id;
}

async function lido(id: string): Promise<{ value_cents: number | null; valor_origem: string | null; currency: string | null }> {
  const { rows } = await pool.query(
    `select value_cents::int as value_cents, valor_origem, currency from crm_leads where id = $1`,
    [id],
  );
  return rows[0] as never;
}

async function interesse(id: string, servico: string | null): Promise<void> {
  await pool.query(
    `update crm_leads set custom_fields = coalesce(custom_fields,'{}'::jsonb) || jsonb_build_object('servico', $2::text) where id = $1`,
    [id, servico],
  );
}

async function atividades(id: string): Promise<Array<{ reason: string; actor_kind: string }>> {
  const { rows } = await pool.query(
    `select reason, actor_kind from crm_lead_activities where lead_id = $1 and type = 'valor_pelo_tipo_de_lead' order by created_at, id`,
    [id],
  );
  return rows as never;
}

beforeAll(async () => {
  await semearOrg(ORG, "org-9018-a");
  await semearOrg(OUTRA, "org-9018-b");
  await tipo(ORG, "Auxílio-acidente", 300000);
  await tipo(ORG, "BPC/LOAS", 250000);
});

afterAll(async () => {
  await pool.end();
});

describe("9018 — o interesse preenche o valor do negócio", () => {
  it("negócio sem valor recebe o valor do tipo (nome sem acento nem maiúscula casa) e a linha do tempo registra", async () => {
    const id = await negocio(ORG, "Caso A");
    await interesse(id, "auxilio acidente");
    expect(await lido(id)).toEqual({ value_cents: 300000, valor_origem: "tipo_de_lead", currency: "BRL" });
    expect(await atividades(id)).toEqual([
      { reason: "Valor do caso preenchido pelo tipo de lead", actor_kind: "system" },
    ]);
  });

  it("o negócio que já nasce com o interesse e sem valor também recebe", async () => {
    const id = await negocio(ORG, "Caso nasce", { servico: "BPC/LOAS" });
    expect(await lido(id)).toMatchObject({ value_cents: 250000, valor_origem: "tipo_de_lead" });
  });

  it("trocar o interesse troca o valor que a regra preencheu", async () => {
    const id = await negocio(ORG, "Caso troca");
    await interesse(id, "Auxílio-acidente");
    await interesse(id, "BPC/LOAS");
    expect(await lido(id)).toMatchObject({ value_cents: 250000, valor_origem: "tipo_de_lead" });
    expect((await atividades(id)).map((a) => a.reason)).toEqual([
      "Valor do caso preenchido pelo tipo de lead",
      "Valor do caso atualizado pelo valor do tipo de lead",
    ]);
  });

  it("interesse que não é tipo de lead não mexe no valor", async () => {
    const id = await negocio(ORG, "Caso sem tipo");
    await interesse(id, "Aposentadoria");
    expect(await lido(id)).toMatchObject({ value_cents: null, valor_origem: null });
    expect(await atividades(id)).toEqual([]);
  });

  it("tipo desativado não preenche", async () => {
    await tipo(ORG, "Pensão por morte", 400000, { ativo: false });
    const id = await negocio(ORG, "Caso desativado");
    await interesse(id, "Pensão por morte");
    expect(await lido(id)).toMatchObject({ value_cents: null });
  });
});

describe("9018 — valor de pessoa nunca é sobrescrito", () => {
  it("valor digitado ANTES do interesse fica", async () => {
    const id = await negocio(ORG, "Caso pessoa 1", {}, 123400);
    expect(await lido(id)).toMatchObject({ value_cents: 123400, valor_origem: "pessoa" });
    await interesse(id, "Auxílio-acidente");
    expect(await lido(id)).toMatchObject({ value_cents: 123400, valor_origem: "pessoa" });
    expect(await atividades(id)).toEqual([]);
  });

  it("pessoa que corrige o valor preenchido pela regra vira dona dele: nem o interesse nem o preço o trocam", async () => {
    const id = await negocio(ORG, "Caso pessoa 2");
    await interesse(id, "Auxílio-acidente");
    await pool.query(`update crm_leads set value_cents = 500000 where id = $1`, [id]);
    expect(await lido(id)).toMatchObject({ value_cents: 500000, valor_origem: "pessoa" });
    await interesse(id, "BPC/LOAS");
    expect(await lido(id)).toMatchObject({ value_cents: 500000, valor_origem: "pessoa" });
    await pool.query(
      `update catalog_products set preco_cents = 260000 where organization_id = $1 and nome = 'BPC/LOAS'`,
      [ORG],
    );
    expect(await lido(id)).toMatchObject({ value_cents: 500000, valor_origem: "pessoa" });
  });

  it("a escrita não consegue se declarar 'tipo_de_lead' por conta própria", async () => {
    const id = await negocio(ORG, "Caso forja");
    await pool.query(`update crm_leads set value_cents = 99900, valor_origem = 'tipo_de_lead' where id = $1`, [id]);
    expect(await lido(id)).toMatchObject({ value_cents: 99900, valor_origem: "pessoa" });
  });

  it("mexer em outra coisa (título) não muda a origem de quem preencheu", async () => {
    const id = await negocio(ORG, "Caso título");
    await interesse(id, "Auxílio-acidente");
    await pool.query(`update crm_leads set title = 'Caso título 2' where id = $1`, [id]);
    expect(await lido(id)).toMatchObject({ valor_origem: "tipo_de_lead" });
  });
});

describe("9018 — o preço do tipo propaga para os abertos da regra", () => {
  it("só negócio ABERTO com valor da regra muda; pessoa e fechado ficam", async () => {
    const idTipo = await tipo(ORG, "Salário-maternidade", 200000);
    const aberto = await negocio(ORG, "Mat aberto", { servico: "Salário-maternidade" });
    const pessoa = await negocio(ORG, "Mat pessoa", { servico: "Salário-maternidade" }, 180000);
    const fechado = await negocio(ORG, "Mat fechado", { servico: "Salário-maternidade" });
    await pool.query(`update crm_leads set stage_id = $2 where id = $1`, [fechado, funil[ORG]!.ganha]);
    expect((await pool.query(`select status from crm_leads where id = $1`, [fechado])).rows[0]).toEqual({ status: "won" });

    await pool.query(`update catalog_products set preco_cents = 220000 where id = $1`, [idTipo]);

    expect(await lido(aberto)).toMatchObject({ value_cents: 220000, valor_origem: "tipo_de_lead" });
    expect(await lido(pessoa)).toMatchObject({ value_cents: 180000, valor_origem: "pessoa" });
    expect(await lido(fechado)).toMatchObject({ value_cents: 200000, valor_origem: "tipo_de_lead" });
    expect((await atividades(aberto)).map((a) => a.reason)).toEqual([
      "Valor do caso preenchido pelo tipo de lead",
      "Valor do caso atualizado pelo valor do tipo de lead",
    ]);
  });

  it("criar um tipo novo preenche os abertos que já tinham o interesse e nenhum valor", async () => {
    const antes = await negocio(ORG, "Antes do tipo", { servico: "Incapacidade" });
    expect(await lido(antes)).toMatchObject({ value_cents: null });
    await tipo(ORG, "Incapacidade", 350000);
    expect(await lido(antes)).toMatchObject({ value_cents: 350000, valor_origem: "tipo_de_lead" });
  });
});

describe("9018 — ⭐ isolamento entre organizações", () => {
  it("o tipo de OUTRA organização com o mesmo nome nunca é usado", async () => {
    await tipo(OUTRA, "Revisão da vida toda", 999900);
    const id = await negocio(ORG, "Caso isolamento");
    await interesse(id, "Revisão da vida toda");
    expect(await lido(id)).toMatchObject({ value_cents: null, valor_origem: null });

    // E o preço da outra organização mudando não alcança o negócio desta.
    await tipo(ORG, "Revisão da vida toda", 100000);
    expect(await lido(id)).toMatchObject({ value_cents: 100000 });
    await pool.query(
      `update catalog_products set preco_cents = 888800 where organization_id = $1 and nome = 'Revisão da vida toda'`,
      [OUTRA],
    );
    expect(await lido(id)).toMatchObject({ value_cents: 100000 });
  });

  it("dois tipos com o mesmo nome normalizado na mesma organização são recusados (23505)", async () => {
    await expect(tipo(ORG, "bpc loas", 1)).rejects.toMatchObject({ code: "23505" });
  });
});

describe("9018 — a régua do nome é a mesma no TS e no banco", () => {
  it.each(["BPC/LOAS", "Auxílio-acidente", "  Salário  Maternidade ", "Pensão por morte", "ÇÃO-ÊÍ 2"])(
    "%s",
    async (nome) => {
      const { rows } = await pool.query<{ n: string | null }>(`select public.fn_nome_do_tipo_de_lead($1) as n`, [nome]);
      expect(rows[0]!.n ?? "").toBe(normalizarNomeDoTipo(nome));
    },
  );
});

describe("9018 — a IA aprende e grava o nome exato", () => {
  it("conferirInteresse troca a grafia da IA pelo nome do catálogo e recusa o que não existe, só desta organização", async () => {
    const supabase = pgComoSupabase(pool);
    const ok = await conferirInteresse({ supabase, organizationId: ORG } as never, { servico: "bpc loas", outro: 1 });
    expect(ok).toEqual({ custom_fields: { servico: "BPC/LOAS", outro: 1 }, recusados: [] });
    // "Revisão da vida toda" existe nas duas; um nome SÓ da outra organização é recusado aqui.
    await tipo(OUTRA, "Só da vizinha", 1);
    const nao = await conferirInteresse({ supabase, organizationId: ORG } as never, { servico: "Só da vizinha", outro: 1 });
    expect(nao.custom_fields).toEqual({ outro: 1 });
    expect(nao.recusados[0]?.motivo).toBe("tipo_de_lead_desconhecido");
    expect(nao.recusados[0]?.mensagem).toContain("BPC/LOAS");
    expect(nao.recusados[0]?.mensagem).not.toContain("Só da vizinha;");
  });

  it("o bloco do turno lista os tipos ativos do escritório", async () => {
    const { rows: c } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, name, phone_number) values ($1,'Cliente 9018','+5511900009018') returning id`,
      [ORG],
    );
    await pool.query(
      `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title) values ($1,$2,$3,$4,'Turno 9018')`,
      [ORG, funil[ORG]!.pipeline, funil[ORG]!.aberta, c[0]!.id],
    );
    const bloco = await blocoDosCamposDoNegocio(pool, ORG, c[0]!.id);
    expect(bloco).toContain("Tipos de lead do escritório");
    expect(bloco).toContain("BPC/LOAS");
    expect(bloco).toContain("Auxílio-acidente");
    expect(bloco).not.toContain("Pensão por morte");
    expect(bloco).not.toContain("Só da vizinha");
  });
});
