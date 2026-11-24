/**
 * PC-052 parte 3b — O PASSO DO FOLLOW-UP FORA DA JANELA PELO DIÁLOGO DA CONEXÃO.
 *
 * No canal que atende dentro do ChatGuru o CRM não manda modelo da Meta: com a
 * janela de 24 h fechada, o passo `ai_message` com `fallback_roteiro` executa o
 * diálogo que a conexão escolheu (T1..T5). Este arquivo prende:
 *  - janela FECHADA: sai o diálogo do uso do passo, e a IA não é chamada;
 *  - janela ABERTA: a IA escreve, como sempre;
 *  - as portas do texto do fluxo valem para o diálogo: pessoa no comando/opt-out
 *    pula, e fora da janela de ENVIO do número o passo é ADIADO (nunca sai);
 *  - recusa da plataforma vira `skipped` com motivo — nunca reenvio;
 *  - com modelo aprovado no passo, o caminho é o do modelo (canal oficial).
 *
 * O que NÃO prova: Postgres real nem a plataforma (o diálogo em si é do
 * `lib/channels/roteiro-fora-da-janela.ts`, testado à parte).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";

const runBeforeSend = vi.fn(async (args: Record<string, unknown>) => {
  await (args.send as (b: string) => Promise<unknown>)(args.body as string);
  return { status: "sent", outcome: { kind: "sent" }, trace: [] };
});
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend }));

const emHandoff = vi.fn(async () => false);
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ isLeadInHandoff: () => emHandoff() }));
vi.mock("@/lib/agent-engine/agent/etapa-exige-humano", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  etapaQueExigeHumano: vi.fn(async () => null),
}));

vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));

const runAgentTurn = vi.fn(async () => undefined);
vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => ({
  ...(await original<typeof import("@/lib/agent-engine/agent/inbound-turn")>()),
  runAgentTurn,
}));
vi.mock("@/lib/agent-engine/edge/crm/send-ledger", () => ({
  resultadoDoEnvioDoFollowup: vi.fn(async () => ({ kind: "sent" })),
}));

const janela = { aberta: true };
vi.mock("@/lib/agent-engine/pacing/store", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadChannelKnobs: vi.fn(async () => ({ knobs: { timezone: "America/Sao_Paulo" } })),
}));
vi.mock("@/lib/agent-engine/pacing/engine", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  janelaDeEnvioAberta: () => janela.aberta,
  proximaAberturaDaJanela: () => new Date("2099-01-01T11:00:00.000Z"),
}));

const roteiro = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: boolean; motivo?: string });
vi.mock("@/lib/channels/roteiro-fora-da-janela", () => ({
  enviarRoteiroForaDaJanela: (...a: unknown[]) => roteiro(...a),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";
const MODELO_ID = "22222222-2222-4222-8222-222222222222";
const HORA = 3_600_000;

const boundary = { organization_id: ORG, contact_id: LEAD, conversation_id: CONVERSA, service_revision: 1, demanda_id: null, demanda_revision: null };

function job(payload: Record<string, unknown>): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: LEAD,
    kind: "followup_turn",
    source_event_id: null,
    payload: {
      followup_enrollment_id: "11111111-1111-4111-8111-111111111111",
      node_id: "passo",
      purpose: "send_message",
      ...payload,
      service_boundary: boundary,
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

const CORPO = "¡Hola! ¿Seguís pensando en el Pico? Sale ₲125.000. ¿Te lo reservamos?";

interface Cenario {
  /** corpo em `message_templates` (texto pronto) */
  texto?: string;
  /** a linha do modelo do canal, ou ausente */
  modelo?: { status: string; texto?: string };
  /** último inbound da conversa, em horas atrás (`null` = nunca escreveu) */
  ultimoInboundHa?: number | null;
}

function fakePool(c: Cenario) {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    // A ordem importa: a definição da conexão e a janela citam outras tabelas no corpo.
    if (/from meta_templates t/.test(sql)) {
      return c.modelo
        ? { rows: [{ components: [{ type: "BODY", text: c.modelo.texto ?? CORPO }], parameter_format: "POSITIONAL", status: c.modelo.status }] }
        : { rows: [] };
    }
    if (/select name, language from meta_templates/.test(sql)) {
      return c.modelo ? { rows: [{ name: "recordatorio_pico", language: "es" }] } : { rows: [] };
    }
    if (/from message_templates/.test(sql)) return { rows: c.texto ? [{ body: c.texto }] : [] };
    if (/from channel_sessions s/.test(sql)) {
      const ha = c.ultimoInboundHa;
      return {
        rows: [{ provider: "chatguru", last_inbound_at: ha === null || ha === undefined ? null : new Date(Date.now() - ha * HORA) }],
      };
    }
    if (/from conversations/.test(sql)) return { rows: [{ id: CONVERSA, channel_session_id: CANAL, archived_at: null }] };
    // A inscrição viva que o handler consulta ANTES do envio (guard da #1913).
    if (sql.includes("select current_node_id, status from followup_enrollments")) {
      return { rows: [{ current_node_id: "passo", status: "active" }] };
    }
    return { rows: [] };
  });
  return { query } as never;
}

function deps() {
  const send = vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }));
  const completeFollowupTurn = vi.fn(async () => undefined);
  const d = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    crmCfg: {},
    llmCfg: {},
    knobs: {},
    channel: () => ({ send }),
    completeFollowupTurn,
  } as never;
  return { d, send, completeFollowupTurn };
}

function resultado(completeFollowupTurn: ReturnType<typeof vi.fn>): { kind: string; reason?: string } {
  const entrada = (completeFollowupTurn.mock.calls[0] as unknown[] | undefined)?.[1] as { result: { kind: string; reason?: string } } | undefined;
  return entrada?.result ?? { kind: "(não chamou)" };
}

let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;

beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
}, 60_000);

beforeEach(() => {
  runBeforeSend.mockClear();
  runAgentTurn.mockClear();
  roteiro.mockReset();
  roteiro.mockResolvedValue({ ok: true });
  emHandoff.mockReset();
  emHandoff.mockResolvedValue(false);
  janela.aberta = true;
});

const PASSO = { prompt_hint: "Retome a conversa", fallback_roteiro: "followup_2" };

describe("passo de IA com o diálogo da conexão como plano B", () => {
  it("⭐ janela de 24 h FECHADA: sai o diálogo do passo e a IA não é chamada", async () => {
    const { d, completeFollowupTurn } = deps();
    await criarHandler(d)(job(PASSO), fakePool({ ultimoInboundHa: 30 }), { workerId: "w1" });

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(roteiro).toHaveBeenCalledTimes(1);
    expect(roteiro.mock.calls[0]![1]).toEqual({
      organizationId: ORG,
      channelSessionId: CANAL,
      conversationId: CONVERSA,
      uso: "followup_2",
    });
    expect(resultado(completeFollowupTurn).kind).toBe("sent");
  });

  it("⭐ janela ABERTA: a IA escreve, como sempre", async () => {
    const { d } = deps();
    await criarHandler(d)(job(PASSO), fakePool({ ultimoInboundHa: 2 }), { workerId: "w1" });

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(roteiro).not.toHaveBeenCalled();
  });

  it("fora da janela de ENVIO do número: adia para a abertura, nada sai", async () => {
    janela.aberta = false;
    const { d, completeFollowupTurn } = deps();
    await criarHandler(d)(job(PASSO), fakePool({ ultimoInboundHa: 30 }), { workerId: "w1" });

    expect(roteiro).not.toHaveBeenCalled();
    expect(resultado(completeFollowupTurn).kind).toBe("deferred");
  });

  it("cliente com a equipe ou que pediu para parar: pula, nada sai", async () => {
    emHandoff.mockResolvedValue(true);
    const { d, completeFollowupTurn } = deps();
    await criarHandler(d)(job(PASSO), fakePool({ ultimoInboundHa: 30 }), { workerId: "w1" });

    expect(roteiro).not.toHaveBeenCalled();
    expect(resultado(completeFollowupTurn).kind).toBe("skipped");
  });

  it("a conexão não tem diálogo para o passo: pula com o motivo, sem reenvio", async () => {
    roteiro.mockResolvedValue({ ok: false, motivo: "sem_roteiro" });
    const { d, completeFollowupTurn } = deps();
    await criarHandler(d)(job(PASSO), fakePool({ ultimoInboundHa: 30 }), { workerId: "w1" });

    const r = resultado(completeFollowupTurn);
    expect(r.kind).toBe("skipped");
    expect(r.reason).toContain("não tem diálogo");
  });

  it("com modelo aprovado no passo, o caminho é o do modelo (o diálogo não passa na frente)", async () => {
    const { d } = deps();
    await criarHandler(d)(
      job({ ...PASSO, fallback_template_id: MODELO_ID }),
      fakePool({ modelo: { status: "APPROVED" }, ultimoInboundHa: 30 }),
      { workerId: "w1" },
    );
    expect(roteiro).not.toHaveBeenCalled();
  });
});
