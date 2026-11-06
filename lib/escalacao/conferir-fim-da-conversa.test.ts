/**
 * A leitura curta "a conversa terminou?" — na dúvida, avisa.
 *
 * SABOTAGEM: trocar qualquer `terminou: false` dos caminhos de falha por `true`
 * faz o caso correspondente acusar (o aviso sumiria justo quando não dá para ler).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolver = vi.fn();
const pode = vi.fn();
const registrar = vi.fn();

vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: (...a: unknown[]) => resolver(...a) }));
vi.mock("@/lib/ai/budget/pode-gastar", () => ({ podeGastarComIa: (...a: unknown[]) => pode(...a) }));
vi.mock("@/lib/ai/cost", () => ({ computeCost: vi.fn().mockResolvedValue(0.01) }));
vi.mock("@/lib/ai/usage/registrar-chamada", () => ({ registrarChamadaDeIa: (...a: unknown[]) => registrar(...a) }));

import { criarConferidorDoFim, PONTO_CONFERIR_FIM, trechoParaLeitura } from "./conferir-fim-da-conversa";
import type { MensagemDaConversa } from "./ninguem-respondeu";

const trecho: MensagemDaConversa[] = [
  { id: "1", direction: "outbound", sent_via: "ai", type: "text", body: "Posso ajudar?", media_derived_text: null, created_at: "2026-11-05T10:00:00Z" },
  { id: "2", direction: "outbound", sent_via: "external_device", type: "audio", body: null, media_derived_text: "Vou verificar.", created_at: "2026-11-05T10:01:00Z" },
  { id: "3", direction: "inbound", sent_via: "external_device", type: "text", body: "Tudo bem, obrigado pela ajuda", media_derived_text: null, created_at: "2026-11-05T10:02:00Z" },
];
const entrada = { organizationId: "org-1", contactId: "c-1", trecho };

beforeEach(() => {
  resolver.mockReset().mockResolvedValue({ model: {}, modelId: "anthropic/claude-haiku-5-5" });
  pode.mockReset().mockResolvedValue({ pode: true });
  registrar.mockReset().mockResolvedValue(undefined);
});

describe("conferir se a conversa terminou", () => {
  it("usa o ponto conferir_fim_da_conversa e registra o custo em llm_calls", async () => {
    const classificar = vi.fn().mockResolvedValue({ terminou: true, promptTokens: 120, completionTokens: 20 });
    const v = await criarConferidorDoFim({} as never, classificar)(entrada);
    expect(v).toEqual({ terminou: true, origem: "leitura", modelo: "anthropic/claude-haiku-5-5" });
    expect(resolver.mock.calls[0]![0]).toBe(PONTO_CONFERIR_FIM);
    expect(registrar.mock.calls[0]![1]).toMatchObject({
      organization_id: "org-1",
      contact_id: "c-1",
      purpose: "conferir_fim_da_conversa",
      input_tokens: 120,
      output_tokens: 20,
    });
  });

  it("sem modelo: não terminou (avisa) e não chama nada", async () => {
    resolver.mockResolvedValue(null);
    const classificar = vi.fn();
    const v = await criarConferidorDoFim({} as never, classificar)(entrada);
    expect(v).toEqual({ terminou: false, origem: "sem_modelo", modelo: null });
    expect(classificar).not.toHaveBeenCalled();
  });

  it("teto de gasto atingido: não terminou (avisa) e não chama o modelo", async () => {
    pode.mockResolvedValue({ pode: false });
    const classificar = vi.fn();
    const v = await criarConferidorDoFim({} as never, classificar)(entrada);
    expect(v.terminou).toBe(false);
    expect(v.origem).toBe("teto");
    expect(classificar).not.toHaveBeenCalled();
  });

  it("erro na chamada: não terminou (avisa) e o erro fica em llm_calls", async () => {
    const classificar = vi.fn().mockRejectedValue(new Error("caiu"));
    const v = await criarConferidorDoFim({} as never, classificar)(entrada);
    expect(v).toMatchObject({ terminou: false, origem: "falhou" });
    expect(registrar.mock.calls[0]![1]).toMatchObject({ erro: { message: "caiu" } });
  });

  it("o trecho lido diz quem falou e o tipo, sem nome nem telefone", () => {
    expect(trechoParaLeitura(trecho)).toBe(
      "Assistente virtual: Posso ajudar?\nEquipe: [audio] Vou verificar.\nContato: Tudo bem, obrigado pela ajuda",
    );
  });
});
