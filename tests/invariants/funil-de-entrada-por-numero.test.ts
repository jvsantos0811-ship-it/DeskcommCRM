import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { gravarFunilDoNumero, retratoDoFunilDoNumero } from "@/lib/channels/funil-do-numero";
import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * O FUNIL DE CADA NÚMERO (migration 9025) — contra o schema REAL.
 *
 * O teste de unidade (`tests/unit/funil-de-entrada-por-numero.test.ts`) prova a
 * ordem da regra. Aqui se prova o que só o Postgres sabe:
 *
 *   1. as colunas nascem com o padrão "Sim · funil padrão" — número que já
 *      existia não muda de comportamento com a atualização;
 *   2. "Não" → a conversa existe, o card não nasce (motivo `numero_sem_funil`);
 *   3. "Sim · funil B" → o card nasce na primeira etapa ABERTA do funil B;
 *   4. funil arquivado → o card nasce no padrão, e o retrato da tela avisa;
 *   5. a FK composta recusa funil e etapa de OUTRA empresa, mesmo gravando
 *      direto no banco (sem passar pela conferência da tela);
 *   6. excluir o funil zera só o destino do número (`on delete set null`), e o
 *      número volta ao padrão em vez de travar a exclusão;
 *   7. a conferência da tela recusa funil arquivado e etapa de ganho.
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
const db = pgComoSupabase(pool);

const ORG = "f0de9025-0000-4000-8000-000000000001";
const OUTRA = "f0de9025-0000-4000-8000-000000000002";
const NUMERO_INTERNO = "f0de9025-0000-4000-8000-0000000000a1";
const NUMERO_COMERCIAL = "f0de9025-0000-4000-8000-0000000000a2";
const NUMERO_ANTIGO = "f0de9025-0000-4000-8000-0000000000a3";
const CONVERSA = "f0de9025-0000-4000-8000-00000000c001";

let funilPadrao = "";
let etapaPadrao = "";
let funilB = "";
let etapaB1 = "";
let etapaBGanho = "";
let funilDaOutra = "";

async function criarOrg(id: string, slug: string): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, 'Funil por número LTDA', 'Funil por número') on conflict (id) do nothing`,
    [id, slug],
  );
}

async function criarNumero(id: string, org: string, nome: string): Promise<void> {
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, display_name)
     values ($1, $2, $3, '\\x00'::bytea, $4) on conflict (id) do nothing`,
    [id, org, `funil9025-${id.slice(-4)}`, nome],
  );
}

async function criarContato(org: string, nome: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source) values ($1, $2, 'whatsapp') returning id`,
    [org, nome],
  );
  return rows[0]!.id;
}

async function cardsDoContato(contato: string): Promise<Array<{ pipeline_id: string; stage_id: string }>> {
  const { rows } = await pool.query<{ pipeline_id: string; stage_id: string }>(
    "select pipeline_id, stage_id from crm_leads where organization_id = $1 and contact_id = $2",
    [ORG, contato],
  );
  return rows;
}

beforeAll(async () => {
  await criarOrg(ORG, "org-funil-9025");
  await criarOrg(OUTRA, "org-funil-9025-outra");

  // O funil padrão é o que o trigger semeia na organização nova.
  const padrao = await pool.query<{ id: string }>(
    "select id from crm_pipelines where organization_id = $1 and is_default and not is_archived",
    [ORG],
  );
  funilPadrao = padrao.rows[0]!.id;
  const e = await pool.query<{ id: string }>(
    `select id from crm_stages where organization_id = $1 and pipeline_id = $2
       and not is_archived and not is_won and not is_lost order by position limit 1`,
    [ORG, funilPadrao],
  );
  etapaPadrao = e.rows[0]!.id;

  // Funil B, com a etapa de GANHO na posição 0 — a armadilha de sempre: a
  // primeira etapa por posição não pode ser a de entrada.
  const b = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, is_default, position)
     values ($1, 'Funil B', 'funil-b-9025', false, 2000) returning id`,
    [ORG],
  );
  funilB = b.rows[0]!.id;
  const etapasB = await pool.query<{ id: string; slug: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost) values
       ($1, $2, 'Ganho B',    'ganho-b-9025',    0, true,  false),
       ($1, $2, 'Recepção B', 'recepcao-b-9025', 1, false, false),
       ($1, $2, 'Triagem B',  'triagem-b-9025',  2, false, false)
     returning id, slug`,
    [ORG, funilB],
  );
  etapaBGanho = etapasB.rows.find((r) => r.slug === "ganho-b-9025")!.id;
  etapaB1 = etapasB.rows.find((r) => r.slug === "recepcao-b-9025")!.id;

  const outra = await pool.query<{ id: string }>(
    "select id from crm_pipelines where organization_id = $1 and is_default",
    [OUTRA],
  );
  funilDaOutra = outra.rows[0]!.id;

  await criarNumero(NUMERO_INTERNO, ORG, "Número interno");
  await criarNumero(NUMERO_COMERCIAL, ORG, "Número comercial");
  await criarNumero(NUMERO_ANTIGO, ORG, "Número antigo");
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG, OUTRA]]);
  await pool.end();
});

describe("o padrão não muda ninguém", () => {
  it("número que já existia nasce com \"Sim · funil padrão · primeira etapa\"", async () => {
    const { rows } = await pool.query(
      "select abre_card, funil_de_entrada_id, etapa_de_entrada_id from channel_sessions where id = $1",
      [NUMERO_ANTIGO],
    );
    expect(rows[0]).toEqual({ abre_card: true, funil_de_entrada_id: null, etapa_de_entrada_id: null });
  });

  it("e o card dele nasce no funil padrão, como antes da 9025", async () => {
    const contato = await criarContato(ORG, "Cliente do número antigo");
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: null,
      channelSessionId: NUMERO_ANTIGO,
    });
    expect(r).toMatchObject({ criado: true, pipelineId: funilPadrao, stageId: etapaPadrao });
  });
});

describe("cada número decide", () => {
  it("\"Não\" → zero card, motivo numero_sem_funil", async () => {
    const g = await gravarFunilDoNumero(db, ORG, NUMERO_INTERNO, { abre_card: false, funil_id: null, etapa_id: null });
    expect(g.ok).toBe(true);
    const contato = await criarContato(ORG, "Fornecedor do número interno");
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: null,
      channelSessionId: NUMERO_INTERNO,
    });
    expect(r).toEqual({ criado: false, motivo: "numero_sem_funil" });
    expect(await cardsDoContato(contato)).toHaveLength(0);
  });

  it("\"Sim · funil B\" → primeira etapa ABERTA do funil B (não a de ganho)", async () => {
    const g = await gravarFunilDoNumero(db, ORG, NUMERO_COMERCIAL, { abre_card: true, funil_id: funilB, etapa_id: null });
    expect(g.ok).toBe(true);
    const contato = await criarContato(ORG, "Lead do número comercial");
    const r = await garantirLeadDaConversa(db, {
      organizationId: ORG,
      contactId: contato,
      conversationId: CONVERSA,
      nomeDoContato: null,
      channelSessionId: NUMERO_COMERCIAL,
    });
    expect(r).toMatchObject({ criado: true, pipelineId: funilB, stageId: etapaB1 });
    expect(await cardsDoContato(contato)).toEqual([{ pipeline_id: funilB, stage_id: etapaB1 }]);

    // A tela diz o mesmo que o nascimento fez.
    const retrato = await retratoDoFunilDoNumero(db, ORG, NUMERO_COMERCIAL);
    expect(retrato?.destino).toMatchObject({ funil_id: funilB, etapa_id: etapaB1, funil_nome: "Funil B", padrao: false });
    expect(retrato?.aviso).toBeNull();
  });

  it("contato que escreve nos dois números ganha card só pelo que tem \"Sim\"", async () => {
    const contato = await criarContato(ORG, "Escreve nos dois");
    const base = { organizationId: ORG, contactId: contato, conversationId: CONVERSA, nomeDoContato: null };
    expect(await garantirLeadDaConversa(db, { ...base, channelSessionId: NUMERO_INTERNO })).toMatchObject({
      criado: false,
      motivo: "numero_sem_funil",
    });
    expect(await garantirLeadDaConversa(db, { ...base, channelSessionId: NUMERO_COMERCIAL })).toMatchObject({
      criado: true,
      pipelineId: funilB,
    });
    expect(await cardsDoContato(contato)).toHaveLength(1);
  });
});

describe("o conserto e a tela", () => {
  it("funil do número arquivado → card no padrão; o retrato avisa funil_arquivado", async () => {
    await pool.query("update crm_pipelines set is_archived = true where id = $1", [funilB]);
    try {
      const contato = await criarContato(ORG, "Lead com funil arquivado");
      const r = await garantirLeadDaConversa(db, {
        organizationId: ORG,
        contactId: contato,
        conversationId: CONVERSA,
        nomeDoContato: null,
        channelSessionId: NUMERO_COMERCIAL,
      });
      expect(r).toMatchObject({ criado: true, pipelineId: funilPadrao });
      const retrato = await retratoDoFunilDoNumero(db, ORG, NUMERO_COMERCIAL);
      expect(retrato?.aviso).toBe("funil_arquivado");
      expect(retrato?.destino).toMatchObject({ funil_id: funilPadrao, padrao: true });
      // E a conferência recusa escolher um funil arquivado.
      const g = await gravarFunilDoNumero(db, ORG, NUMERO_ANTIGO, { abre_card: true, funil_id: funilB, etapa_id: null });
      expect(g).toMatchObject({ ok: false, codigo: "funil_invalido" });
    } finally {
      await pool.query("update crm_pipelines set is_archived = false where id = $1", [funilB]);
    }
  });

  it("a conferência recusa etapa de ganho e etapa sem funil", async () => {
    expect(
      await gravarFunilDoNumero(db, ORG, NUMERO_ANTIGO, { abre_card: true, funil_id: funilB, etapa_id: etapaBGanho }),
    ).toMatchObject({ ok: false, codigo: "etapa_invalida" });
    // Etapa sem funil é ignorada (o padrão é "primeira etapa do funil padrão").
    const g = await gravarFunilDoNumero(db, ORG, NUMERO_ANTIGO, { abre_card: true, funil_id: null, etapa_id: etapaB1 });
    expect(g).toMatchObject({ ok: true, depois: { abre_card: true, funil_id: null, etapa_id: null } });
  });

  it("número de OUTRA empresa: a conferência responde \"não encontrado\"", async () => {
    expect(
      await gravarFunilDoNumero(db, OUTRA, NUMERO_COMERCIAL, { abre_card: false, funil_id: null, etapa_id: null }),
    ).toMatchObject({ ok: false, codigo: "nao_encontrado" });
  });
});

describe("o banco protege sozinho", () => {
  it("a FK composta recusa funil de OUTRA empresa, mesmo gravando direto", async () => {
    await expect(
      pool.query("update channel_sessions set funil_de_entrada_id = $1 where id = $2", [funilDaOutra, NUMERO_ANTIGO]),
    ).rejects.toThrow(/channel_sessions_funil_de_entrada_mesma_org/);
  });

  it("a FK composta recusa etapa de OUTRA empresa", async () => {
    const { rows } = await pool.query<{ id: string }>(
      "select id from crm_stages where organization_id = $1 limit 1",
      [OUTRA],
    );
    await expect(
      pool.query("update channel_sessions set etapa_de_entrada_id = $1 where id = $2", [rows[0]!.id, NUMERO_ANTIGO]),
    ).rejects.toThrow(/channel_sessions_etapa_de_entrada_mesma_org/);
  });

  it("excluir o funil zera só o destino do número; o número volta ao padrão e a exclusão não trava", async () => {
    const c = await pool.query<{ id: string }>(
      `insert into crm_pipelines (organization_id, name, slug, is_default, position)
       values ($1, 'Funil C', 'funil-c-9025', false, 3000) returning id`,
      [ORG],
    );
    const funilC = c.rows[0]!.id;
    const s = await pool.query<{ id: string }>(
      `insert into crm_stages (organization_id, pipeline_id, name, slug, position) values ($1, $2, 'Entrada C', 'entrada-c-9025', 1) returning id`,
      [ORG, funilC],
    );
    await pool.query(
      "update channel_sessions set abre_card = true, funil_de_entrada_id = $1, etapa_de_entrada_id = $2 where id = $3",
      [funilC, s.rows[0]!.id, NUMERO_ANTIGO],
    );
    await pool.query("delete from crm_stages where pipeline_id = $1", [funilC]);
    await pool.query("delete from crm_pipelines where id = $1", [funilC]);
    const { rows } = await pool.query(
      "select abre_card, funil_de_entrada_id, etapa_de_entrada_id from channel_sessions where id = $1",
      [NUMERO_ANTIGO],
    );
    expect(rows[0]).toEqual({ abre_card: true, funil_de_entrada_id: null, etapa_de_entrada_id: null });
  });
});
