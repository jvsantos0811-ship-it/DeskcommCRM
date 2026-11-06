/**
 * Uma leitura do Leitor — as três travas antes de gastar e o registro em llm_calls.
 *
 * SABOTAGEM:
 * - tirar a conferência `mesmoModelo`: o caso "outro modelo" acusa (ficha de
 *   modelo que não passou na bateria entraria nos painéis);
 * - trocar o literal do `purpose`: o caso do registro acusa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolver = vi.fn();
const pode = vi.fn();
const registrar = vi.fn();

vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: (...a: unknown[]) => resolver(...a) }));
vi.mock("@/lib/ai/budget/pode-gastar", () => ({ podeGastarComIa: (...a: unknown[]) => pode(...a) }));
vi.mock("@/lib/ai/cost", () => ({ computeCost: vi.fn().mockResolvedValue(0.04) }));
vi.mock("@/lib/ai/usage/registrar-chamada", () => ({ registrarChamadaDeIa: (...a: unknown[]) => registrar(...a) }));

import type { FichaDoLeitor } from "@/lib/dados/ficha";

import { criarLeitor, mesmoModelo, PONTO_DO_LEITOR } from "./ler-lead";

const FICHA: FichaDoLeitor = {
  contato: "lead",
  interesse: "Implante",
  interesse_texto: null,
  contou_o_caso: "parcial",
  requisitos: "a_confirmar",
  requisitos_faltando: ["já avaliou"],
  requisito_em_risco: false,
  negociacao: "nenhuma",
  objecao: "nenhuma",
  fora_da_area: false,
  sem_caso: false,
  recusou: false,
  ja_atendido_por_outro: false,
  confirmar_assinatura: false,
  midia_nao_entendida: false,
  aguardando: null,
  proximo_passo_com: "lead",
  palavras_proprias: true,
  esperando_a_equipe: null,
  provas: { interesse: "perdi um dente" },
};

const entrada = {
  organizationId: "org-1",
  contactId: "c-1",
  sistema: "prompt",
  conversa: "[2026-11-05T10:05] Contato: perdi um dente",
  aprovado: { provider: "anthropic", model_id: "claude-haiku-5-5" },
};

beforeEach(() => {
  resolver.mockReset().mockResolvedValue({ model: {}, modelId: "claude-haiku-5-5", origem: "binding" });
  pode.mockReset().mockResolvedValue({ pode: true });
  registrar.mockReset().mockResolvedValue(undefined);
});

describe("uma leitura do Leitor", () => {
  it("lê com o modelo aprovado e registra o custo no ponto leitor_da_conversa", async () => {
    const classificar = vi.fn().mockResolvedValue({ ficha: FICHA, promptTokens: 2300, completionTokens: 400 });
    const r = await criarLeitor({} as never, classificar)(entrada);
    expect(r).toMatchObject({ tipo: "lida", ficha: FICHA, modelo: "claude-haiku-5-5" });
    expect(resolver.mock.calls[0]![0]).toBe(PONTO_DO_LEITOR);
    expect(resolver.mock.calls[0]![2]).toBe("anthropic/claude-haiku-5-5");
    expect(registrar.mock.calls[0]![1]).toMatchObject({
      organization_id: "org-1",
      contact_id: "c-1",
      purpose: "leitor_da_conversa",
      input_tokens: 2300,
      output_tokens: 400,
      cost_cents: 0.04,
    });
  });

  it("outro modelo que não o aprovado: não lê nem gasta", async () => {
    resolver.mockResolvedValue({ model: {}, modelId: "anthropic/claude-haiku-4-5", origem: "padrao" });
    const classificar = vi.fn();
    const r = await criarLeitor({} as never, classificar)(entrada);
    expect(r).toEqual({ tipo: "modelo_diferente", usado: "anthropic/claude-haiku-4-5", aprovado: "anthropic/claude-haiku-5-5" });
    expect(classificar).not.toHaveBeenCalled();
    expect(pode).not.toHaveBeenCalled();
  });

  it("sem modelo: não lê", async () => {
    resolver.mockResolvedValue(null);
    expect(await criarLeitor({} as never, vi.fn())(entrada)).toEqual({ tipo: "sem_modelo" });
  });

  it("teto de gasto atingido: não lê", async () => {
    pode.mockResolvedValue({ pode: false, porque: "teto_atingido" });
    const classificar = vi.fn();
    expect(await criarLeitor({} as never, classificar)(entrada)).toEqual({ tipo: "teto" });
    expect(classificar).not.toHaveBeenCalled();
  });

  it("resposta fora do schema ou erro do provedor: falhou, com o erro em llm_calls", async () => {
    const classificar = vi.fn().mockResolvedValue({ ficha: { contato: "talvez" }, promptTokens: 1, completionTokens: 1 });
    const r = await criarLeitor({} as never, classificar)(entrada);
    expect(r.tipo).toBe("falhou");
    expect(registrar.mock.calls[0]![1]).toMatchObject({ purpose: "leitor_da_conversa", cost_cents: 0 });
    expect(registrar.mock.calls[0]![1].erro.message).toBeTruthy();
  });

  it("mesmoModelo ignora o prefixo do provedor e maiúsculas", () => {
    expect(mesmoModelo("anthropic/claude-haiku-5-5", "Claude-Haiku-5-5")).toBe(true);
    expect(mesmoModelo("openai/gpt-6-luna", "claude-haiku-5-5")).toBe(false);
  });
});

describe("o modelo de reserva", () => {
  it("o principal falhou: tenta uma vez a reserva, com a chave da organização", async () => {
    vi.resetModules();
    const montar = vi.fn(async () => ({ model: {}, modelId: "openai/gpt-6-luna", origem: "credencial_da_organizacao" }));
    vi.doMock("./modelo-escolhido", () => ({ montarModeloEscolhido: montar }));
    const { criarLeitor: criar } = await import("./ler-lead");
    const classificar = vi
      .fn()
      .mockRejectedValueOnce(new Error("provedor fora do ar"))
      .mockResolvedValueOnce({ ficha: FICHA, promptTokens: 10, completionTokens: 5 });
    const r = await criar({} as never, classificar)({ ...entrada, reserva: { provider: "openai", model_id: "gpt-6-luna" } });
    expect(r).toMatchObject({ tipo: "lida", modelo: "openai/gpt-6-luna" });
    expect(montar).toHaveBeenCalledWith({}, { provider: "openai", model_id: "gpt-6-luna" }, "org-1");
    vi.doUnmock("./modelo-escolhido");
  });
});
