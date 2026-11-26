import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CredenciaisDoAtendimentoExterno } from "../atendimento-externo/credenciais";
import { chatguruAdapter } from "./chatguru";

const { resolver } = vi.hoisted(() => ({
  resolver: vi.fn<(...args: unknown[]) => Promise<CredenciaisDoAtendimentoExterno | null>>(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
// A guarda de DNS é do repo e tem teste próprio; aqui o que se mede é o pedido.
vi.mock("@/lib/automation/outbound-ip", () => ({ assertDestinoResolvidoSeguro: async () => {} }));
vi.mock("../atendimento-externo/credenciais", async (original) => ({
  ...((await original()) as Record<string, unknown>),
  resolverCredenciais: (...args: unknown[]) => resolver(...args),
}));

const ORG = "00000000-0000-4000-8000-0000000000aa";

function creds(config: Partial<CredenciaisDoAtendimentoExterno["config"]> = {}): CredenciaisDoAtendimentoExterno {
  return {
    channelSessionId: "sess-1",
    servidor: "s7",
    accountId: "conta_teste",
    phoneId: "fone_teste",
    apiKey: "chave-de-teste-0123456789",
    config: {
      dialogoTransferencia: null,
      campoDaIa: null,
      acoes: [],
      valorQuandoEquipeAssume: null,
      roteirosForaDaJanela: {},
      ...config,
    },
  };
}

const chamadas: URLSearchParams[] = [];
beforeEach(() => {
  chamadas.length = 0;
  resolver.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      chamadas.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ code: 201, result: "success", message_id: "m-1" }), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("adapter do canal dentro da plataforma (PC-047)", () => {
  it("responde pelo número COMO A PLATAFORMA O TEM, não pelo do cadastro", async () => {
    resolver.mockResolvedValue(creds());
    const r = await chatguruAdapter.send({
      organizationId: ORG,
      sessionRef: "fone_teste",
      to: "5500900000001",
      providerConversationId: "550090000001",
      kind: "text",
      body: "Olá!",
    });
    expect(r.externalId).toBe("m-1");
    expect(chamadas[0]?.get("action")).toBe("message_send");
    expect(chamadas[0]?.get("chat_number")).toBe("550090000001");
    expect(chamadas[0]?.get("text")).toBe("Olá!");
    // A credencial é buscada pela organização do envelope, nunca por outra.
    expect(resolver).toHaveBeenCalledWith(expect.anything(), { organizationId: ORG, phoneId: "fone_teste" });
  });

  it("mídia sai por URL, com a legenda", async () => {
    resolver.mockResolvedValue(creds());
    await chatguruAdapter.send({
      organizationId: ORG,
      sessionRef: "fone_teste",
      to: "5500900000001",
      kind: "image",
      media: { url: "https://storage.exemplo.com/a.jpg", mime: "image/jpeg", caption: "segue" },
    });
    expect(chamadas[0]?.get("action")).toBe("message_file_send");
    expect(chamadas[0]?.get("file_url")).toBe("https://storage.exemplo.com/a.jpg");
    expect(chamadas[0]?.get("caption")).toBe("segue");
  });

  it("sem credencial, LANÇA com o código de 'não configurado' (o handler grava queued)", async () => {
    resolver.mockResolvedValue(null);
    await expect(
      chatguruAdapter.send({ organizationId: ORG, sessionRef: "fone_teste", to: "5500900000001", kind: "text", body: "x" }),
    ).rejects.toThrow(new RegExp(`^${chatguruAdapter.codes.notConfigured}`));
    expect(chamadas).toHaveLength(0);
  });

  it("saúde: credencial gravada = de pé; sem credencial = FAILED (sem chamar a plataforma)", async () => {
    resolver.mockResolvedValueOnce(creds());
    expect(await chatguruAdapter.checkHealth!({ organizationId: ORG, sessionRef: "fone_teste" })).toEqual({
      reachable: true,
      status: "WORKING",
      detail: null,
    });
    resolver.mockResolvedValueOnce(null);
    expect((await chatguruAdapter.checkHealth!({ organizationId: ORG, sessionRef: "fone_teste" })).status).toBe("FAILED");
    expect(chamadas).toHaveLength(0);
  });

  it("grupo não tem endereço neste canal", () => {
    expect(
      chatguruAdapter.resolveRecipient({ isGroup: true, groupChatId: "g", phoneNumber: "+5500900000001", waIdentity: null }),
    ).toBeNull();
    expect(
      chatguruAdapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: "+55 00 90000-0001", waIdentity: null }),
    ).toBe("5500900000001");
  });

  it("passagem para a equipe: resumo, campo da IA e diálogo de transferência, nessa ordem", async () => {
    resolver.mockResolvedValue(
      creds({ dialogoTransferencia: "dlg_transfer_01", campoDaIa: { nome: "IA_ATIVA", valorAoPassar: "" } }),
    );
    await chatguruAdapter.aoPassarParaAEquipe!({
      organizationId: ORG,
      sessionRef: "fone_teste",
      recipient: "5500900000001",
      nota: "[IA] Atendimento passado para a equipe.",
    });
    expect(chamadas.map((c) => c.get("action"))).toEqual(["note_add", "chat_update_custom_fields", "dialog_execute"]);
    expect(chamadas[1]?.get("field__IA_ATIVA")).toBe("");
    expect(chamadas[2]?.get("dialog_id")).toBe("dlg_transfer_01");
  });

  it("passagem sem nada configurado não chama a plataforma", async () => {
    resolver.mockResolvedValue(creds());
    await chatguruAdapter.aoPassarParaAEquipe!({
      organizationId: ORG,
      sessionRef: "fone_teste",
      recipient: "5500900000001",
      nota: null,
    });
    expect(chamadas).toHaveLength(0);
  });

  it("mídia recebida: sem seguir redirecionamento e com teto de tamanho (SSRF)", async () => {
    const pedidos: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        pedidos.push(init);
        return new Response("x", { status: 200, headers: { "content-length": String(500 * 1024 * 1024) } });
      }),
    );
    await expect(
      chatguruAdapter.fetchInboundMedia!({ organizationId: ORG, sessionRef: "fone_teste", url: "https://arquivos.exemplo.com.br/a.ogg" }),
    ).rejects.toThrow(/exceeds/);
    expect(pedidos[0]?.redirect).toBe("error");
    // Endereço interno é recusado antes de qualquer pedido.
    await expect(
      chatguruAdapter.fetchInboundMedia!({ organizationId: ORG, sessionRef: "fone_teste", url: "http://169.254.169.254/latest" }),
    ).rejects.toThrow();
    expect(pedidos).toHaveLength(1);
  });

  it("PC-060: tipo genérico do armazenamento cede ao tipo deduzido da mensagem", async () => {
    const resposta = (ct: string) => new Response("abc", { status: 200, headers: { "content-type": ct } });
    vi.stubGlobal("fetch", vi.fn(async () => resposta("binary/octet-stream")));
    const a = await chatguruAdapter.fetchInboundMedia!({ organizationId: ORG, sessionRef: "fone_teste", url: "https://arquivos.exemplo.com.br/a.ogg", hintMime: "audio/ogg" });
    expect(a.mime).toBe("audio/ogg");
    vi.stubGlobal("fetch", vi.fn(async () => resposta("image/jpeg")));
    const b = await chatguruAdapter.fetchInboundMedia!({ organizationId: ORG, sessionRef: "fone_teste", url: "https://arquivos.exemplo.com.br/b.jpg", hintMime: "image/jpeg" });
    expect(b.mime).toBe("image/jpeg");
    vi.stubGlobal("fetch", vi.fn(async () => resposta("application/octet-stream")));
    const c = await chatguruAdapter.fetchInboundMedia!({ organizationId: ORG, sessionRef: "fone_teste", url: "https://arquivos.exemplo.com.br/c" });
    expect(c.mime).toBe("application/octet-stream");
  });

  it("a IA só executa ação LIBERADA na tela, pela chave", async () => {
    resolver.mockResolvedValue(
      creds({ acoes: [{ chave: "etiquetar", nome: "Etiquetar", dialogoId: "dlg_tag_01", quandoUsar: "teste" }] }),
    );
    const acoes = await chatguruAdapter.acoesDoAtendimento!({
      organizationId: ORG,
      sessionRef: "fone_teste",
      recipient: "5500900000001",
    });
    expect(acoes?.acoes.map((a) => a.chave)).toEqual(["etiquetar"]);
    await acoes!.executar("etiquetar");
    expect(chamadas[0]?.get("dialog_id")).toBe("dlg_tag_01");
    await expect(acoes!.executar("dlg_qualquer")).rejects.toThrow(/não liberada/);
    expect(chamadas).toHaveLength(1);
  });
});
