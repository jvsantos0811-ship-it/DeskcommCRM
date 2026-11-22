import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { abrirArquivoDoWebhook } from "./arquivo-de-webhook";

function adminQueGuarda() {
  const linhas: Array<Record<string, unknown>> = [];
  const admin = {
    from: () => ({
      insert: (linha: Record<string, unknown>) => {
        linhas.push(linha);
        return { select: () => ({ maybeSingle: async () => ({ data: { id: "linha-1" }, error: null }) }) };
      },
    }),
  } as unknown as SupabaseClient;
  return { admin, linhas };
}

describe("o arquivo do webhook nunca guarda credencial no cabeçalho", () => {
  it("⭐ o token do Asaas não entra, mesmo que o aviso caia numa rota de canal", async () => {
    const { admin, linhas } = adminQueGuarda();
    const headers = new Headers({
      "asaas-access-token": "tok-secreto-do-asaas",
      authorization: "Bearer qualquer",
      "x-hub-signature-256": "sha256=abc",
    });
    await abrirArquivoDoWebhook(admin, {
      organizationId: "org",
      channelSessionId: "sessao",
      provider: "generic",
      rawBody: "{}",
      headers,
    });
    const guardados = linhas[0]?.headers as Record<string, string>;
    expect(guardados).not.toHaveProperty("asaas-access-token");
    expect(guardados).not.toHaveProperty("authorization");
    // Controle: a assinatura fica — é o que permite reconferir depois.
    expect(guardados["x-hub-signature-256"]).toBe("sha256=abc");
  });

  it("⭐ o segredo da entrada que viaja no caminho (PC-047) também não entra", async () => {
    const { admin, linhas } = adminQueGuarda();
    // Importado do módulo do canal: se o nome do cabeçalho mudar lá, este teste
    // continua medindo o cabeçalho de verdade, não uma cópia velha da string.
    const { HEADER_DO_SEGREDO } = await import("./atendimento-externo/entrada");
    const headers = new Headers({ [HEADER_DO_SEGREDO]: "f".repeat(64), "content-type": "application/json" });
    await abrirArquivoDoWebhook(admin, {
      organizationId: "org",
      channelSessionId: "sessao",
      provider: "chatguru",
      rawBody: "{}",
      headers,
    });
    const guardados = linhas[0]?.headers as Record<string, string>;
    expect(guardados).not.toHaveProperty(HEADER_DO_SEGREDO);
    expect(guardados["content-type"]).toBe("application/json");
  });
});
