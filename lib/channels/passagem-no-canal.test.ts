import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O lado do CANAL da passagem para a equipe (PC-047): só o canal que sabe faz
 * alguma coisa, o endereço prefere o número como a plataforma o tem, e nada
 * aqui derruba a passagem que já aconteceu no CRM.
 */
const { passar, acoesFake } = vi.hoisted(() => ({
  passar: vi.fn(async (..._args: unknown[]) => undefined),
  acoesFake: vi.fn(async (..._args: unknown[]) => ({ rotulo: "X", acoes: [], anotar: async () => {}, executar: async () => {} })),
}));
vi.mock("./index", () => ({
  getAdapter: (provider: string) =>
    provider === "chatguru"
      ? {
          provider,
          resolveRecipient: () => "5500900000001",
          aoPassarParaAEquipe: passar,
          acoesDoAtendimento: acoesFake,
        }
      : { provider, resolveRecipient: () => "5500900000001" },
}));

import { acoesDoAtendimentoNoTurno, avisarCanalDaPassagem } from "./passagem-no-canal";

const ORG = "00000000-0000-4000-8000-0000000000aa";

function db(linha: Record<string, unknown> | null) {
  const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: linha ? [linha] : [] }));
  return { query };
}

const BASE = {
  waha_session_name: null,
  meta_phone_number_id: null,
  zernio_account_id: null,
  datafy_phone_number_id: null,
  chatguru_phone_id: null,
  provider_conversation_id: null,
  phone_number: "+5500900000001",
  is_group: false,
};

beforeEach(() => {
  passar.mockClear();
  acoesFake.mockClear();
});

describe("passagem no canal", () => {
  it("canal que não sabe: nada a fazer, nenhuma chamada", async () => {
    const r = await avisarCanalDaPassagem(db({ ...BASE, provider: "waha", waha_session_name: "s1" }), {
      organizationId: ORG,
      conversationId: "c-1",
      nota: "x",
    });
    expect(r).toEqual({ desfecho: "sem_acao" });
    expect(passar).not.toHaveBeenCalled();
  });

  it("canal que sabe: devolve o chat pelo número COMO A PLATAFORMA O TEM", async () => {
    const consulta = db({
      ...BASE,
      provider: "chatguru",
      chatguru_phone_id: "fone-1",
      provider_conversation_id: "550090000001",
    });
    const r = await avisarCanalDaPassagem(consulta, { organizationId: ORG, conversationId: "c-1", nota: "resumo" });
    expect(r).toEqual({ desfecho: "feito" });
    expect(passar).toHaveBeenCalledWith({
      organizationId: ORG,
      sessionRef: "fone-1",
      recipient: "550090000001",
      nota: "resumo",
    });
    // A consulta é escopada pela organização.
    expect(consulta.query.mock.calls[0]?.[1]).toEqual([ORG, "c-1"]);
  });

  it("falha da plataforma vira desfecho, nunca exceção", async () => {
    passar.mockRejectedValueOnce(new Error("chatguru_400: recusado"));
    const r = await avisarCanalDaPassagem(db({ ...BASE, provider: "chatguru", chatguru_phone_id: "fone-1" }), {
      organizationId: ORG,
      conversationId: "c-1",
      nota: null,
    });
    expect(r).toEqual({ desfecho: "falhou", motivo: "chatguru_400: recusado" });
  });

  it("conversa que não existe (ou de outra organização): nada a fazer", async () => {
    const r = await avisarCanalDaPassagem(db(null), { organizationId: ORG, conversationId: "c-x", nota: null });
    expect(r).toEqual({ desfecho: "sem_acao" });
  });

  it("banco fora do ar não derruba quem chama", async () => {
    const quebrado = { query: vi.fn(async () => Promise.reject(new Error("conexão caiu"))) };
    const r = await avisarCanalDaPassagem(quebrado, { organizationId: ORG, conversationId: "c-1", nota: null });
    expect(r).toEqual({ desfecho: "falhou", motivo: "conexão caiu" });
    expect(await acoesDoAtendimentoNoTurno(quebrado, { organizationId: ORG, conversationId: "c-1" })).toBeNull();
  });
});

describe("ações do atendimento no turno", () => {
  it("só o canal que sabe oferece ações", async () => {
    expect(
      await acoesDoAtendimentoNoTurno(db({ ...BASE, provider: "waha", waha_session_name: "s1" }), {
        organizationId: ORG,
        conversationId: "c-1",
      }),
    ).toBeNull();
    const acoes = await acoesDoAtendimentoNoTurno(db({ ...BASE, provider: "chatguru", chatguru_phone_id: "fone-1" }), {
      organizationId: ORG,
      conversationId: "c-1",
    });
    expect(acoes?.rotulo).toBe("X");
    expect(acoesFake).toHaveBeenCalledWith({ organizationId: ORG, sessionRef: "fone-1", recipient: "5500900000001" });
  });
});
