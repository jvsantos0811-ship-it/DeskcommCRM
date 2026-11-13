import { describe, expect, it } from "vitest";

import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import { crmGetAiCostByResponse } from "@/lib/mcp/agencia/ferramentas-do-custo";
import { ferramentasDaPorta } from "@/lib/mcp/agencia/server";

import { resumirCustoPorResposta, type LinhaDeChamada } from "./custo-por-resposta";
import { gravacaoDaChamadaPorValidade, lerPassadas, passadasDosPassos } from "./passadas";

/** PC-035 (medição): o detalhe por passada, a tarifa certa do cache e a consulta do Gestor. */

const SONNET = "claude-sonnet-5-5";
const QUANDO = new Date("2026-11-13T12:00:00Z");

describe("custo pela validade que o provedor cobrou", () => {
  const base = { inputTokens: 20_000, outputTokens: 1_000, cacheReadTokens: 10_000, cacheWriteTokens: 8_000 };

  it("sem a divisão, tudo na validade configurada (a conta de sempre)", () => {
    expect(costCents(SONNET, base, "1h", QUANDO)).toBeCloseTo(
      ((2_000 * 2 + 10_000 * 0.1 + 8_000 * 4 + 1_000 * 10) / 1_000_000) * 100,
      6,
    );
  });

  it("com a divisão, 5 min a 1,25× e 1 h a 2×: a parte de 5 min fica mais barata", () => {
    const dividido = { ...base, cacheWrite5mTokens: 6_000, cacheWrite1hTokens: 2_000 };
    const esperado = ((2_000 * 2 + 10_000 * 0.1 + 6_000 * 2.5 + 2_000 * 4 + 1_000 * 10) / 1_000_000) * 100;
    expect(costCents(SONNET, dividido, "1h", QUANDO)).toBeCloseTo(esperado, 6);
    expect(costCents(SONNET, dividido, "1h", QUANDO)!).toBeLessThan(costCents(SONNET, base, "1h", QUANDO)!);
  });

  it("o que a divisão não cobre continua na validade configurada", () => {
    const parcial = { ...base, cacheWrite5mTokens: 3_000, cacheWrite1hTokens: 0 };
    const esperado = ((2_000 * 2 + 10_000 * 0.1 + 3_000 * 2.5 + 5_000 * 4 + 1_000 * 10) / 1_000_000) * 100;
    expect(costCents(SONNET, parcial, "1h", QUANDO)).toBeCloseTo(esperado, 6);
  });
});

describe("passadas de uma chamada", () => {
  const passos = [
    {
      usage: { inputTokens: 12_000, outputTokens: 300, inputTokenDetails: { cacheReadTokens: 9_000, cacheWriteTokens: 3_000 } },
      toolCalls: [{ toolName: "send_message" }, { toolName: "save_lead_note" }],
      text: "vou responder",
      providerMetadata: { anthropic: { usage: { cache_creation: { ephemeral_5m_input_tokens: 3_000, ephemeral_1h_input_tokens: 0 } } } },
    },
    {
      usage: { inputTokens: 12_500, outputTokens: 20, inputTokenDetails: { cacheReadTokens: 12_000, cacheWriteTokens: 500 } },
      toolCalls: [],
      text: "",
      providerMetadata: { anthropic: { usage: { cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 } } } },
    },
  ];

  it("só números e nomes de ferramenta; o texto vira contagem de caracteres", () => {
    const p = passadasDosPassos(passos);
    expect(p).toEqual([
      { n: 1, entrada: 12_000, cache_lido: 9_000, cache_gravado: 3_000, cache_gravado_5m: 3_000, cache_gravado_1h: 0, saida: 300, ferramentas: ["send_message", "save_lead_note"], texto_descartado_chars: 13 },
      { n: 2, entrada: 12_500, cache_lido: 12_000, cache_gravado: 500, cache_gravado_5m: 500, cache_gravado_1h: 0, saida: 20, ferramentas: [], texto_descartado_chars: 0 },
    ]);
    expect(JSON.stringify(p)).not.toContain("vou responder");
    expect(gravacaoDaChamadaPorValidade(p)).toEqual({ em5m: 3_500, em1h: 0 });
  });

  it("passada com gravação e sem a divisão do provedor: sem divisão para a chamada inteira", () => {
    const p = passadasDosPassos([{ ...passos[0]!, providerMetadata: undefined }]);
    expect(p[0]!.cache_gravado_5m).toBeNull();
    expect(gravacaoDaChamadaPorValidade(p)).toBeNull();
  });

  it("entrada estranha não derruba nada", () => {
    expect(passadasDosPassos(undefined)).toEqual([]);
    expect(lerPassadas("lixo")).toEqual([]);
    expect(lerPassadas(null)).toEqual([]);
  });
});

function linha(parcial: Partial<LinhaDeChamada>): LinhaDeChamada {
  return {
    id: Math.random().toString(36).slice(2),
    job_id: "j1",
    agent_id: "a1",
    purpose: "agent_turn",
    model: SONNET,
    status: "ok",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_cents: 0,
    latency_ms: 0,
    passadas: null,
    created_at: QUANDO.toISOString(),
    ...parcial,
  };
}

describe("resumirCustoPorResposta", () => {
  const p1 = [
    { n: 1, entrada: 10_000, cache_lido: 6_000, cache_gravado: 4_000, cache_gravado_5m: 4_000, cache_gravado_1h: 0, saida: 200, ferramentas: ["send_message", "save_lead_note"], texto_descartado_chars: 0 },
  ];
  const p2 = [
    { n: 1, entrada: 10_000, cache_lido: 9_000, cache_gravado: 1_000, cache_gravado_5m: 1_000, cache_gravado_1h: 0, saida: 100, ferramentas: ["search_knowledge"], texto_descartado_chars: 40 },
    { n: 2, entrada: 11_000, cache_lido: 10_000, cache_gravado: 1_000, cache_gravado_5m: 1_000, cache_gravado_1h: 0, saida: 150, ferramentas: ["send_message"], texto_descartado_chars: 0 },
  ];
  const linhas = [
    linha({ job_id: "j1", cost_cents: 3, input_tokens: 10_000, cache_read_tokens: 6_000, cache_write_tokens: 4_000, output_tokens: 200, latency_ms: 4_000, passadas: p1 }),
    linha({ job_id: "j1", purpose: "checkpoint", agent_id: null, cost_cents: 1 }),
    linha({ job_id: "j2", cost_cents: 5, input_tokens: 21_000, cache_read_tokens: 19_000, cache_write_tokens: 2_000, output_tokens: 250, latency_ms: 8_000, passadas: p2 }),
    linha({ job_id: "j2", purpose: "promise_semantic", agent_id: null, cost_cents: 2 }),
    linha({ job_id: null, purpose: "classifier", agent_id: null, cost_cents: 7 }),
    linha({ job_id: "j3", status: "erro", cost_cents: 99 }),
  ];
  const r = resumirCustoPorResposta(linhas);

  it("conta as respostas e o custo do turno com as auxiliares do mesmo job (sem as soltas e sem as com erro)", () => {
    expect(r.respostas).toBe(2);
    expect(r.custo_por_resposta_cents).toBe((3 + 1 + 5 + 2) / 2);
    expect(r.chamadas_com_erro).toBe(1);
  });

  it("passadas por resposta e o consumo de cada posição", () => {
    expect(r.laco_do_agente.passadas).toBe(1.5);
    expect(r.respostas_por_numero_de_passadas).toEqual({ "1": 1, "2": 1 });
    expect(r.por_passada.map((p) => [p.n, p.respostas])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    expect(r.laco_do_agente.texto_descartado_chars).toBe(20);
  });

  it("em que passada cada ferramenta aparece", () => {
    const send = r.ferramentas.find((f) => f.ferramenta === "send_message")!;
    expect(send).toEqual({ ferramenta: "send_message", respostas: 2, passada_media: 1.5 });
  });

  it("o custo pela tarifa real fica abaixo da conta com tudo a 1 hora quando a gravação é de 5 min", () => {
    expect(r.laco_do_agente.custo_pela_tarifa_real_cents!).toBeLessThan(r.laco_do_agente.custo_com_gravacao_a_1h_cents!);
  });

  it("nenhum texto de conversa no resultado", () => {
    expect(Object.keys(r)).not.toContain("body");
  });
});

describe("a consulta do Gestor no MCP", () => {
  it("existe só na porta Leitura da agência", () => {
    expect(ferramentasDaPorta("leitura").map((t) => t.name)).toContain("crm_get_ai_cost_by_response");
    expect(ferramentasDaPorta("admin").map((t) => t.name)).not.toContain("crm_get_ai_cost_by_response");
  });

  it("é de leitura e recusa janela invertida ou maior que 31 dias", async () => {
    expect(crmGetAiCostByResponse.category).toBe("read");
    const ctx = { organizationId: "o1", supabase: {} } as never;
    await expect(
      crmGetAiCostByResponse.handler({ desde: "2026-11-13T00:00:00-03:00", ate: "2026-11-12T00:00:00-03:00" }, ctx),
    ).rejects.toThrow(/validation_failed/);
    await expect(
      crmGetAiCostByResponse.handler({ desde: "2026-09-01T00:00:00-03:00", ate: "2026-11-12T00:00:00-03:00" }, ctx),
    ).rejects.toThrow(/31 dias/);
  });
});
