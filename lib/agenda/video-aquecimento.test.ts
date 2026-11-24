import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { enviarVideoDeAquecimento, intervaloEntreMensagens, prepararVideoDeAquecimento } from "@/lib/agent-engine/agent/meet-delivery";
import { corpoDoEnvio } from "@/lib/agent-engine/edge/crm/send-message";

import { cabecalhoDeMp4, caminhoDoVideo, caminhoNaConversa, conferirVideo, VIDEO_MAX_BYTES, videoPertenceAOrg } from "./video-aquecimento";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";

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
    // Nomeado pelo arquivo de origem: a mesma conversa guarda UMA cópia de cada vídeo.
    const arquivo = c.slice(c.lastIndexOf("/") + 1);
    expect(caminhoNaConversa(ORG, CONVERSA, c)).toBe(`${ORG}/${CONVERSA}/aquecimento-${arquivo}`);
  });

  it("⭐ o conteúdo é conferido: mp4/3gp começam pela caixa ftyp; extensão trocada não passa", () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(cabecalhoDeMp4(mp4)).toBe(true);
    expect(cabecalhoDeMp4(new TextEncoder().encode("<html>nao e video"))).toBe(false);
    expect(cabecalhoDeMp4(new Uint8Array([0, 0, 0]))).toBe(false);
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

describe("o vídeo depois da confirmação (meet-delivery)", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const pool = (rows: unknown[]) => ({ query: vi.fn(async () => ({ rows })) }) as never;
  const p = { orgId: ORG, conversationId: CONVERSA };

  it("⭐ sem vídeo cadastrado: nada é copiado (como antes)", async () => {
    const copiar = vi.fn();
    expect(await prepararVideoDeAquecimento(pool([]), log as never, copiar, p)).toBeNull();
    expect(copiar).not.toHaveBeenCalled();
  });

  it("com vídeo: copia para a pasta da conversa e devolve o que vai sair", async () => {
    const copiar = vi.fn(async () => true);
    const origem = `${ORG}/aquecimento/abc.mp4`;
    const v = await prepararVideoDeAquecimento(pool([{ storage_path: origem, mime: "video/mp4", texto: " Assista antes da conversa " }]), log as never, copiar, p);
    expect(copiar).toHaveBeenCalledWith(origem, `${ORG}/${CONVERSA}/aquecimento-abc.mp4`);
    expect(v).toEqual({ destino: `${ORG}/${CONVERSA}/aquecimento-abc.mp4`, mime: "video/mp4", texto: "Assista antes da conversa" });
  });

  it("caminho de outra organização, cópia que falha ou leitura que lança: null, sem exceção", async () => {
    const copiar = vi.fn(async () => true);
    expect(await prepararVideoDeAquecimento(pool([{ storage_path: "outra-org/aquecimento/x.mp4", mime: "video/mp4", texto: null }]), log as never, copiar, p)).toBeNull();
    expect(copiar).not.toHaveBeenCalled();
    expect(await prepararVideoDeAquecimento(pool([{ storage_path: `${ORG}/aquecimento/x.mp4`, mime: "video/mp4", texto: null }]), log as never, vi.fn(async () => false), p)).toBeNull();
    const quebrado = { query: vi.fn(async () => { throw new Error("db caiu"); }) } as never;
    await expect(prepararVideoDeAquecimento(quebrado, log as never, copiar, p)).resolves.toBeNull();
  });

  it("⭐ anti-ban: espera o intervalo (1,2 s + até 0,8 s) antes do vídeo; falha no envio não sobe", async () => {
    const esperas: number[] = [];
    const sleep = vi.fn(async (ms: number) => void esperas.push(ms));
    const v = { destino: `${ORG}/${CONVERSA}/aquecimento-abc.mp4`, mime: "video/mp4", texto: "" };
    const enviar = vi.fn(async () => ({ kind: "sent" }));
    await enviarVideoDeAquecimento(log as never, sleep, enviar, v);
    expect(esperas[0]).toBeGreaterThanOrEqual(1200);
    expect(esperas[0]).toBeLessThan(2000);
    expect(enviar).toHaveBeenCalledWith(v);
    const caiu = vi.fn(async () => { throw new Error("canal caiu"); });
    await expect(enviarVideoDeAquecimento(log as never, sleep, caiu, v)).resolves.toBeUndefined();
    expect(intervaloEntreMensagens(() => 0)).toBe(1200);
    expect(intervaloEntreMensagens(() => 0.999)).toBe(1999);
  });
});
