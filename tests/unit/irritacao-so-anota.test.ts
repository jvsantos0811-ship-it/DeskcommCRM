/**
 * PC-002b (item 6, F1-o): o detector de irritação SÓ ANOTA por padrão.
 *
 * Medido em 28/10/2026 (07:29): um falso positivo numa mensagem calma mandou um
 * lead quente para uma fila vazia e tirou a IA da conversa. Agora o alerta vira
 * anotação no histórico do negócio (nota + trecho), sem passagem, sem mudar o
 * atendente — a menos que a organização escolha "passar".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const inserts: Array<{ tabela: string; linha: unknown }> = [];
let settingsDaOrg: unknown = {};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) c[m] = () => c;
      c.maybeSingle = async () => {
        if (tabela === "organizations") return { data: { settings: settingsDaOrg }, error: null };
        if (tabela === "crm_leads") return { data: { id: "lead-1" }, error: null };
        if (tabela === "messages") return { data: { body: "ok, pode ser amanhã às 10h" }, error: null };
        return { data: null, error: null };
      };
      c.insert = async (linha: unknown) => {
        inserts.push({ tabela, linha });
        return { data: null, error: null };
      };
      return c;
    },
  }),
}));
vi.mock("@/lib/atendimento/origem-mensagem", () => ({
  serviceFromMessage: vi.fn(async () => ({ conversation_id: "conv-1", contact_id: "contato-1" })),
}));
vi.mock("@/lib/ai/handoff/orchestrator", () => ({
  triggerHandoff: vi.fn(async () => ({ triggered: true, reason: "low_sentiment" })),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { aiHandoffFromSentimentHandler } from "@/workers/ai-handoff-from-sentiment.handler";
import { acaoDaIrritacao } from "@/lib/escalacao/irritacao";

const alerta = {
  organization_id: "org-1",
  entity_id: "msg-1",
  payload: { message_id: "msg-1", conversation_id: "conv-1", sentiment_score: 0.2, sentiment_engine: "llm" },
} as unknown as EventRow;

beforeEach(() => {
  inserts.length = 0;
  vi.mocked(triggerHandoff).mockClear();
  vi.mocked(emitLeadActivity).mockClear();
});

describe("o alerta de irritação", () => {
  it("⭐ padrão: só anota no histórico (nota + trecho) — sem passagem, a IA segue", async () => {
    settingsDaOrg = {};
    const r = await aiHandoffFromSentimentHandler.handle(alerta);
    expect(triggerHandoff).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: "ok", detail: "irritacao_anotada_sem_passagem" });
    const nota = vi.mocked(emitLeadActivity).mock.calls[0]![1];
    expect(nota).toMatchObject({ leadId: "lead-1", type: "note", sourceModule: "ai_sentiment" });
    expect(nota.reason).toMatch(/Só anotado: o atendimento seguiu com quem estava/);
    expect(nota.payload).toMatchObject({ sentiment_score: 0.2, trecho: "ok, pode ser amanhã às 10h" });
  });

  it("controle: a organização que escolheu 'passar' mantém a passagem de antes", async () => {
    settingsDaOrg = { irritacao: "passar" };
    await aiHandoffFromSentimentHandler.handle(alerta);
    expect(triggerHandoff).toHaveBeenCalledOnce();
    expect(emitLeadActivity).not.toHaveBeenCalled();
  });

  it("a leitura da escolha é fechada: só 'passar' passa", () => {
    expect(acaoDaIrritacao(null)).toBe("anotar");
    expect(acaoDaIrritacao({ irritacao: "PASSAR" })).toBe("anotar");
    expect(acaoDaIrritacao({ irritacao: "passar" })).toBe("passar");
  });
});
