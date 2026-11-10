/**
 * PC-029 — a resposta de uma PESSOA pela tela do CRM assume a conversa.
 *
 * Até o PC-029 isto só acontecia com "A conversa fica com quem atendeu" ligado
 * (desligado, a IA calava por 5 minutos). Desde o pedido do João (10/11/2026)
 * vale para todos: a rota entrega o envio da pessoa ao serviço
 * `equipeAssumiuRespondendo`, que assume pela MESMA RPC do "Assumir" (sem tomar
 * conversa de outra pessoa), cala a IA até o "Devolver", deixa o contato só
 * humano, cancela as agendadas e move o card. As regras do serviço moram em
 * `lib/escalacao/equipe-assumiu.test.ts`; aqui o que se prova é QUEM chega até
 * ele pela rota — e quem não chega.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { equipeAssumiuRespondendo } from "@/lib/escalacao/equipe-assumiu";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({ resolveAuthDual: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));
vi.mock("@/lib/escalacao/equipe-assumiu", () => ({
  equipeAssumiuRespondendo: vi.fn(async () => ({ aplicado: true })),
}));
const ADMIN = { quem: "cliente de serviço" };
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ADMIN) }));

const organizationId = "22222222-2222-4222-8222-222222222222";
const conversationId = "44444444-4444-4444-8444-444444444444";
const userId = "11111111-1111-4111-8111-111111111111";
const daSessao = { rpc: vi.fn(), from: vi.fn() };

function req() {
  return new NextRequest("http://localhost/api/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId, type: "text", body: "Resposta" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveAuthDual).mockResolvedValue({
    ok: true,
    via: "session",
    organizationId,
    actor: { type: "user", id: userId },
    supabase: daSessao as never,
    idioma: "pt-BR",
  });
  vi.mocked(sendMessageHandler).mockResolvedValue({
    id: "message-1",
    conversation_id: conversationId,
    status: "sent",
  } as never);
});

describe("POST /messages — a resposta de uma pessoa pela tela", () => {
  it("entrega ao serviço da equipe: origem CRM, quem respondeu, e o Assumir pela sessão dela", async () => {
    const { POST } = await import("@/app/api/v1/messages/route");
    const response = await POST(req());
    expect(response.status).toBe(201);
    expect(equipeAssumiuRespondendo).toHaveBeenCalledTimes(1);
    expect(equipeAssumiuRespondendo).toHaveBeenCalledWith(ADMIN, {
      organizationId,
      conversationId,
      origem: "crm",
      userId,
      // O "Assumir" usa o client da SESSÃO: o evento de troca de dono guarda quem mudou.
      clientDoAssumir: daSessao,
      requestId: expect.any(String),
    });
  });

  it("vale SEM ler \"A conversa fica com quem atendeu\" (o ajuste não decide mais)", async () => {
    const { POST } = await import("@/app/api/v1/messages/route");
    await POST(req());
    expect(daSessao.from).not.toHaveBeenCalledWith("organizations");
    expect(equipeAssumiuRespondendo).toHaveBeenCalledTimes(1);
  });

  it("falha do canal: nada é assumido", async () => {
    vi.mocked(sendMessageHandler).mockResolvedValue({
      id: "message-1",
      conversation_id: conversationId,
      status: "failed",
    } as never);
    const { POST } = await import("@/app/api/v1/messages/route");
    const response = await POST(req());
    expect(response.status).toBe(201);
    expect(equipeAssumiuRespondendo).not.toHaveBeenCalled();
  });

  it("integração por chave (bearer) não é pessoa: não assume", async () => {
    vi.mocked(resolveAuthDual).mockResolvedValue({
      ok: true,
      via: "bearer",
      organizationId,
      actor: { type: "api_token", id: "tok-1" },
      supabase: daSessao as never,
      idioma: "pt-BR",
    } as never);
    const { POST } = await import("@/app/api/v1/messages/route");
    await POST(req());
    expect(equipeAssumiuRespondendo).not.toHaveBeenCalled();
  });

  it("o serviço indisponível nunca vira erro do envio (a mensagem já saiu)", async () => {
    vi.mocked(equipeAssumiuRespondendo).mockRejectedValueOnce(new Error("sem chave de serviço"));
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("@/app/api/v1/messages/route");
    const response = await POST(req());
    expect(response.status).toBe(201);
    erro.mockRestore();
  });
});
