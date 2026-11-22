import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A entrada do canal dentro da plataforma de atendimento (PC-047), do lado de
 * dentro do seam: segredo, guarda de conta e isolamento entre organizações.
 *
 * O isolamento que importa aqui é de ORIGEM: a organização e a sessão vêm do
 * token do caminho (a rota resolve) e do segredo da conexão — nunca do corpo.
 * Um corpo que diga ser de outro número, ou que traga dados de outra empresa,
 * não escolhe onde a mensagem é gravada.
 */
const { ingest, phoneDaSessao } = vi.hoisted(() => ({
  ingest: vi.fn(async (..._args: unknown[]) => ({ status: "ingested", messageId: "m-1", conversationId: "c-1" })),
  phoneDaSessao: vi.fn(async (..._args: unknown[]) => "fone-da-empresa-a" as string | null),
}));
vi.mock("./ingest", () => ({ ingestAtendimentoExterno: ingest }));
vi.mock("./sessao", async (original) => ({
  ...((await original()) as Record<string, unknown>),
  phoneIdDaSessao: phoneDaSessao,
}));

import {
  acceptsInboundWebhook,
  handleInboundWebhook,
  inboundPayloadBelongsToSession,
  verifyInboundWebhookSignature,
} from "../inbound";
import { HEADER_DO_SEGREDO } from "./entrada";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const SEGREDO_A = "a".repeat(64);
const SEGREDO_B = "b".repeat(64);
const admin = {} as never;

function sessao(org: string, id: string) {
  return { id, organization_id: org, provider: "chatguru", display_name: null, phone_number: null };
}

function corpo(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ celular: "5500900000001", texto_mensagem: "oi", phone_id: "fone-da-empresa-a", ...extra });
}

beforeEach(() => {
  ingest.mockClear();
  phoneDaSessao.mockClear();
});

describe("entrada do canal dentro da plataforma — segredo", () => {
  it("o canal recebe pela rota de token", () => {
    expect(acceptsInboundWebhook("chatguru")).toBe(true);
  });

  it("segredo errado = recusa, e NADA é gravado", async () => {
    const r = await handleInboundWebhook(admin, {
      session: sessao(ORG_A, "sess-a"),
      rawBody: corpo(),
      headers: new Headers({ [HEADER_DO_SEGREDO]: SEGREDO_B }),
      secret: SEGREDO_A,
    });
    expect(r).toEqual({ ok: false, code: "unauthorized", message: "bad_secret" });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("sem segredo no pedido também recusa (a rota nunca chama sem conferir)", () => {
    expect(verifyInboundWebhookSignature("chatguru", corpo(), new Headers(), SEGREDO_A)).toBe(false);
    expect(verifyInboundWebhookSignature("chatguru", corpo(), new Headers({ [HEADER_DO_SEGREDO]: SEGREDO_A }), SEGREDO_A)).toBe(
      true,
    );
  });
});

describe("entrada do canal dentro da plataforma — isolamento entre organizações", () => {
  it("a mensagem é gravada na organização e na sessão do TOKEN, não do corpo", async () => {
    const r = await handleInboundWebhook(admin, {
      session: sessao(ORG_A, "sess-a"),
      // O corpo tenta se passar por outra empresa: não muda nada.
      rawBody: corpo({ organization_id: ORG_B, account_id: "conta-da-empresa-b" }),
      headers: new Headers({ [HEADER_DO_SEGREDO]: SEGREDO_A }),
      secret: SEGREDO_A,
    });
    expect(r.ok).toBe(true);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]?.[2]).toEqual({ organizationId: ORG_A, channelSessionId: "sess-a" });
  });

  it("o segredo de uma empresa não abre a entrada da outra", async () => {
    const r = await handleInboundWebhook(admin, {
      session: sessao(ORG_B, "sess-b"),
      rawBody: corpo(),
      headers: new Headers({ [HEADER_DO_SEGREDO]: SEGREDO_A }),
      secret: SEGREDO_B,
    });
    expect(r.ok).toBe(false);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("chat de OUTRO número da conta não entra nesta conexão", async () => {
    phoneDaSessao.mockResolvedValueOnce("fone-da-empresa-a");
    const deOutro = await inboundPayloadBelongsToSession(admin, {
      session: sessao(ORG_A, "sess-a"),
      rawBody: corpo({ phone_id: "fone-por-qr-da-mesma-conta" }),
      headers: new Headers(),
      secret: SEGREDO_A,
    });
    expect(deOutro).toBe(false);
    // A pergunta foi feita escopada pela organização da sessão.
    expect(phoneDaSessao).toHaveBeenCalledWith(admin, ORG_A, "sess-a");
  });

  it("corpo sem phone_id passa (o segredo já diz de quem é a entrega)", async () => {
    const ok = await inboundPayloadBelongsToSession(admin, {
      session: sessao(ORG_A, "sess-a"),
      rawBody: JSON.stringify({ celular: "5500900000001", texto_mensagem: "oi" }),
      headers: new Headers(),
      secret: SEGREDO_A,
    });
    expect(ok).toBe(true);
    expect(phoneDaSessao).not.toHaveBeenCalled();
  });

  it("grupo responde 200 com o motivo e não grava", async () => {
    const r = await handleInboundWebhook(admin, {
      session: sessao(ORG_A, "sess-a"),
      rawBody: corpo({ celular: "120363000000000000@g.us" }),
      headers: new Headers({ [HEADER_DO_SEGREDO]: SEGREDO_A }),
      secret: SEGREDO_A,
    });
    expect(r).toEqual({ ok: true, body: { status: "ignored", reason: "grupo_ou_endereco_nao_suportado" } });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("falha de escrita sobe como exceção (a rota responde 500 e a plataforma reentrega)", async () => {
    ingest.mockResolvedValueOnce({ status: "failed", reason: "mensagem: falhou" } as never);
    await expect(
      handleInboundWebhook(admin, {
        session: sessao(ORG_A, "sess-a"),
        rawBody: corpo(),
        headers: new Headers({ [HEADER_DO_SEGREDO]: SEGREDO_A }),
        secret: SEGREDO_A,
      }),
    ).rejects.toThrow(/ingestao_falhou/);
  });
});
