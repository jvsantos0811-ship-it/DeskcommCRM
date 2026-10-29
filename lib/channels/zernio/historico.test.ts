import { describe, expect, it } from "vitest";

import { lerPaginaDeConversas, lerPaginaDeMensagens, trechoParaTriagem } from "./historico";

const CONTA = "acc_1";

describe("lerPaginaDeConversas", () => {
  it("lê a pessoa pela conversa: telefone sem + vira E.164, BSUID vira âncora", () => {
    const r = lerPaginaDeConversas(
      {
        data: [
          {
            id: "conv_a",
            platform: "whatsapp",
            accountId: CONTA,
            participantId: "5531999990000",
            participantName: "Maria",
            businessScopedUserId: "BR.123",
            updatedTime: "2026-05-01T10:00:00Z",
            isGroup: false,
          },
          { id: "conv_b", platform: "whatsapp", accountId: CONTA, participantId: "5531988887777" },
        ],
        pagination: { hasMore: true, nextCursor: "c2" },
      },
      CONTA,
    );
    expect(r.conversas).toHaveLength(2);
    expect(r.conversas[0]!.identity.phone).toBe("+5531999990000");
    expect(r.conversas[0]!.identity.anchor).toEqual({ kind: "bsuid", value: "BR.123" });
    expect(r.conversas[0]!.identity.displayName).toBe("Maria");
    expect(r.conversas[1]!.identity.anchor).toEqual({ kind: "phone", value: "+5531988887777" });
    expect(r.proximoCursor).toBe("c2");
  });

  it("descarta outra rede e outra conta, e conta quem veio sem identidade", () => {
    const r = lerPaginaDeConversas(
      {
        data: [
          { id: "ig", platform: "instagram", accountId: CONTA, participantId: "5531999990000" },
          { id: "outra", platform: "whatsapp", accountId: "acc_2", participantId: "5531999990000" },
          { id: "anonima", platform: "whatsapp", accountId: CONTA },
        ],
        pagination: { hasMore: false, nextCursor: "ignorado" },
      },
      CONTA,
    );
    expect(r.conversas).toHaveLength(0);
    expect(r.semIdentidade).toBe(1);
    // Sem `hasMore`, o cursor que sobrar na resposta não é seguido.
    expect(r.proximoCursor).toBeNull();
  });

  it("grupo passa adiante marcado — quem decide pular é o importador", () => {
    const r = lerPaginaDeConversas({ data: [{ id: "g", platform: "whatsapp", isGroup: true }] }, CONTA);
    expect(r.conversas[0]!.isGroup).toBe(true);
  });

  it("a recusa da conta pelo provedor vem com o tempo de espera", () => {
    const r = lerPaginaDeConversas(
      { data: [], meta: { failedAccounts: [{ accountId: CONTA, error: "rate", retryAfter: 30 }] } },
      CONTA,
    );
    expect(r.contaRecusada).toEqual({ erro: "rate", esperarSegundos: 30 });
  });
});

describe("lerPaginaDeMensagens", () => {
  it("mensagem do cliente e do escritório, com a data original e o wamid como id", () => {
    const r = lerPaginaDeMensagens({
      messages: [
        { id: "wamid.1", direction: "incoming", message: "Oi", sentAt: "2026-05-01T10:00:00Z" },
        {
          id: "wamid.2",
          direction: "outgoing",
          message: "Olá!",
          createdAt: "2026-05-01T10:05:00Z",
          deliveryStatus: "read",
        },
      ],
      pagination: { hasMore: false },
    });
    expect(r.mensagens).toEqual([
      expect.objectContaining({
        externalId: "wamid.1",
        direction: "inbound",
        sentAt: "2026-05-01T10:00:00.000Z",
        type: "text",
        body: "Oi",
        status: "delivered",
      }),
      expect.objectContaining({ externalId: "wamid.2", direction: "outbound", status: "read" }),
    ]);
    expect(r.mensagens[0]!.metadata.importado_de).toBe("zernio");
    expect(r.proximoCursor).toBeNull();
  });

  it("platformMessageId vence o id, como no webhook", () => {
    const r = lerPaginaDeMensagens({
      messages: [{ id: "z_1", platformMessageId: "wamid.X", direction: "incoming", message: "a", sentAt: "2026-05-01T10:00:00Z" }],
    });
    expect(r.mensagens[0]!.externalId).toBe("wamid.X");
  });

  it("mídia antiga sem arquivo é marcada; mídia com arquivo leva a url e o tipo", () => {
    const r = lerPaginaDeMensagens({
      messages: [
        { id: "m1", direction: "incoming", sentAt: "2026-05-01T10:00:00Z", attachments: [{ type: "image" }] },
        {
          id: "m2",
          direction: "incoming",
          sentAt: "2026-10-20T10:00:00Z",
          attachments: [{ type: "file", url: "https://x/y.pdf", mimeType: "application/pdf", filename: "rg.pdf" }],
        },
      ],
    });
    expect(r.mensagens[0]).toMatchObject({ type: "image", mediaUrl: null, midiaSemArquivo: true });
    expect(r.mensagens[1]).toMatchObject({
      type: "document",
      mediaUrl: "https://x/y.pdf",
      mediaMime: "application/pdf",
      midiaSemArquivo: false,
    });
  });

  it("apagada, sem data, sem id ou sem conteúdo não entra — e é contada", () => {
    const r = lerPaginaDeMensagens({
      messages: [
        { id: "a", direction: "incoming", message: "x", sentAt: "2026-05-01T10:00:00Z", isDeleted: true },
        { id: "b", direction: "incoming", message: "x" },
        { direction: "incoming", message: "x", sentAt: "2026-05-01T10:00:00Z" },
        { id: "c", direction: "incoming", sentAt: "2026-05-01T10:00:00Z" },
      ],
    });
    expect(r.mensagens).toHaveLength(0);
    expect(r.ignoradas).toBe(4);
  });

  it("o pino vem da metadata e vira localização", () => {
    const r = lerPaginaDeMensagens({
      messages: [
        {
          id: "p",
          direction: "incoming",
          message: "📍 Location",
          sentAt: "2026-05-01T10:00:00Z",
          metadata: { location: { latitude: -19.9, longitude: -43.9 } },
        },
      ],
    });
    expect(r.mensagens[0]!.type).toBe("location");
    expect(r.mensagens[0]!.body).toContain("📍");
  });

  it("segue o cursor só quando há mais", () => {
    expect(lerPaginaDeMensagens({ messages: [], pagination: { hasMore: true, nextCursor: "n" } }).proximoCursor).toBe("n");
  });
});

describe("trechoParaTriagem", () => {
  it("as últimas 7, em ordem de tempo, com a data e quem falou", () => {
    const msgs = Array.from({ length: 9 }, (_, i) => ({
      direction: (i % 2 === 0 ? "inbound" : "outbound") as "inbound" | "outbound",
      sentAt: `2026-05-0${i + 1}T10:00:00.000Z`,
      body: `m${i}`,
      type: "text" as const,
    })).reverse();
    const t = trechoParaTriagem(msgs).split("\n");
    expect(t).toHaveLength(7);
    expect(t[0]).toBe("2026-05-03 CLIENTE: m2");
    expect(t[6]).toBe("2026-05-09 CLIENTE: m8");
  });

  it("conversa curta: lê todas", () => {
    expect(
      trechoParaTriagem([{ direction: "outbound", sentAt: "2026-05-01T10:00:00Z", body: null, type: "image" }]),
    ).toBe("2026-05-01 ESCRITÓRIO: [image]");
  });
});
