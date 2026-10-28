/**
 * PC-002b (F1-l) — o Testar guarda a conversa e aceita dia e hora simulados.
 *
 * Antes, cada clique em Testar era uma conversa nova de UMA mensagem, sempre na
 * hora real: não dava para testar o terceiro turno de uma qualificação nem a
 * resposta de domingo às 15h. Aqui se mede a montagem do cenário e a entrada da
 * rota; o turno em si é o mesmo motor de sempre (`runAgentPreview`).
 */
import { describe, expect, it } from "vitest";

import { testRunSchema } from "@/lib/ai/agents/validation";
import { mensagensDoCenario } from "@/lib/agent-engine/agent/sandbox";

describe("o cenário do teste com histórico", () => {
  it("⭐ 3 turnos: o histórico vem em ordem, a mensagem nova por último, no 'agora' simulado", () => {
    const agora = new Date("2026-11-01T18:00:00Z"); // domingo, 15h em São Paulo
    const msgs = mensagensDoCenario(
      [
        { direcao: "cliente", texto: "Oi, sofri um acidente de moto" },
        { direcao: "agente", texto: "Sinto muito. Você estava trabalhando?" },
        { direcao: "cliente", texto: "Sim, indo para o trabalho" },
        { direcao: "agente", texto: "Entendi. Ficou alguma sequela?" },
      ],
      "Fiquei com o joelho travado",
      agora,
    );
    expect(msgs.map((m) => m.direction)).toEqual(["inbound", "outbound", "inbound", "outbound", "inbound"]);
    expect(msgs.at(-1)).toEqual({
      direction: "inbound",
      body: "Fiquei com o joelho travado",
      sent_at: agora.toISOString(),
    });
    // Horários crescentes, a 1 minuto um do outro, terminando no "agora".
    const horas = msgs.map((m) => Date.parse(m.sent_at));
    for (let i = 1; i < horas.length; i++) expect(horas[i]! - horas[i - 1]!).toBe(60_000);
  });

  it("sem histórico é a conversa de uma mensagem de sempre", () => {
    const agora = new Date("2026-10-28T12:00:00Z");
    expect(mensagensDoCenario([], "oi", agora)).toEqual([
      { direction: "inbound", body: "oi", sent_at: agora.toISOString() },
    ]);
  });
});

describe("a entrada da rota de teste", () => {
  it("aceita histórico e hora com fuso; continua aceitando o pedido antigo", () => {
    expect(testRunSchema.safeParse({ sample_message: "oi" }).success).toBe(true);
    expect(
      testRunSchema.safeParse({
        sample_message: "oi",
        historico: [{ direcao: "cliente", texto: "a" }, { direcao: "agente", texto: "b" }],
        agora: "2026-11-01T15:00:00-03:00",
      }).success,
    ).toBe(true);
  });

  it("recusa direção desconhecida, hora sem fuso e histórico gigante", () => {
    expect(
      testRunSchema.safeParse({ sample_message: "oi", historico: [{ direcao: "sistema", texto: "x" }] }).success,
    ).toBe(false);
    expect(testRunSchema.safeParse({ sample_message: "oi", agora: "2026-11-01 15:00" }).success).toBe(false);
    expect(
      testRunSchema.safeParse({
        sample_message: "oi",
        historico: Array.from({ length: 41 }, () => ({ direcao: "cliente", texto: "x" })),
      }).success,
    ).toBe(false);
  });
});
