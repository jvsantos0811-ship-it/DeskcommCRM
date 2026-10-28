/**
 * PC-002, Fase 1 — o SQL de verdade, contra o banco que o `baseline.sql` instala.
 *
 *   1. ⭐ espera deslizante: a 2ª mensagem empurra o `run_after` do job
 *      pendente; nunca para trás; nunca além de criação + teto; job já
 *      claimado (running) não é empurrado — a mensagem abre janela nova;
 *   2. ⭐ parar no meio: `clienteEscreveuDepoisDaLeitura` só diz sim quando
 *      chegou inbound DEPOIS da anotação do turno; as bolhas retidas são
 *      gravadas no job e lidas pelo turno seguinte — e deixam de valer quando
 *      outra resposta nossa saiu depois delas;
 *   3. a medida do turno (migration 9009): espera calculada no banco, um job =
 *      uma linha, sem conteúdo de mensagem.
 *
 * Roda só no CI e em `pnpm test:db` (precisa de Postgres).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decidirRajada } from "@/lib/agent-engine/edge/crm/debounce";
import { gravarTempoDoTurno } from "@/lib/agent-engine/agent/tempo-do-turno";
import {
  anotarUltimaInboundVista,
  clienteEscreveuDepoisDaLeitura,
  guardarBolhasRetidas,
  lerBolhasRetidas,
} from "@/lib/agent-engine/agent/turno-ja-respondido";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG = randomUUID();
const SESSAO = randomUUID();

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, timezone, locale)
     values ($1::uuid, $1::text, 'PC-002', 'PC-002', 'America/Sao_Paulo', 'pt-BR')`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
     values ($1, $2, 'pc-002', '\\x00'::bytea)`,
    [SESSAO, ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

async function conversa() {
  const contato = randomUUID();
  const id = randomUUID();
  await pool.query("insert into contacts (id, organization_id, display_name) values ($1, $2, 'Dona Maria')", [
    contato,
    ORG,
  ]);
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status)
     values ($1, $2, $3, $4, 'open')`,
    [id, ORG, contato, SESSAO],
  );
  return { id, contato };
}

async function mensagem(c: { id: string; contato: string }, direction: "inbound" | "outbound", segundosAtras: number) {
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                           type, direction, status, body, sent_via, sent_at, created_at)
     values ($1, $2, $3, $4, $5, 'text', $6, 'delivered', 'x', 'external_device',
             now() - make_interval(secs => $7), now() - make_interval(secs => $7))`,
    [randomUUID(), ORG, c.id, SESSAO, c.contato, direction, segundosAtras],
  );
}

async function job(c: { id: string; contato: string }, opts: { status?: string; runAfterSeg: number; criadoHaSeg?: number }) {
  const id = randomUUID();
  await pool.query(
    `insert into job_queue (id, organization_id, contact_id, kind, status, payload, run_after, created_at)
     values ($1, $2, $3, 'inbound_turn', $4, $5, now() + make_interval(secs => $6), now() - make_interval(secs => $7))`,
    [id, ORG, c.contato, opts.status ?? "pending", { conversation_id: c.id }, opts.runAfterSeg, opts.criadoHaSeg ?? 0],
  );
  return id;
}

async function runAfterEmSegundos(id: string): Promise<number> {
  const { rows } = await pool.query<{ s: number }>(
    "select extract(epoch from (run_after - now()))::float as s from job_queue where id = $1",
    [id],
  );
  return rows[0]!.s;
}

const deslizante = { tetoMs: 30_000, esperaMidiaMs: 20_000, tipo: "text" };

describe("espera deslizante (item 2)", () => {
  it("⭐ a 2ª mensagem empurra o relógio do job pendente para agora + espera", async () => {
    const c = await conversa();
    const id = await job(c, { runAfterSeg: 2, criadoHaSeg: 3 });
    const d = await decidirRajada(pool, { organizationId: ORG, contactId: c.contato }, 5_000, Date.now(), deslizante);
    expect(d).toEqual({ tipo: "coalescido", jobId: id });
    const s = await runAfterEmSegundos(id);
    expect(s).toBeGreaterThan(4.5);
    expect(s).toBeLessThanOrEqual(5.1);
  });

  it("nunca além de criação + teto (cliente que não para de escrever)", async () => {
    const c = await conversa();
    const id = await job(c, { runAfterSeg: 1, criadoHaSeg: 28 });
    await decidirRajada(pool, { organizationId: ORG, contactId: c.contato }, 5_000, Date.now(), deslizante);
    const s = await runAfterEmSegundos(id);
    expect(s).toBeGreaterThan(1.5);
    expect(s).toBeLessThanOrEqual(2.1);
  });

  it("nunca para trás: texto depois de foto não encurta a espera", async () => {
    const c = await conversa();
    const id = await job(c, { runAfterSeg: 18, criadoHaSeg: 2 });
    await decidirRajada(pool, { organizationId: ORG, contactId: c.contato }, 5_000, Date.now(), deslizante);
    expect(await runAfterEmSegundos(id)).toBeGreaterThan(17);
  });

  it("job já claimado não é empurrado: a mensagem abre janela nova", async () => {
    const c = await conversa();
    const rodando = await job(c, { status: "running", runAfterSeg: -1 });
    const d = await decidirRajada(pool, { organizationId: ORG, contactId: c.contato }, 5_000, Date.now(), deslizante);
    expect(d.tipo).toBe("enfileirar");
    const { rows } = await pool.query("select status from job_queue where id = $1", [rodando]);
    expect(rows[0].status).toBe("running");
  });

  it("job em hold (sessão morta) não recebe carona", async () => {
    const c = await conversa();
    const id = await job(c, { runAfterSeg: 3 });
    await pool.query(
      "update job_queue set payload = payload || '{\"held_run_after\": \"x\"}'::jsonb where id = $1",
      [id],
    );
    const d = await decidirRajada(pool, { organizationId: ORG, contactId: c.contato }, 5_000, Date.now(), deslizante);
    expect(d.tipo).toBe("enfileirar");
  });
});

describe("parar no meio (item 3)", () => {
  it("⭐ só diz que o cliente escreveu quando chegou inbound depois da leitura do turno", async () => {
    const c = await conversa();
    await mensagem(c, "inbound", 10);
    const id = await job(c, { status: "running", runAfterSeg: -1 });
    const alvo = { organizationId: ORG, contactId: c.contato, conversationId: c.id, jobId: id };
    await anotarUltimaInboundVista(pool, alvo);
    expect(await clienteEscreveuDepoisDaLeitura(pool, alvo)).toBe(false);
    await mensagem(c, "inbound", 0);
    expect(await clienteEscreveuDepoisDaLeitura(pool, alvo)).toBe(true);
  });

  it("⭐ as bolhas retidas chegam ao turno seguinte — e vencem quando outra resposta nossa sai", async () => {
    const c = await conversa();
    await mensagem(c, "inbound", 20);
    await mensagem(c, "outbound", 10); // a 1ª bolha, que saiu
    const cortado = await job(c, { status: "running", runAfterSeg: -1, criadoHaSeg: 15 });
    await guardarBolhasRetidas(pool, { organizationId: ORG, jobId: cortado }, ["O acidente foi no trabalho?"]);
    await guardarBolhasRetidas(pool, { organizationId: ORG, jobId: cortado }, ["E ele ficou afastado?"]);
    await mensagem(c, "inbound", 0);
    const novo = await job(c, { runAfterSeg: 0 });
    const alvoNovo = { organizationId: ORG, contactId: c.contato, conversationId: c.id, jobId: novo };
    expect(await lerBolhasRetidas(pool, alvoNovo)).toEqual(["O acidente foi no trabalho?", "E ele ficou afastado?"]);

    // O turno novo respondeu: o trecho retido vira passado.
    await mensagem(c, "outbound", -1);
    expect(await lerBolhasRetidas(pool, alvoNovo)).toEqual([]);
  });

  it("o retido de OUTRA conversa do mesmo contato não vaza", async () => {
    const a = await conversa();
    const outra = randomUUID();
    const outraSessao = randomUUID();
    await pool.query(
      `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
       values ($1, $2, 'pc-002-outra', '\\x00'::bytea)`,
      [outraSessao, ORG],
    );
    await pool.query(
      `insert into conversations (id, organization_id, contact_id, channel_session_id, status)
       values ($1, $2, $3, $4, 'open')`,
      [outra, ORG, a.contato, outraSessao],
    );
    const cortado = randomUUID();
    await pool.query(
      `insert into job_queue (id, organization_id, contact_id, kind, status, payload)
       values ($1, $2, $3, 'inbound_turn', 'done', $4)`,
      [cortado, ORG, a.contato, { conversation_id: outra }],
    );
    await guardarBolhasRetidas(pool, { organizationId: ORG, jobId: cortado }, ["não é desta conversa"]);
    const novo = await job(a, { runAfterSeg: 0 });
    expect(await lerBolhasRetidas(pool, { organizationId: ORG, contactId: a.contato, conversationId: a.id, jobId: novo })).toEqual([]);
  });
});

describe("tempo do turno (item 5, migration 9009)", () => {
  it("⭐ grava a espera da última mensagem do cliente até a 1ª bolha, uma linha por job", async () => {
    const c = await conversa();
    await mensagem(c, "inbound", 20);
    await mensagem(c, "inbound", 12);
    const jobId = randomUUID();
    const primeira = new Date(Date.now());
    const medida = {
      organizationId: ORG,
      conversationId: c.id,
      agentId: null,
      jobId,
      primeiraBolhaEm: primeira,
      mensagensRespondidas: 2,
      bolhasRetidas: 0,
      ferramentasQueFalharam: 1,
    };
    await gravarTempoDoTurno(pool, medida);
    await gravarTempoDoTurno(pool, medida); // re-execução não duplica
    const { rows } = await pool.query(
      "select espera_ms, mensagens_respondidas, ferramentas_falharam from tempos_de_resposta_da_ia where organization_id = $1 and job_id = $2",
      [ORG, jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].espera_ms).toBeGreaterThan(11_000);
    expect(rows[0].espera_ms).toBeLessThan(13_500);
    expect(rows[0].mensagens_respondidas).toBe(2);
    expect(rows[0].ferramentas_falharam).toBe(1);
  });

  it("turno que não respondeu fica com espera nula (não some da medida)", async () => {
    const c = await conversa();
    await mensagem(c, "inbound", 5);
    const jobId = randomUUID();
    await gravarTempoDoTurno(pool, {
      organizationId: ORG,
      conversationId: c.id,
      agentId: null,
      jobId,
      primeiraBolhaEm: null,
      mensagensRespondidas: 1,
      bolhasRetidas: 0,
      ferramentasQueFalharam: 0,
    });
    const { rows } = await pool.query(
      "select espera_ms, primeira_bolha_em, ultima_msg_cliente_em is not null as tem_ultima from tempos_de_resposta_da_ia where job_id = $1",
      [jobId],
    );
    expect(rows[0]).toEqual({ espera_ms: null, primeira_bolha_em: null, tem_ultima: true });
  });

  it("a tabela não tem coluna de conteúdo de mensagem", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'tempos_de_resposta_da_ia'",
    );
    const colunas = rows.map((r) => r.column_name);
    expect(colunas.some((c) => /body|texto|conteudo|content/.test(c))).toBe(false);
  });
});
