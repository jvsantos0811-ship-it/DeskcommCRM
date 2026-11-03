import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buscarNaBase,
  criarConferenciaSemFonte,
  falasENotasDoCliente,
} from "@/lib/agent-engine/guardrails/sem-fonte-conferencia";

/**
 * PC-020 — SEM FONTE, NÃO AFIRMA, contra o Postgres do baseline: de onde a
 * conferência tira a fonte de cada afirmação.
 *
 *  - regra → a base de conhecimento ATIVA da organização (busca por texto em
 *    português com a própria frase), restrita às fontes do agente quando ele
 *    tem fontes, e nunca a versão antiga nem a base de outra organização;
 *  - fala do cliente → as mensagens RECEBIDAS (com a transcrição do áudio) e
 *    as notas do contato; nunca o que a IA ou a equipe disse.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "9020aaaa-0000-4000-8000-000000000001";
const VIZINHA = "9020aaaa-0000-4000-8000-000000000002";
const SESSAO = "9020aaaa-0000-4000-8000-0000000000c1";

let agente = "";
let fonteInss = "";
let fonteOutra = "";
let contato = "";
/** `ai_knowledge_versions` tem número único por agente (legado): um contador para todas as fontes. */
let numeroDaVersao = 0;

async function criarOrg(id: string, slug: string) {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,$2,$3,$3) on conflict (id) do nothing`,
    [id, slug, slug.toUpperCase()],
  );
}

async function agenteDa(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into ai_agents (organization_id, name, system_prompt) values ($1, 'Agente PC020', 's') returning id`,
    [org],
  );
  return rows[0]!.id;
}

/** Uma fonte com uma versão ATIVA de um trecho (e, se pedido, uma versão antiga com outro texto). */
async function fonte(org: string, agentId: string, texto: string, antigo?: string): Promise<string> {
  const source = randomUUID();
  await pool.query(
    `insert into ai_knowledge_sources (id, organization_id, agent_id, source_type, name, status)
     values ($1,$2,$3,'faq',$4,'ready')`,
    [source, org, agentId, `Regras PC020 ${source.slice(0, 8)}`],
  );
  const versoes: [string, string][] = [];
  if (antigo) versoes.push([randomUUID(), antigo]);
  versoes.push([randomUUID(), texto]);
  for (const [i, [versao, conteudo]] of versoes.entries()) {
    numeroDaVersao += 1;
    await pool.query(
      `insert into ai_knowledge_versions (id, organization_id, agent_id, version_number, is_active) values ($1,$2,$3,$4,$5)`,
      [versao, org, agentId, numeroDaVersao, i === versoes.length - 1],
    );
    const chunk = randomUUID();
    await pool.query(
      `insert into ai_chunks (id, organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding, metadata)
       values ($1::uuid,$2,$3,$4,0,$5,$1::text,12,array_fill(0.1::real,array[1536])::vector,'{}')`,
      [chunk, org, source, versao, conteudo],
    );
  }
  await pool.query(`update ai_knowledge_sources set active_kb_version_id = $1 where id = $2`, [
    versoes[versoes.length - 1]![0],
    source,
  ]);
  return source;
}

beforeAll(async () => {
  await criarOrg(ORG, "pc020");
  await criarOrg(VIZINHA, "pc020-vizinha");
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'pc020','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSAO, ORG],
  );
  agente = await agenteDa(ORG);
  fonteInss = await fonte(
    ORG,
    agente,
    "O prazo do recurso administrativo no INSS é de 30 dias, contados da ciência da decisão.",
    "O prazo do recurso administrativo no INSS é de 15 dias (texto antigo).",
  );
  fonteOutra = await fonte(ORG, agente, "O escritório atende de segunda a sexta, das 9h às 18h.");
  await fonte(VIZINHA, await agenteDa(VIZINHA), "SENTINELA VIZINHA: o prazo do recurso é de 99 dias.");

  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name) values ($1, 'Maria PC020') returning id`,
    [ORG],
  );
  contato = c[0]!.id;
  const { rows: v } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id) values ($1,$2,$3) returning id`,
    [ORG, contato, SESSAO],
  );
  const conversa = v[0]!.id;
  await pool.query(
    `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, media_derived_text, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,'text','inbound','received','oi, quero saber do meu caso',null,'external_device', now() - interval '3 hours', now() - interval '3 hours'),
            ($1,$2,$3,$4,'text','outbound','sent','O acidente foi em que ano?',null,'ai', now() - interval '2 hours', now() - interval '2 hours'),
            ($1,$2,$3,$4,'audio','inbound','received',null,'o acidente foi em março de 2022','external_device', now() - interval '1 hour', now() - interval '1 hour')`,
    [ORG, conversa, SESSAO, contato],
  );
  await pool.query(
    `insert into lead_notes (organization_id, contact_id, headline, body) values ($1,$2,'Empresa','Trabalhava como motorista de entrega')`,
    [ORG, contato],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("PC-020 — de onde vem a fonte", () => {
  it("regra: acha o trecho da versão ATIVA, nunca o antigo nem o da organização vizinha", async () => {
    const achados = await buscarNaBase(pool, { organizationId: ORG, fontes: [], frase: "O prazo do recurso é de 60 dias." });
    expect(achados).toEqual([
      "O prazo do recurso administrativo no INSS é de 30 dias, contados da ciência da decisão.",
    ]);
    expect(achados.join(" ")).not.toContain("15 dias");
    expect(achados.join(" ")).not.toContain("SENTINELA");
  });

  it("regra: com fontes do agente, só elas contam", async () => {
    expect(
      await buscarNaBase(pool, { organizationId: ORG, fontes: [fonteOutra], frase: "O prazo do recurso é de 60 dias." }),
    ).toEqual([]);
    expect(
      await buscarNaBase(pool, { organizationId: ORG, fontes: [fonteInss], frase: "O prazo do recurso é de 60 dias." }),
    ).toHaveLength(1);
  });

  it("fala do cliente: só o que ELE disse (com a transcrição do áudio), em ordem, e as notas", async () => {
    const r = await falasENotasDoCliente(pool, { organizationId: ORG, contactId: contato });
    expect(r.falas).toEqual(["oi, quero saber do meu caso", "o acidente foi em março de 2022"]);
    expect(r.notas).toEqual(["Empresa: Trabalhava como motorista de entrega"]);
  });

  it("a conferência inteira lê o banco: a pergunta leva o trecho certo e as falas; o estado vem do settings", async () => {
    const perguntas: string[] = [];
    const chamar = vi.fn(async (_s: string, pergunta: string) => {
      perguntas.push(pergunta);
      return JSON.stringify({ frases: [{ i: 0, veredito: "contradiz", correcao: "30 dias" }] });
    });
    const conferencia = () =>
      criarConferenciaSemFonte({
        db: pool,
        organizationId: ORG,
        contactId: contato,
        fontes: [],
        lerMaterialDoTurno: () => [],
        chamarModelo: chamar,
      });
    const r = await conferencia().conferir("O prazo do recurso é de 60 dias.");
    expect(r).toMatchObject({ estado: "decidindo", chamou: true, falhou: false });
    expect(r.vetos).toEqual([
      { frase: "O prazo do recurso é de 60 dias.", tipo: "regra", veredito: "contradiz", correcao: "30 dias" },
    ]);
    expect(perguntas[0]).toContain("é de 30 dias, contados da ciência");
    expect(perguntas[0]).not.toContain("SENTINELA");

    await pool.query(
      `update organizations set settings = jsonb_build_object('conversa', jsonb_build_object('sem_fonte', jsonb_build_object('estado','desligada'))) where id = $1`,
      [ORG],
    );
    const desligada = await conferencia().conferir("O prazo do recurso é de 60 dias.");
    expect(desligada).toMatchObject({ estado: "desligada", chamou: false, vetos: [] });
    expect(chamar).toHaveBeenCalledTimes(1);
  });
});
