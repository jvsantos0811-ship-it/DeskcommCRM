import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * PC-002b — A TRAVA DE PROMESSA DE HUMANO E A FRASE SEGURA, pelo turno real
 * (handler de `inbound_turn`) e o Postgres do baseline.
 *
 * O caso medido (28/10/2026, AUD-002, AD4): um lead com benefício acabando
 * escreveu; a IA abriu o caso e escreveu "a equipe assume às 8h" na MESMA
 * etapa. O SDK roda as ferramentas da etapa em paralelo, a trava de promessa de
 * humano (`case_promise`) não via o caso que estava sendo gravado e derrubava a
 * mensagem inteira — o lead ficava mudo, com prazo correndo.
 *
 * O que se mede (o harness é o de `turno-mudo-pede-uma-correcao.test.ts`):
 * - F1-j / AD4: caso + promessa na MESMA etapa → a mensagem SAI e o caso existe;
 * - F1-k: trava de conteúdo que não solta (afirmação clínica) → o cliente
 *   recebe a FRASE SEGURA, há caso para a equipe e uma linha em `recusas_da_ia`;
 * - controle: contato que pediu para parar (`stop`) → nada sai, nem a frase.
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

const ORG = "ee0d0b2b-0000-4000-8000-000000000001";
const CONTACT = "ee0d0b2b-0000-4000-8000-000000000002";
const SESSION = "ee0d0b2b-0000-4000-8000-000000000003";
const CONV = "ee0d0b2b-0000-4000-8000-000000000004";
// Sessão COM casos humanos ligados (agente publicado `cases_enabled=true`) — os
// cenários de falha medem se o caso abre; a sessão base fica sem agente nenhum.
const SESSION_CASOS = "ee0d0b2b-0000-4000-8000-000000000005";
const AGENT_CASOS = "ee0d0b2b-0000-4000-8000-000000000006";
const VERSION_CASOS = "ee0d0b2b-0000-4000-8000-000000000007";

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
  let passo = 0;
  const fake = async (options: { prompt: unknown; tools?: Array<{ name: string }> }) => {
    prompts.push(JSON.stringify(options.prompt));
    // Classificadores auxiliares e o fechamento não recebem `send_message`:
    // só a chamada do AGENTE consome o roteiro.
    if (!options.tools?.some((t) => t.name === "send_message")) return texto(FECHAMENTO);
    passo += 1;
    return roteiro[passo - 1] ?? texto("ok");
  };
  return { fake, prompts };
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
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "pc002b", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  const handler = m.createInboundTurnHandler({
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
  await handler(claimed!, pool, { workerId: "pc002b" });
  await m.queue.completeJob(pool, claimed!.id, "pc002b");
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
     values ($1,'pc-002b','PC 002b','PC 002b') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'pc-002b-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  // Sessão COM casos humanos ligados: `cases_enabled` vem false por padrão e a
  // régua `casesEnabled` gateia o openCase do desfecho terminal — sem este
  // agente publicado nenhum cenário de falha abre caso (mesmo fixture do
  // agent-config-cases.test.ts).
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'pc-002b-casos-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
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
    `insert into contacts (id, organization_id, name, phone_number) values ($1,$2,'Cliente de teste','+5511900000622')`,
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


const FRASE_PADRAO = "Recebi sua mensagem e já estou cuidando disso, um instante.";
const PROMESSA = "Já registrei seu caso. A equipe vai assumir às 8h e falar com você por aqui.";
const CLINICA = "Pela foto, você tem uma micose de unha. Passe uma pomada antifúngica.";

async function recusas(conversa: string) {
  const { rows } = await pool.query<{ tipo: string; trava: string; codigo: string }>(
    `select tipo, trava, codigo from recusas_da_ia where organization_id = $1 and conversation_id = $2`,
    [ORG, conversa],
  );
  return rows;
}

describe("PC-002b — a trava de promessa de humano vê o caso do MESMO turno", () => {
  it("⭐ AD4: abrir o caso e prometer a equipe na MESMA etapa — a mensagem sai", async () => {
    const { fake } = modelo([
      ferramentas(
        {
          nome: "open_human_case",
          args: {
            title: "Benefício acabando",
            summary: "Lead com benefício que acaba em poucos dias.",
            blocker: "Precisa de análise da equipe.",
            kind: "problema",
          },
        },
        { nome: "send_message", args: { body: PROMESSA } },
      ),
      texto("ok"),
    ]);
    const conversa = crypto.randomUUID();
    await turno(fake, { sessao: SESSION_CASOS, conversa });

    expect(enviados, "o lead com prazo correndo ficou sem resposta").toEqual([PROMESSA]);
    expect(await contarCasos(conversa)).toBe(1);
    expect(await recusas(conversa), "a mensagem saiu: não há bloqueio a registrar").toEqual([]);
  });
});

describe("PC-002b — trava que barra a mensagem inteira nunca deixa o cliente mudo", () => {
  it("⭐ F1-k: afirmação clínica insistente → frase segura, caso aberto e registro na aba Execuções", async () => {
    await pool.query(
      `insert into org_guardrail_layers (organization_id, layer, enabled) values ($1, 'afirmacao_clinica', true)
       on conflict (organization_id, layer) do update set enabled = true`,
      [ORG],
    );
    try {
      const { fake } = modelo([enviar(CLINICA), enviar(CLINICA), texto("(desisto)")]);
      const conversa = crypto.randomUUID();
      await turno(fake, { sessao: SESSION_CASOS, conversa });

      expect(enviados, "a afirmação clínica não pode sair").not.toContain(CLINICA);
      expect(enviados, "o cliente ficou mudo depois do bloqueio").toEqual([FRASE_PADRAO]);
      expect(await contarCasos(conversa), "a equipe precisa de um caso com o texto barrado").toBe(1);
      const linhas = await recusas(conversa);
      expect(linhas).toHaveLength(1);
      expect(linhas[0]).toMatchObject({ tipo: "envio_bloqueado", trava: "clinical_claim", codigo: "clinical_claim" });
    } finally {
      await pool.query(`delete from org_guardrail_layers where organization_id = $1`, [ORG]);
    }
  });

  it("a frase configurada pela organização é a que sai", async () => {
    await pool.query(
      `insert into org_guardrail_layers (organization_id, layer, enabled) values ($1, 'afirmacao_clinica', true)
       on conflict (organization_id, layer) do update set enabled = true`,
      [ORG],
    );
    await pool.query(
      `update organizations set settings = coalesce(settings, '{}'::jsonb) || '{"frase_segura": "Recebi! Já te respondo."}'::jsonb where id = $1`,
      [ORG],
    );
    try {
      const { fake } = modelo([enviar(CLINICA), enviar(CLINICA), texto("(desisto)")]);
      const conversa = crypto.randomUUID();
      await turno(fake, { sessao: SESSION_CASOS, conversa });
      expect(enviados).toEqual(["Recebi! Já te respondo."]);
    } finally {
      await pool.query(`update organizations set settings = settings - 'frase_segura' where id = $1`, [ORG]);
      await pool.query(`delete from org_guardrail_layers where organization_id = $1`, [ORG]);
    }
  });

  it("controle: contato que pediu para parar — nada sai, nem a frase segura", async () => {
    await pool.query(`update contacts set is_blocked = true where id = $1`, [CONTACT]);
    const { fake } = modelo([enviar("Oi! Posso ajudar?"), texto("ok")]);
    await turno(fake);
    expect(enviados).toEqual([]);
  });
});

describe("PC-002b, item 7 — fila vazia com 'IA volta sozinha' ligada", () => {
  const FRASE_DA_FILA = "Sua mensagem ficou registrada e a equipe responde no próximo horário de atendimento.";
  const PASSAR = ferramentas({ nome: "request_human_handoff", args: { por_que: "Lead pediu para falar com uma pessoa." } });

  async function estado() {
    const { rows } = await pool.query<{ force_human: boolean; silenciada: string | null; na_fila: boolean }>(
      `select ct.force_human, cv.bot_silenced_until::text as silenciada, (cv.metadata ? 'ia_na_fila') as na_fila
         from contacts ct join conversations cv on cv.contact_id = ct.id and cv.id = $2
        where ct.organization_id = $1 and ct.id = $3`,
      [ORG, CONV, CONTACT],
    );
    return rows[0]!;
  }
  async function passagens(): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from passagens_de_atendimento where organization_id = $1 and conversation_id = $2`,
      [ORG, CONV],
    );
    return rows[0]?.n ?? 0;
  }

  it("⭐ F1-p: o lead recebe a frase da organização e a próxima mensagem dele é respondida pela IA", async () => {
    await pool.query(
      `update organizations set settings = coalesce(settings, '{}'::jsonb)
         || jsonb_build_object('frase_da_fila', $2::text, 'routing', jsonb_build_object('handoff_return_after_minutes', 30))
       where id = $1`,
      [ORG, FRASE_DA_FILA],
    );
    try {
      // Turno 1: a IA passa para a equipe sem falar nada — o piso manda o aviso.
      await turno(modelo([PASSAR, texto("ok")]).fake);
      expect(enviados).toHaveLength(1);
      expect(enviados[0], "o aviso tem de terminar com a frase da fila da organização").toMatch(
        new RegExp(`${FRASE_DA_FILA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      );
      const depois = await estado();
      expect(depois.force_human, "ninguém pode assumir: a IA não pode ser calada").toBe(false);
      expect(depois.silenciada).toBeNull();
      expect(depois.na_fila).toBe(true);
      expect(await passagens(), "a equipe tem de ser avisada mesmo assim").toBe(1);

      // Turno 2: o lead escreve de novo; a IA pede a passagem outra vez e responde.
      enviados = [];
      await turno(modelo([PASSAR, enviar("Claro! Enquanto isso, me conta o que aconteceu?"), texto("ok")]).fake);
      expect(enviados, "a próxima mensagem do lead tem de ser respondida pela IA").toEqual([
        "Claro! Enquanto isso, me conta o que aconteceu?",
      ]);
      expect(await passagens(), "pedido repetido não abre outra passagem").toBe(1);
    } finally {
      await pool.query(`update organizations set settings = settings - 'frase_da_fila' - 'routing' where id = $1`, [ORG]);
    }
  });

  it("controle: sem 'IA volta sozinha', a passagem cala a IA como sempre", async () => {
    await turno(modelo([PASSAR, texto("ok")]).fake);
    expect(enviados).toHaveLength(1);
    const depois = await estado();
    expect(depois.force_human).toBe(true);
    expect(depois.na_fila).toBe(false);
    enviados = [];
    await turno(modelo([enviar("Oi de novo"), texto("ok")]).fake);
    expect(enviados).toEqual([]);
  });
});
