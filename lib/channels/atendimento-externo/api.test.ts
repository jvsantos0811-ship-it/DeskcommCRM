import { describe, expect, it, vi } from "vitest";

import { chamarApi, semDigitosLongos } from "./api";
import { urlDaApi } from "./credenciais";

const CREDS = { servidor: "s7", accountId: "conta_teste", phoneId: "fone_teste", apiKey: "chave-de-teste-0123456789" };

function resposta(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
}

describe("chamada à API da plataforma (PC-047)", () => {
  it("a chave vai no CORPO do POST, nunca na URL", async () => {
    const fetchFake = vi.fn(async (..._args: unknown[]) => resposta({ code: 201, result: "success", message_id: "m1" }));
    const r = await chamarApi(CREDS, "message_send", { chat_number: "5500900000001", text: "oi" }, { fetch: fetchFake as never });
    expect(r.messageId).toBe("m1");
    const [url, init] = fetchFake.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://s7.chatguru.app/api/v1");
    expect(url).not.toContain("chave-de-teste");
    const corpo = new URLSearchParams(String(init.body));
    expect(corpo.get("key")).toBe(CREDS.apiKey);
    expect(corpo.get("action")).toBe("message_send");
    expect(corpo.get("account_id")).toBe("conta_teste");
    expect(corpo.get("phone_id")).toBe("fone_teste");
    expect(init.method).toBe("POST");
  });

  it("200 com result=error é RECUSA, não envio", async () => {
    const fetchFake = vi.fn(async () => resposta({ code: 400, result: "error", description: "Chat 5500900000001 não encontrado" }));
    await expect(chamarApi(CREDS, "message_send", {}, { fetch: fetchFake as never })).rejects.toThrow(
      /^chatguru_400: Chat … não encontrado$/,
    );
  });

  it("erro de rede vira código próprio, sem a chave", async () => {
    const fetchFake = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(chamarApi(CREDS, "note_add", {}, { fetch: fetchFake as never })).rejects.toThrow(/^chatguru_rede: ECONNRESET/);
  });

  it("servidor fora do formato não vira URL (sem SSRF pelo campo da tela)", () => {
    expect(() => urlDaApi("evil.com/x?")).toThrow(/chatguru_servidor_invalido/);
    expect(() => urlDaApi("s7.outro")).toThrow(/chatguru_servidor_invalido/);
    expect(urlDaApi("S7")).toBe("https://s7.chatguru.app/api/v1");
  });

  it("mascara telefone e documento no texto do provedor", () => {
    expect(semDigitosLongos("cliente +55 (00) 90000-0001 sem chat")).toBe("cliente … sem chat");
    expect(semDigitosLongos("código 404")).toBe("código 404");
  });
});
