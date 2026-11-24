import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { enviarVideoDeAquecimento } from "@/lib/agent-engine/agent/meet-delivery";
import { corpoDoEnvio } from "@/lib/agent-engine/edge/crm/send-message";

import { caminhoDoVideo, caminhoNaConversa, conferirVideo, VIDEO_MAX_BYTES, videoPertenceAOrg } from "./video-aquecimento";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const COMPROMISSO = "33333333-3333-4333-8333-333333333333";

describe("o arquivo do vídeo de aquecimento (PC-045 parte 2)", () => {
  it("⭐ mp4 até 16 MB; outro formato ou maior é recusado com o motivo", () => {
    expect(conferirVideo({ type: "video/mp4", size: 1000 })).toBeNull();
    expect(conferirVideo({ type: "video/mp4", size: VIDEO_MAX_BYTES + 1 })).toBe("tamanho");
    expect(conferirVideo({ type: "video/quicktime", size: 1000 })).toBe("formato");
    expect(conferirVideo({ type: "video/mp4", size: 0 })).toBe("vazio");
  });

  it("o caminho é da organização, na pasta do aquecimento; nada de ..", () => {
    const c = caminhoDoVideo(ORG, "video/mp4");
    expect(c.startsWith(`${ORG}/aquecimento/`)).toBe(true);
    expect(videoPertenceAOrg(c, ORG)).toBe(true);
    expect(videoPertenceAOrg(c, "44444444-4444-4444-8444-444444444444")).toBe(false);
    expect(videoPertenceAOrg(`${ORG}/aquecimento/../outra/x.mp4`, ORG)).toBe(false);
    expect(caminhoNaConversa(ORG, CONVERSA, COMPROMISSO, c)).toBe(`${ORG}/${CONVERSA}/aquecimento-${COMPROMISSO}.mp4`);
  });

  it("o vídeo da conversa chega ao handler como VÍDEO, sem corpo quando não há texto", () => {
    const corpo = corpoDoEnvio(
      { tenantId: ORG, leadId: null, jobId: "j", seq: 2, conversationId: CONVERSA, body: "", media: { storagePath: "x", mime: "video/mp4", type: "video" } },
      "k",
    );
    expect(corpo).toMatchObject({ type: "video", media_storage_path: "x", media_mime: "video/mp4" });
    expect(corpo).not.toHaveProperty("body");
    const foto = corpoDoEnvio({ tenantId: ORG, leadId: null, jobId: "j", seq: 1, conversationId: CONVERSA, body: "", media: { storagePath: "y", mime: "image/jpeg" } }, "k");
    expect(foto).toMatchObject({ type: "image" });
  });
});

describe("enviarVideoDeAquecimento — depois da confirmação", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const base = {
    orgId: ORG,
    conversationId: CONVERSA,
    appointmentId: COMPROMISSO,
    contactId: "c",
    jobId: "job-1",
    jobClaim: { worker_id: "w", acquired_at: "2026-11-24T00:00:00Z" },
  };
  const pool = (rows: unknown[]) => ({ query: vi.fn(async () => ({ rows })) }) as never;

  it("⭐ sem vídeo cadastrado: nada é copiado nem enviado (como antes)", async () => {
    const send = vi.fn();
    const copiar = vi.fn();
    await enviarVideoDeAquecimento(pool([]), log as never, copiar, { ...base, channel: { send } as never });
    expect(copiar).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("⭐ com vídeo: copia para a conversa e manda como a 2ª mensagem do MESMO job", async () => {
    const send = vi.fn(async () => ({ kind: "sent", idempotencyKey: "k", messageId: "m" }));
    const copiar = vi.fn(async () => true);
    const origem = `${ORG}/aquecimento/abc.mp4`;
    await enviarVideoDeAquecimento(pool([{ storage_path: origem, mime: "video/mp4", texto: " Assista antes da conversa " }]), log as never, copiar, {
      ...base,
      channel: { send } as never,
    });
    expect(copiar).toHaveBeenCalledWith(origem, `${ORG}/${CONVERSA}/aquecimento-${COMPROMISSO}.mp4`);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1", seq: 2, body: "Assista antes da conversa", media: expect.objectContaining({ type: "video" }) }),
    );
  });

  it("caminho de outra organização, cópia que falha ou envio que lança: nada derruba a confirmação", async () => {
    const send = vi.fn(async () => {
      throw new Error("canal caiu");
    });
    await enviarVideoDeAquecimento(pool([{ storage_path: "outra-org/aquecimento/x.mp4", mime: "video/mp4", texto: null }]), log as never, vi.fn(), {
      ...base,
      channel: { send } as never,
    });
    expect(send).not.toHaveBeenCalled();
    await enviarVideoDeAquecimento(pool([{ storage_path: `${ORG}/aquecimento/x.mp4`, mime: "video/mp4", texto: null }]), log as never, vi.fn(async () => false), {
      ...base,
      channel: { send } as never,
    });
    expect(send).not.toHaveBeenCalled();
    await expect(
      enviarVideoDeAquecimento(pool([{ storage_path: `${ORG}/aquecimento/x.mp4`, mime: "video/mp4", texto: null }]), log as never, vi.fn(async () => true), {
        ...base,
        channel: { send } as never,
      }),
    ).resolves.toBeUndefined();
  });
});
