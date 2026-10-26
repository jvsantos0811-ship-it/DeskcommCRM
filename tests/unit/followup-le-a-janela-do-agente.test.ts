/**
 * AS LEITURAS INTERNAS DO FLUXO USAM A JANELA DE HISTÓRICO DO AGENTE.
 *
 * O turno de resposta lê a conversa com a janela que a tela grava por agente
 * (`history_message_window` / `history_token_window`, via `turnContextKnobs`).
 * A mensagem que a IA escreve no follow-up passa pelo mesmo `runAgentTurn` e já
 * herdava essa janela. As duas leituras que o FLUXO faz por conta própria —
 * classificar a resposta (`purpose: classify`) e planejar as esperas
 * (`purpose: plan_timing`) — liam os knobs da INSTALAÇÃO (20 mensagens, 1.000
 * tokens), e um agente configurado para 60 mensagens via o fluxo decidir com um
 * terço disso.
 *
 * O caso de aceite do briefing: agente 60/20.000 → o follow-up carrega 60/20.000.
 * Sem agente publicado, a instalação segue sendo a fonte. Com janela menor que
 * a da instalação, vale o piso: o classificador é do motor e não pode ficar cego.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AgentConfig from "@/lib/agent-engine/agent/agent-config";
import type * as GetLeadContext from "@/lib/agent-engine/edge/crm/get-lead-context";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const getLeadContext = vi.fn();
const runModelCall = vi.fn();
const loadConversationAgentConfig = vi.fn();

vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", async (original) => ({
  ...(await original<typeof GetLeadContext>()),
  getLeadContext,
}));
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({ runModelCall }));
vi.mock("@/lib/agent-engine/agent/agent-config", async (original) => ({
  ...(await original<typeof AgentConfig>()),
  loadConversationAgentConfig,
}));

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";
const boundary = {
  organization_id: ORG,
  contact_id: LEAD,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

const INSTALACAO = { historyLimit: 20, maxContextTokens: 1_000 };

function jobDe(payload: Record<string, unknown>): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: LEAD,
    kind: "followup_turn",
    source_event_id: null,
    payload: {
      service_boundary: boundary,
      followup_enrollment_id: "7d4f1c2a-0b1e-4c5d-9e8f-1a2b3c4d5e6f",
      node_id: "c1",
      ...payload,
    },
    status: "running",
    priority: 0,
    run_after: new Date(),
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    locked_by: "w1",
    locked_at: new Date(),
    created_at: new Date(),
  } as JobRow;
}

const CLASSIFICAR = jobDe({ purpose: "classify", classes: ["quer", "não quer"] });
const PLANEJAR = jobDe({
  purpose: "plan_timing",
  waits: [{ node_id: "w1", label: "espera", min_ms: 3_600_000, max_ms: 86_400_000 }],
});

const pool = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes("d.fechada_em::text")) {
      return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    }
    if (/from conversations c/.test(sql)) return { rows: [{ channel_session_id: CANAL, archived_at: null }] };
    if (sql.includes("select current_node_id, status from followup_enrollments")) {
      return { rows: [{ current_node_id: "c1", status: "active" }] };
    }
    return { rows: [] };
  }),
} as never;

const complete = vi.fn(async () => undefined);
let run: (job: JobRow, pool: never, ctx: { workerId: string }) => Promise<void>;

beforeAll(async () => {
  const { createFollowupTurnHandler } = await import("@/lib/agent-engine/agent/followup-turn");
  run = createFollowupTurnHandler({
    knobs: INSTALACAO,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    completeFollowupTurn: complete,
  } as never);
}, 60_000);

beforeEach(() => {
  complete.mockClear();
  runModelCall.mockReset();
  getLeadContext.mockReset();
  loadConversationAgentConfig.mockReset();
  // Contexto sem resposta nova: o classify termina em `awaiting_reply` sem modelo,
  // e o que interessa aqui é com que janela a conversa foi lida.
  getLeadContext.mockResolvedValue({
    ok: true,
    context: {
      contact: { is_blocked: false },
      messages: [{ direction: "outbound", body: "Posso te mandar o link?", sent_at: "2026-10-26T10:00:00-03:00" }],
    },
  });
});

/** O 4º argumento de `getLeadContext` — a janela com que o turno leu a conversa. */
function janelaLida(): unknown {
  expect(getLeadContext, "o turno nem chegou a ler a conversa").toHaveBeenCalledTimes(1);
  return getLeadContext.mock.calls[0]![3];
}

describe("follow-up dirigido por fluxo: janela de histórico", () => {
  it("classificar: agente 60/20.000 → a conversa é lida com 60/20.000", async () => {
    loadConversationAgentConfig.mockResolvedValue({ historyMessageWindow: 60, historyTokenWindow: 20_000 });

    await run(CLASSIFICAR, pool, { workerId: "w1" });

    expect(loadConversationAgentConfig).toHaveBeenCalledWith(pool, ORG, CONVERSA, CANAL);
    expect(janelaLida()).toEqual({ historyLimit: 60, maxTokens: 20_000 });
    expect(complete).toHaveBeenCalledWith(pool, expect.objectContaining({ result: { kind: "awaiting_reply" } }));
  });

  it("planejar o tempo: agente 60/20.000 → a conversa é lida com 60/20.000", async () => {
    loadConversationAgentConfig.mockResolvedValue({ historyMessageWindow: 60, historyTokenWindow: 20_000 });
    // Para no erro de contexto de propósito: o planejador (modelo) não é o assunto.
    getLeadContext.mockResolvedValue({ ok: false, error: { code: "teste" } });

    await expect(run(PLANEJAR, pool, { workerId: "w1" })).rejects.toThrow(/planejamento de tempo/);

    expect(janelaLida()).toEqual({ historyLimit: 60, maxTokens: 20_000 });
  });

  it("controle: sem agente publicado na conversa, vale a instalação", async () => {
    loadConversationAgentConfig.mockResolvedValue(null);

    await run(CLASSIFICAR, pool, { workerId: "w1" });

    expect(janelaLida()).toEqual({ historyLimit: 20, maxTokens: 1_000 });
  });

  it("agente com janela menor que a da instalação: vale o piso — o classificador não fica cego", async () => {
    loadConversationAgentConfig.mockResolvedValue({ historyMessageWindow: 0, historyTokenWindow: 500 });

    await run(CLASSIFICAR, pool, { workerId: "w1" });

    expect(janelaLida()).toEqual({ historyLimit: 20, maxTokens: 1_000 });
  });
});

describe("janelaDasLeiturasDoFluxo (regra pura)", () => {
  it("o maior de cada campo, quando há agente; a instalação, quando não há", async () => {
    const { janelaDasLeiturasDoFluxo } = await import("@/lib/agent-engine/agent/followup-turn");
    expect(janelaDasLeiturasDoFluxo({ historyMessageWindow: 60, historyTokenWindow: 500 }, INSTALACAO)).toEqual({
      historyLimit: 60,
      maxTokens: 1_000,
    });
    expect(janelaDasLeiturasDoFluxo(null, INSTALACAO)).toEqual({ historyLimit: 20, maxTokens: 1_000 });
  });
});
