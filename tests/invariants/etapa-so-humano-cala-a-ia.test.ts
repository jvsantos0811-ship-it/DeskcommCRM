import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * NEGÓCIO NUMA ETAPA "SÓ ATENDIMENTO HUMANO" CALA A IA E CHAMA A EQUIPE.
 *
 * `crm_stages.requires_human` só era lida pelo worker legado, que não responde
 * ninguém desde a v1.17.0: com o negócio em "Análise humana", o agente
 * publicado seguia falando com o cliente. A regra e o porquê estão em
 * `lib/agent-engine/agent/etapa-exige-humano.ts` (migration 9005 do fork).
 *
 * O caso de aceite, pelo handler REAL de `inbound_turn` contra o `baseline.sql`:
 * o cliente escreve com o negócio na etapa marcada → o modelo não é chamado,
 * sai só o aviso de que uma pessoa vai continuar, e a conversa vai para uma
 * pessoa — `force_human`, conversa
 * silenciada, aviso na Central com o nome da etapa e a linha da passagem com
 * origem `etapa_do_funil`. Os controles: a mesma etapa sem a marca, e o negócio
 * já GANHO na etapa marcada, deixam a IA responder.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "e7a90000-0000-4000-8000-000000000001";
const CONTACT = "e7a90000-0000-4000-8000-000000000002";
const SESSION = "e7a90000-0000-4000-8000-000000000003";
const CONV = "e7a90000-0000-4000-8000-000000000004";
const FUNIL = "e7a90000-0000-4000-8000-000000000005";
const ETAPA_IA = "e7a90000-0000-4000-8000-000000000006";
const ETAPA_HUMANA = "e7a90000-0000-4000-8000-000000000007";
const ETAPA_GANHO = "e7a90000-0000-4000-8000-000000000008";
const NOME_DA_ETAPA = "Análise humana";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let modeloChamado = 0;
let enviados = 0;

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function montaHandler() {
  return m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 12,
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry((async () => {
      modeloChamado += 1;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              commitments: [],
              objections: [],
              next_action: null,
              rolling_summary: "turno de teste",
            }),
          },
        ],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }) as never),
    channel: () =>
      ({
        channel: "captura",
        send: async () => {
          enviados += 1;
          return { kind: "sent" as const, idempotencyKey: `k${enviados}`, messageId: `m${enviados}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    // Dentro da janela anti-ban (7h-22h BRT), como os vizinhos.
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
}

/** Grava a inbound do cliente e roda o handler real de `inbound_turn` sobre ela. */
async function clienteEscreve(texto: string): Promise<void> {
  const msgId = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',now(),now())`,
    [msgId, ORG, CONV, SESSION, CONTACT, texto],
  );
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: msgId,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "etapa", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await montaHandler()(claimed!, pool, { workerId: "etapa" });
    await m.queue.completeJob(pool, claimed!.id, "etapa");
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "etapa", err);
    throw err;
  }
}

async function negocioEm(etapa: string, status: "open" | "won" = "open"): Promise<void> {
  await pool.query(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, status, closed_at)
     values ($1,$2,$3,$4,'Salário-maternidade',$5, case when $5 = 'open' then null else now() end)`,
    [ORG, FUNIL, etapa, CONTACT, status],
  );
}

async function estadoDoHandoff() {
  const contato = await pool.query<{ force_human: boolean }>(
    "select force_human from contacts where organization_id = $1 and id = $2",
    [ORG, CONTACT],
  );
  const conversa = await pool.query<{ silenciada: boolean }>(
    `select (bot_silenced_until is not null and bot_silenced_until > now()) as silenciada
       from conversations where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
  const avisos = await pool.query<{ title: string }>(
    `select title from agent_inbox_items
      where organization_id = $1 and kind = 'handoff' and ref_kind = 'conversation' and ref_id = $2 and status = 'open'`,
    [ORG, CONV],
  );
  const passagens = await pool.query<{ origem: string; motivo_codigo: string }>(
    "select origem, motivo_codigo from passagens_de_atendimento where organization_id = $1 and conversation_id = $2",
    [ORG, CONV],
  );
  return {
    forceHuman: contato.rows[0]?.force_human === true,
    silenciada: conversa.rows[0]?.silenciada === true,
    avisos: avisos.rows.map((r) => r.title),
    passagens: passagens.rows,
  };
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'etapa-so-humano','Etapa Só Humano','Etapa Só Humano') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'etapa-so-humano-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug, position)
     values ($1,$2,'Gestantes','gestantes-etapa-so-humano',1000) on conflict (id) do nothing`,
    [FUNIL, ORG],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position, requires_human, is_won)
     values ($1,$2,$3,'Triagem IA','triagem-ia',1000,false,false),
            ($4,$2,$3,$5,'analise-humana',2000,true,false),
            ($6,$2,$3,'Contratado','contratado',3000,true,true)
     on conflict (id) do nothing`,
    [ETAPA_IA, ORG, FUNIL, ETAPA_HUMANA, NOME_DA_ETAPA, ETAPA_GANHO],
  );
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
});

beforeEach(async () => {
  modeloChamado = 0;
  enviados = 0;
  await pool.query("delete from passagens_de_atendimento where organization_id = $1", [ORG]);
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from crm_lead_activities where organization_id = $1", [ORG]);
  await pool.query("delete from crm_leads where organization_id = $1", [ORG]);
  await pool.query("delete from conversations where organization_id = $1", [ORG]);
  await pool.query("delete from contacts where organization_id = $1", [ORG]);
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Gestante de teste','+5531900000777')`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [CONV, ORG, CONTACT, SESSION],
  );
});

describe("etapa só atendimento humano, no turno real do agent-engine", () => {
  it("negócio aberto na etapa marcada: a IA não responde e a conversa vai para uma pessoa", async () => {
    await negocioEm(ETAPA_HUMANA);

    await clienteEscreve("Oi, já mandei os documentos");

    expect(modeloChamado, "o modelo foi chamado com o negócio numa etapa só humana").toBe(0);
    // Uma mensagem só: o AVISO de que uma pessoa vai continuar ("nenhuma passagem
    // sai calada"). Resposta da IA, nenhuma.
    expect(enviados, "o cliente que escreveu tem de ser avisado, e só avisado").toBe(1);
    const estado = await estadoDoHandoff();
    expect(estado.forceHuman).toBe(true);
    expect(estado.silenciada).toBe(true);
    expect(estado.avisos).toHaveLength(1);
    expect(estado.avisos[0]).toContain(NOME_DA_ETAPA);
    expect(estado.passagens).toEqual([{ origem: "etapa_do_funil", motivo_codigo: "critical_stage" }]);
  });

  it("a segunda mensagem não abre outro aviso: o turno já para no veto de handoff", async () => {
    await negocioEm(ETAPA_HUMANA);

    await clienteEscreve("Oi");
    await clienteEscreve("Alguém aí?");

    expect(modeloChamado).toBe(0);
    expect(enviados, "o aviso sai uma vez, na passagem — não a cada mensagem").toBe(1);
    const estado = await estadoDoHandoff();
    expect(estado.avisos).toHaveLength(1);
    expect(estado.passagens).toHaveLength(1);
  });

  it("controle: negócio numa etapa sem a marca — a IA responde", async () => {
    await negocioEm(ETAPA_IA);

    await clienteEscreve("Oi, tenho uma dúvida");

    expect(modeloChamado, "sem o modelo, o caso de aceite acima seria vazio").toBeGreaterThan(0);
    const estado = await estadoDoHandoff();
    expect(estado.forceHuman).toBe(false);
    expect(estado.passagens).toEqual([]);
  });

  it("controle: negócio GANHO numa etapa marcada não conta — só negócio aberto cala a IA", async () => {
    await negocioEm(ETAPA_GANHO, "won");

    await clienteEscreve("Obrigada!");

    expect(modeloChamado).toBeGreaterThan(0);
    expect((await estadoDoHandoff()).forceHuman).toBe(false);
  });
});
