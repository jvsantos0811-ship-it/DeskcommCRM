/**
 * O TEXTO FIXO DO FLUXO TAMBÉM NÃO SAI com o negócio numa etapa "só atendimento
 * humano" (fork, migration 9005).
 *
 * O turno da IA (resposta e follow-up escrito pela IA) passa por
 * `executarTurnoDoAgente`, e a prova dele contra o Postgres é
 * `tests/invariants/etapa-so-humano-cala-a-ia.test.ts`. O texto que o operador
 * escreveu no passo do fluxo sai por outro caminho, `sendFixedOutbound` — e é
 * esse que este arquivo prende: com a etapa marcada, nada chega à cadeia de
 * envio, a conversa passa para uma pessoa e o passo conclui `skipped`.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";

const ORG = "org-1";
const CONTATO = "contact-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";

const runBeforeSend = vi.fn(async () => ({ status: "sent", outcome: { kind: "sent" }, trace: [] }));
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend }));
vi.mock("@/lib/agent-engine/agent/human-handoff", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  isLeadInHandoff: vi.fn(async () => false),
}));
const etapaQueExigeHumano = vi.fn();
const passarParaHumanoPelaEtapa = vi.fn(async () => undefined);
vi.mock("@/lib/agent-engine/agent/etapa-exige-humano", () => ({ etapaQueExigeHumano, passarParaHumanoPelaEtapa }));
vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));

const BOUNDARY = {
  organization_id: ORG,
  contact_id: CONTATO,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

function fakePool() {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes("d.fechada_em::text")) {
      return { rows: [{ ...BOUNDARY, status: "open", demanda_fechada_em: null }] };
    }
    if (sql.includes("select current_node_id, status from followup_enrollments")) {
      return { rows: [{ current_node_id: "passo", status: "active" }] };
    }
    if (/from conversations/.test(sql)) {
      return { rows: [{ id: CONVERSA, channel_session_id: CANAL, archived_at: null }] };
    }
    return { rows: [] };
  });
  return { query } as never;
}

const JOB = {
  id: "job-1",
  organization_id: ORG,
  contact_id: CONTATO,
  kind: "followup_turn",
  source_event_id: null,
  payload: {
    followup_enrollment_id: "11111111-1111-4111-8111-111111111111",
    node_id: "passo",
    purpose: "send_message",
    fixed_body: "Oi, passando para lembrar dos documentos.",
    service_boundary: BOUNDARY,
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

const completeFollowupTurn = vi.fn(async () => undefined);
const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  crmCfg: {},
  llmCfg: {},
  knobs: {},
  channel: () => ({ send: vi.fn(async () => ({ ok: true })) }),
  completeFollowupTurn,
} as never;

let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;

beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
}, 60_000);

beforeEach(() => {
  runBeforeSend.mockClear();
  etapaQueExigeHumano.mockReset();
  passarParaHumanoPelaEtapa.mockClear();
  completeFollowupTurn.mockClear();
});

describe("follow-up de texto fixo × etapa só atendimento humano", () => {
  it("com o negócio na etapa marcada: nada vai à cadeia de envio, a conversa passa e o passo conclui skipped", async () => {
    etapaQueExigeHumano.mockResolvedValue({ negocioId: "n1", etapaId: "e1", etapaNome: "Análise humana" });

    await criarHandler(deps)(JOB, fakePool(), { workerId: "w1" });

    expect(runBeforeSend, "o texto do fluxo saiu com o negócio numa etapa só humana").not.toHaveBeenCalled();
    expect(passarParaHumanoPelaEtapa).toHaveBeenCalledTimes(1);
    expect(passarParaHumanoPelaEtapa).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: ORG, leadId: CONTATO, conversationId: CONVERSA },
      { negocioId: "n1", etapaId: "e1", etapaNome: "Análise humana" },
      expect.objectContaining({ checkpoint: null }),
    );
    expect(completeFollowupTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: expect.objectContaining({ kind: "skipped" }) }),
    );
  });

  it("controle: sem etapa marcada, o texto vai à cadeia de envio", async () => {
    etapaQueExigeHumano.mockResolvedValue(null);

    await criarHandler(deps)(JOB, fakePool(), { workerId: "w1" });

    expect(passarParaHumanoPelaEtapa).not.toHaveBeenCalled();
    expect(runBeforeSend).toHaveBeenCalledTimes(1);
  });
});
