import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import { pgComoSupabase } from "../pg-como-supabase";

/**
 * PC-003 — A TRAVA PELO TURNO REAL: a ferramenta nativa `update_lead_state` e
 * o texto do turno (harness de `turno-mudo-pede-uma-correcao.test.ts`, com o
 * cliente do CRM sobre o mesmo Postgres via `pgComoSupabase`).
 *
 * - A4: `update_lead_state` com `won` → recusado, mesmo com a chave LIGADA;
 * - A1/A3: o passo que leva o card a uma etapa com campo de qualificação sem
 *   resposta → a recusa volta ao MODELO ("Não dá para mover para …: faltam os
 *   campos …"), o funil do agente NÃO avança e a recusa fica registrada;
 * - A5: chave DESLIGADA → a ferramenta e a instrução saem do turno;
 * - A10: o texto do turno traz os campos do negócio com status.
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

const ORG = "ee0d9011-0000-4000-8000-000000000001";
const CONTACT = "ee0d9011-0000-4000-8000-000000000002";
const SESSION = "ee0d9011-0000-4000-8000-000000000003";
const CONV = "ee0d9011-0000-4000-8000-000000000004";
// Sessão COM casos humanos ligados (agente publicado `cases_enabled=true`) — os
// cenários de falha medem se o caso abre; a sessão base fica sem agente nenhum.
const SESSION_CASOS = "ee0d9011-0000-4000-8000-000000000005";
const AGENT_CASOS = "ee0d9011-0000-4000-8000-000000000006";
const VERSION_CASOS = "ee0d9011-0000-4000-8000-000000000007";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: string[] = [];

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const texto = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
const enviar = (body: string) => ({
  content: [
    { type: "tool-call" as const, toolCallId: `c-${Math.random()}`, toolName: "send_message", input: JSON.stringify({ body }) },
  ],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
const FECHAMENTO = JSON.stringify({ commitments: [], objections: [], next_action: null, rolling_summary: "t" });

/** Uma etapa com VÁRIAS ferramentas em paralelo — o desenho do caso AD4. */
const ferramentas = (...chamadas: Array<{ nome: string; args: unknown }>) => ({
  content: chamadas.map((c) => ({
    type: "tool-call" as const,
    toolCallId: `c-${Math.random()}`,
    toolName: c.nome,
    input: JSON.stringify(c.args),
  })),
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: USO,
  warnings: [],
});

type Resposta =
  | ReturnType<typeof texto>
  | ReturnType<typeof enviar>
  | ReturnType<typeof ferramentas>;

/** Roteiro por chamada; guarda o prompt de cada uma para conferir a correção. */
function modelo(roteiro: Resposta[]) {
  const prompts: string[] = [];
  const ferramentasOferecidas: string[][] = [];
  let passo = 0;
  const fake = async (options: { prompt: unknown; tools?: Array<{ name: string }> }) => {
    prompts.push(JSON.stringify(options.prompt));
    if (options.tools?.some((t) => t.name === "send_message")) ferramentasOferecidas.push(options.tools.map((t) => t.name));
    // Classificadores auxiliares e o fechamento não recebem `send_message`:
    // só a chamada do AGENTE consome o roteiro.
    if (!options.tools?.some((t) => t.name === "send_message")) return texto(FECHAMENTO);
    passo += 1;
    return roteiro[passo - 1] ?? texto("ok");
  };
  return { fake, prompts, ferramentasOferecidas };
}

async function turno(
  fake: ReturnType<typeof modelo>["fake"],
  opts: { sessao?: string; conversa?: string } = {},
): Promise<void> {
  const sessao = opts.sessao ?? SESSION;
  const conversa = opts.conversa ?? CONV;
  if (conversa !== CONV) {
    // Conversa própria de cenário: mesma org/contato, sessão com casos ligados.
    await pool.query(
      `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
       values ($1,$2,$3,$4,'ai_handling',false) on conflict (id) do nothing`,
      [conversa, ORG, CONTACT, sessao],
    );
  }
  const msg = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',now(),now())`,
    [msg, ORG, conversa, sessao, CONTACT, "Juan Pérez, barrio Centro, portón verde, a las 12"],
  );
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: conversa,
      contact_id: CONTACT,
      channel_session_id: sessao,
      inbound_message_id: msg,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "pc003", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  const handler = m.createInboundTurnHandler({
    crmCfg: { supabase: pgComoSupabase(pool) },
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
    registry: m.createFakeRegistry(fake as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (input: { body: string }) => {
          enviados.push(input.body);
          return { kind: "sent" as const, idempotencyKey: `k${enviados.length}`, messageId: `m${enviados.length}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
  await handler(claimed!, pool, { workerId: "pc003" });
  await m.queue.completeJob(pool, claimed!.id, "pc003");
}

/** Casos humanos abertos na conversa — o que os cenários de falha medem. */
async function contarCasos(conversa: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from agent_cases where organization_id = $1 and conversation_id = $2`,
    [ORG, conversa],
  );
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn")).createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'pc-003-turno','PC 003 turno','PC 003 turno') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'pc-003-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  // Sessão COM casos humanos ligados: `cases_enabled` vem false por padrão e a
  // régua `casesEnabled` gateia o openCase do desfecho terminal — sem este
  // agente publicado nenhum cenário de falha abre caso (mesmo fixture do
  // agent-config-cases.test.ts).
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'pc-003-casos-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION_CASOS, ORG],
  );
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt)
     values ($1, $2, 'Agente com casos', 'system') on conflict (id) do nothing`,
    [AGENT_CASOS, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions
       (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, cases_enabled)
     values ($1, $2, $3, 1, 'system', 'anthropic', 'claude-sonnet-4-6', $4, 'published', true)
     on conflict (id) do nothing`,
    [VERSION_CASOS, ORG, AGENT_CASOS, SESSION_CASOS],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [
    VERSION_CASOS,
    AGENT_CASOS,
  ]);
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
  enviados = [];
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.query("delete from conversations where organization_id = $1", [ORG]);
  await pool.query("delete from contacts where organization_id = $1", [ORG]);
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1,$2,'Cliente de teste','+5511900009013')`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [CONV, ORG, CONTACT, SESSION],
  );
});

afterAll(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.end();
});



const AGENTE = "ee0d9011-0000-4000-8000-0000000000a1";
const VERSAO = "ee0d9011-0000-4000-8000-0000000000a2";
const SESSAO_FUNIL = "ee0d9011-0000-4000-8000-0000000000a3";
let pipeline = "";
let etapaNovo = "";
let etapaQualificado = "";

async function prepararNegocio(status: Record<string, string>) {
  await pool.query(`delete from crm_leads where organization_id = $1`, [ORG]);
  await pool.query(`delete from lead_state where organization_id = $1`, [ORG]);
  await pool.query(`delete from recusas_da_ia where organization_id = $1`, [ORG]);
  await pool.query(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, custom_fields, status_dos_campos)
     values ($1,$2,$3,$4,'Auxílio','{"categoria":"empregado"}',$5::jsonb)`,
    [ORG, pipeline, etapaNovo, CONTACT, JSON.stringify(status)],
  );
  await pool.query(
    `insert into lead_state (organization_id, contact_id, stage) values ($1,$2,'qualifying')`,
    [ORG, CONTACT],
  );
}

async function estadoDoFunilDoAgente(): Promise<string> {
  const { rows } = await pool.query<{ stage: string }>(
    `select stage from lead_state where organization_id = $1 and contact_id = $2`,
    [ORG, CONTACT],
  );
  return rows[0]!.stage;
}

const AGENTE_OFF = "ee0d9011-0000-4000-8000-0000000000b1";
const VERSAO_OFF = "ee0d9011-0000-4000-8000-0000000000b2";
const SESSAO_OFF = "ee0d9011-0000-4000-8000-0000000000b3";

beforeAll(async () => {
  // O funil ANTES dos agentes: versão publicada é imutável, então o escopo
  // (`pipeline_ids`) nasce no INSERT.
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position) values ($1,'Auxílio','auxilio-turno',100) returning id`,
    [ORG],
  );
  pipeline = p[0]!.id;
  const { rows: s1 } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position, agent_stage_hint)
     values ($1,$2,'Novo contato','novo-turno',1,'qualifying') returning id`,
    [ORG, pipeline],
  );
  etapaNovo = s1[0]!.id;
  const { rows: s2 } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position, agent_stage_hint)
     values ($1,$2,'Qualificado','qualificado-turno',2,'qualified') returning id`,
    [ORG, pipeline],
  );
  etapaQualificado = s2[0]!.id;
  await pool.query(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position, is_won, agent_stage_hint)
     values ($1,$2,'Fechado','fechado-turno',3,true,'won')`,
    [ORG, pipeline],
  );
  const settings = {
    fields: [
      { key: "categoria", label: "Categoria na data", type: "text", com_status: true, obrigatorio_em: { etapas: [etapaQualificado] } },
    ],
  };
  await pool.query(`update crm_pipelines set settings = $2::jsonb where id = $1`, [pipeline, JSON.stringify(settings)]);

  for (const [ag, ve, sessao, ligado] of [
    [AGENTE, VERSAO, SESSAO_FUNIL, true],
    [AGENTE_OFF, VERSAO_OFF, SESSAO_OFF, false],
  ] as const) {
    await pool.query(
      `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1,$2,$3,'WORKING','\\x00'::bytea) on conflict (id) do nothing`,
      [sessao, ORG, `pc-003-${ligado ? "on" : "off"}-session`],
    );
    await pool.query(
      `insert into ai_agents (id, organization_id, name, system_prompt) values ($1,$2,$3,'s') on conflict (id) do nothing`,
      [ag, ORG, `Agente do funil ${ligado ? "on" : "off"}`],
    );
    await pool.query(
      `insert into ai_agent_versions
         (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status,
          estado_do_funil_ligado, pipeline_ids)
       values ($1,$2,$3,1,'s','anthropic','claude-sonnet-4-6',$4,'published',$5,array[$6::uuid]) on conflict (id) do nothing`,
      [ve, ORG, ag, sessao, ligado, pipeline],
    );
    await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [ve, ag]);
  }
});

describe("PC-003 pelo turno real", () => {
  it("⭐ A4: `update_lead_state` com won → recusado e registrado; o funil do agente não fecha", async () => {
    await prepararNegocio({ categoria: "CONFIRMADO" });
    const { fake, prompts } = modelo([
      ferramentas({ nome: "update_lead_state", args: { stage: "won" } }),
      enviar("Certo, sigo com você."),
      texto("ok"),
    ]);
    const conversa = crypto.randomUUID();
    await turno(fake, { sessao: SESSAO_FUNIL, conversa });
    expect(prompts.some((p) => p.includes("ganho_so_por_assinatura"))).toBe(true);
    expect(await estadoDoFunilDoAgente()).toBe("qualifying");
    const { rows } = await pool.query(
      `select tipo, ferramenta, codigo from recusas_da_ia where organization_id = $1`,
      [ORG],
    );
    expect(rows).toEqual([{ tipo: "ganho_recusado", ferramenta: "update_lead_state", codigo: "ganho_so_por_assinatura" }]);
  });

  it("⭐ A1/A3: passo que exige campo sem resposta → a recusa volta ao modelo e o funil do agente NÃO avança", async () => {
    await prepararNegocio({ categoria: "NAO_SABE" });
    const { fake, prompts } = modelo([
      ferramentas({ nome: "update_lead_state", args: { stage: "qualified" } }),
      enviar("Me confirma uma coisa: você trabalhava registrado na data do acidente?"),
      texto("ok"),
    ]);
    const conversa = crypto.randomUUID();
    await turno(fake, { sessao: SESSAO_FUNIL, conversa });
    expect(prompts.some((p) => p.includes('Não dá para mover para \\"Qualificado\\": faltam os campos Categoria na data.'))).toBe(true);
    expect(await estadoDoFunilDoAgente()).toBe("qualifying");
    const { rows } = await pool.query<{ stage_id: string }>(`select stage_id from crm_leads where organization_id = $1`, [ORG]);
    expect(rows[0]!.stage_id).toBe(etapaNovo);
    const { rows: r } = await pool.query(
      `select tipo, ferramenta, codigo from recusas_da_ia where organization_id = $1`,
      [ORG],
    );
    expect(r).toEqual([{ tipo: "etapa_recusada", ferramenta: "update_lead_state", codigo: "required_fields_missing" }]);
  });

  it("controle A2: com a resposta CONFIRMADA o passo avança e o card anda", async () => {
    await prepararNegocio({ categoria: "CONFIRMADO" });
    const { fake } = modelo([
      ferramentas({ nome: "update_lead_state", args: { stage: "qualified" } }),
      enviar("Perfeito, anotado."),
      texto("ok"),
    ]);
    await turno(fake, { sessao: SESSAO_FUNIL, conversa: crypto.randomUUID() });
    expect(await estadoDoFunilDoAgente()).toBe("qualified");
    const { rows } = await pool.query<{ stage_id: string }>(`select stage_id from crm_leads where organization_id = $1`, [ORG]);
    expect(rows[0]!.stage_id).toBe(etapaQualificado);
  });

  it("⭐ A10: o texto do turno traz os campos do negócio com status", async () => {
    await prepararNegocio({ categoria: "NAO_SABE" });
    const { fake, prompts } = modelo([enviar("Oi!"), texto("ok")]);
    await turno(fake, { sessao: SESSAO_FUNIL, conversa: crypto.randomUUID() });
    expect(prompts[0]).toContain("## Campos do negócio (etapa atual: Novo contato)");
    expect(prompts[0]).toContain("- Categoria na data: NAO_SABE — empregado");
  });

  it("⭐ A5: chave DESLIGADA → a ferramenta e a instrução saem do turno", async () => {
    await prepararNegocio({ categoria: "CONFIRMADO" });
    const { fake, prompts, ferramentasOferecidas } = modelo([enviar("Oi!"), texto("ok")]);
    await turno(fake, { sessao: SESSAO_OFF, conversa: crypto.randomUUID() });
    expect(ferramentasOferecidas[0]).not.toContain("update_lead_state");
    expect(prompts[0]).not.toContain("Marque-o com update_lead_state");
  });

  it("controle A5: chave LIGADA → a ferramenta está no turno", async () => {
    await prepararNegocio({ categoria: "CONFIRMADO" });
    const { fake, ferramentasOferecidas } = modelo([enviar("Oi!"), texto("ok")]);
    await turno(fake, { sessao: SESSAO_FUNIL, conversa: crypto.randomUUID() });
    expect(ferramentasOferecidas[0]).toContain("update_lead_state");
  });
});
