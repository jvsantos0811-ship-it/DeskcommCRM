import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { loadActiveRouter } from "@/lib/agent-engine/agent/router-config";
import { loadPublishedAgentConfigById } from "@/lib/agent-engine/agent/agent-config";
import { openCase } from "@/lib/agent-engine/agent/human-cases";
import {
  destinosDaPassagem,
  executarPassagemPelaFerramenta,
  lerPassagemDoTurno,
  nomesDosAgentes,
  turnoDaPassagemTemOQueFazer,
  type DependenciasDaPassagem,
} from "@/lib/agent-engine/agent/passagem-entre-agentes";
import { buscarJobParaCoalescer } from "@/lib/agent-engine/edge/crm/debounce";

/**
 * PC-014 — PASSAR A CONVERSA PARA OUTRO AGENTE DO ROTEADOR, contra o Postgres
 * do baseline. O código que decide roda de verdade
 * (`executarPassagemPelaFerramenta`, o roteador carregado do banco, a versão
 * publicada, `openCase`, a fila); só a nota da linha do tempo é dublê (ela é a
 * `emitAgentActivityForContact` de sempre, medida noutros arquivos).
 *
 * Critérios do pedido:
 *  - número com roteador: a Recepção passa → conversa grudada no destino,
 *    passagem registrada (ferramenta e telemetria do roteador), auditoria e o
 *    turno do DESTINO enfileirado, que fala sem o cliente escrever;
 *  - 3ª passagem na mesma hora → caso aberto para a equipe, sem passagem;
 *  - destino sem versão publicada → erro legível, nada muda;
 *  - conversa com pessoa da equipe → recusa, sem efeito;
 *  - o cartão sem telefone; a LGPD apaga cartão e motivo na anonimização;
 *  - a mensagem do cliente não pega carona no turno do destino.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

const ORG = "9015aaaa-0000-4000-8000-000000000001";
const SESSAO = "9015aaaa-0000-4000-8000-0000000000c1";
const ROTEADOR = "9015aaaa-0000-4000-8000-0000000000d1";
const RECEPCAO = "9015aaaa-0000-4000-8000-0000000000a1";
const RAQUEL = "9015aaaa-0000-4000-8000-0000000000a2";
const NEGADO = "9015aaaa-0000-4000-8000-0000000000a3";
const SEM_VERSAO = "9015aaaa-0000-4000-8000-0000000000a4";

let contato = "";
let conversa = "";
let mensagem = "";
let notas: string[] = [];

function deps(): DependenciasDaPassagem {
  return {
    nomeDeQuemPassa: "Recepção",
    versaoPublicada: (id) => loadPublishedAgentConfigById(pool, ORG, id),
    abrirCaso: (c) =>
      openCase(
        pool,
        { tenantId: ORG, conversationId: conversa, agentId: RECEPCAO },
        { title: c.title, summary: c.summary, blocker: c.blocker, kind: "outro" },
      ),
    anotarNoNegocio: async (cartao) => {
      notas.push(cartao);
    },
  };
}

async function contexto(agentId = RECEPCAO) {
  const router = (await loadActiveRouter(pool, ORG, SESSAO))!;
  const nomes = await nomesDosAgentes(pool, ORG, [RECEPCAO, RAQUEL, NEGADO, SEM_VERSAO]);
  return {
    organizationId: ORG,
    contactId: contato,
    conversationId: conversa,
    channelSessionId: SESSAO,
    agentId,
    router,
    destinos: destinosDaPassagem(router, agentId, nomes)!,
    inboundMessageId: mensagem,
    jobId: randomUUID(),
  };
}

const PAYLOAD = {
  intencao: "auxilio",
  motivo: "confirmou nome e benefício",
  cartao: {
    nome_confirmado: "Maria Souza (31) 99876-5432",
    quem_fala: "a própria",
    beneficio_e_situacao: "auxílio-acidente, negado em 2025",
    urgencia: "nenhuma",
    o_que_falta: "data do acidente",
    proximo_passo: "pedir os documentos",
    jeito_do_lead: "manda áudio",
  },
};

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,'pc014','PC014','PC014')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'pc014-sessao','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSAO, ORG],
  );
  for (const [ag, nome, publicar] of [
    [RECEPCAO, "Recepção", true],
    [RAQUEL, "Raquel", true],
    [NEGADO, "Especialista negado", true],
    [SEM_VERSAO, "Sem versão", false],
  ] as const) {
    await pool.query(
      `insert into ai_agents (id, organization_id, name, system_prompt) values ($1,$2,$3,'s') on conflict (id) do nothing`,
      [ag, ORG, nome],
    );
    if (publicar) {
      const versao = randomUUID();
      await pool.query(
        `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt, provider, model, status)
         values ($1,$2,$3,1,'s','anthropic','claude-sonnet-4-6','published')`,
        [versao, ORG, ag],
      );
      await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [versao, ag]);
    }
  }
  await pool.query(
    `insert into ai_routers (id, organization_id, name, channel_session_id, is_active, fallback_agent_id)
     values ($1,$2,'Bórbora',$3,true,$4)`,
    [ROTEADOR, ORG, SESSAO, RECEPCAO],
  );
  for (const [i, [ag, intencao]] of ([
    [RAQUEL, "auxilio"],
    [NEGADO, "beneficio_negado"],
    [SEM_VERSAO, "sem_versao"],
  ] as const).entries()) {
    await pool.query(
      `insert into ai_router_members (organization_id, router_id, agent_id, intent_name, intent_description, position)
       values ($1,$2,$3,$4,'x',$5)`,
      [ORG, ROTEADOR, ag, intencao, i],
    );
  }
});

beforeEach(async () => {
  notas = [];
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name) values ($1, 'Maria PC014') returning id`,
    [ORG],
  );
  contato = c[0]!.id;
  const { rows: v } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id) values ($1,$2,$3) returning id`,
    [ORG, contato, SESSAO],
  );
  conversa = v[0]!.id;
  mensagem = randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Sou eu, Maria, o auxílio foi negado','external_device', now() - interval '1 minute')`,
    [mensagem, ORG, conversa, SESSAO, contato],
  );
  // Os jobs que a mensagem possa ter gerado não são o que se mede aqui.
  await pool.query(`update job_queue set status = 'done' where organization_id = $1 and status = 'pending'`, [ORG]);
});

afterAll(async () => {
  await pool.end();
});

describe("PC-014 — passar a conversa para outro agente do roteador", () => {
  it("a Recepção passa para a Raquel: conversa grudada, passagem registrada e o turno da Raquel enfileirado", async () => {
    const ctx = await contexto();
    const res = await executarPassagemPelaFerramenta(pool, ctx, deps(), PAYLOAD);
    expect(res).toMatchObject({ ok: true, status: "passou", para: "Raquel" });

    const { rows: conv } = await pool.query(
      `select active_ai_agent_id, active_intent from conversations where id = $1`,
      [conversa],
    );
    expect(conv[0]).toEqual({ active_ai_agent_id: RAQUEL, active_intent: "auxilio" });

    const { rows: p } = await pool.query(
      `select id, origem, desfecho, de_agente_id, para_agente_id, cartao, turno_destino_job_id
         from passagens_entre_agentes where conversation_id = $1`,
      [conversa],
    );
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ origem: "ferramenta", desfecho: "passou", de_agente_id: RECEPCAO, para_agente_id: RAQUEL });
    expect(p[0].cartao.length).toBeLessThanOrEqual(600);
    expect(p[0].cartao).toContain("Nome confirmado: Maria Souza");
    expect(p[0].cartao).not.toMatch(/99876|5432/);
    expect(notas).toEqual([p[0].cartao]);

    const { rows: d } = await pool.query(
      `select outcome, agent_id, de_agente_id, passagem_id from ai_router_decisions where conversation_id = $1`,
      [conversa],
    );
    expect(d).toEqual([{ outcome: "passagem_agente", agent_id: RAQUEL, de_agente_id: RECEPCAO, passagem_id: p[0].id }]);

    const { rows: a } = await pool.query(
      `select action, metadata from api_audit_log where organization_id = $1 and resource_id = $2`,
      [ORG, conversa],
    );
    expect(a.map((x) => x.action)).toContain("ai.agent_passagem");

    const { rows: j } = await pool.query(
      `select id, kind, status, source_event_id, payload, run_after > now() as no_futuro
         from job_queue where organization_id = $1 and contact_id = $2 and status = 'pending'`,
      [ORG, contato],
    );
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ kind: "inbound_turn", source_event_id: p[0].id, no_futuro: true });
    expect(j[0].payload).toMatchObject({ passagem_id: p[0].id, conversation_id: conversa, inbound_message_id: mensagem });
    expect(p[0].turno_destino_job_id).toBe(j[0].id);

    // O turno do destino tem o que fazer: a conversa segue com a Raquel e ela não falou ainda.
    const lida = await lerPassagemDoTurno(pool, ORG, p[0].id);
    expect(lida?.clienteEscreveuDepois).toBe(false);
    expect(turnoDaPassagemTemOQueFazer(lida)).toBe(true);
  });

  it("a mensagem do cliente não pega carona no turno do destino; e o turno do destino vê que ela chegou", async () => {
    const ctx = await contexto();
    await executarPassagemPelaFerramenta(pool, ctx, deps(), PAYLOAD);
    expect(await buscarJobParaCoalescer(pool, { organizationId: ORG, contactId: contato })).toBeUndefined();

    await pool.query(
      `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, sent_via, sent_at)
       values ($1,$2,$3,$4,'text','inbound','delivered','oi?','external_device', now())`,
      [ORG, conversa, SESSAO, contato],
    );
    const { rows: p } = await pool.query(`select id from passagens_entre_agentes where conversation_id = $1`, [conversa]);
    expect((await lerPassagemDoTurno(pool, ORG, p[0].id))?.clienteEscreveuDepois).toBe(true);
  });

  it("a 3ª passagem na mesma hora não passa: abre caso para a equipe com o motivo 'passagem em laço'", async () => {
    expect((await executarPassagemPelaFerramenta(pool, await contexto(), deps(), PAYLOAD)).ok).toBe(true);
    expect(
      (await executarPassagemPelaFerramenta(pool, await contexto(RAQUEL), deps(), { ...PAYLOAD, intencao: "beneficio_negado" })).ok,
    ).toBe(true);

    const terceira = await executarPassagemPelaFerramenta(pool, await contexto(NEGADO), deps(), PAYLOAD);
    expect(terceira).toMatchObject({ ok: false, error: { code: "passagem_em_laco" } });

    const { rows: conv } = await pool.query(`select active_ai_agent_id from conversations where id = $1`, [conversa]);
    expect(conv[0].active_ai_agent_id).toBe(NEGADO);

    const { rows: casos } = await pool.query(
      `select title, blocker, status from agent_cases where conversation_id = $1`,
      [conversa],
    );
    expect(casos).toEqual([{ title: "Passagem em laço", blocker: "passagem em laço", status: "awaiting_human" }]);

    const { rows: p } = await pool.query(
      `select desfecho, count(*)::int as n from passagens_entre_agentes where conversation_id = $1 group by 1 order by 1`,
      [conversa],
    );
    expect(p).toEqual([
      { desfecho: "laco", n: 1 },
      { desfecho: "passou", n: 2 },
    ]);
  });

  it("destino sem versão publicada: erro legível, a conversa continua com quem atendia", async () => {
    const res = await executarPassagemPelaFerramenta(pool, await contexto(), deps(), { ...PAYLOAD, intencao: "sem_versao" });
    expect(res).toMatchObject({ ok: false, error: { code: "destino_sem_versao" } });
    if (!res.ok) expect(res.error.message).toContain("continua com você");
    const { rows } = await pool.query(`select count(*)::int as n from passagens_entre_agentes where conversation_id = $1`, [conversa]);
    expect(rows[0].n).toBe(0);
  });

  it("conversa com uma pessoa da equipe (bot calado): recusa, sem efeito", async () => {
    await pool.query(`update conversations set bot_silenced_until = 'infinity' where id = $1`, [conversa]);
    const res = await executarPassagemPelaFerramenta(pool, await contexto(), deps(), PAYLOAD);
    expect(res).toMatchObject({ ok: false, error: { code: "conversa_com_humano" } });
    const { rows } = await pool.query(
      `select (select count(*)::int from passagens_entre_agentes where conversation_id = $1) as passagens,
              (select count(*)::int from job_queue where contact_id = $2 and status = 'pending') as jobs`,
      [conversa, contato],
    );
    expect(rows[0]).toEqual({ passagens: 0, jobs: 0 });
    expect(notas).toEqual([]);
  });

  it("LGPD: anonimizar o contato apaga cartão e motivo da passagem; a linha fica", async () => {
    await executarPassagemPelaFerramenta(pool, await contexto(), deps(), PAYLOAD);
    await pool.query(`update contacts set is_anonymized = true, anonymized_at = now() where id = $1`, [contato]);
    const { rows } = await pool.query(
      `select cartao, motivo, para_agente_id from passagens_entre_agentes where conversation_id = $1`,
      [conversa],
    );
    expect(rows).toEqual([{ cartao: null, motivo: null, para_agente_id: RAQUEL }]);
  });
});
