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
const { ingest, phoneDaSessao, enquete, conexoesAtivas, sinalDaEquipe, irma, regraLigada, aplicarRegra } = vi.hoisted(() => ({
  irma: vi.fn(async (..._args: unknown[]) => null as string | null),
  regraLigada: vi.fn(async (..._args: unknown[]) => false),
  aplicarRegra: vi.fn(async (..._args: unknown[]) => "calou"),
  sinalDaEquipe: vi.fn(async (..._args: unknown[]) => ({ reconhecido: false }) as Record<string, unknown>),
  conexoesAtivas: vi.fn(async (..._args: unknown[]) => 1),
  ingest: vi.fn(async (..._args: unknown[]) => ({ status: "ingested", messageId: "m-1", conversationId: "c-1" })),
  phoneDaSessao: vi.fn(async (..._args: unknown[]) => "fone-da-empresa-a" as string | null),
  enquete: vi.fn(async (..._args: unknown[]) => ({ status: "sem_enquete" }) as Record<string, unknown>),
}));
vi.mock("./ingest", () => ({ ingestAtendimentoExterno: ingest }));
vi.mock("./enquete", () => ({ tratarEnqueteDoPost: enquete }));
vi.mock("./equipe-assumiu", () => ({ tratarEquipeAssumiuDoPost: sinalDaEquipe }));
vi.mock("./responsavel", () => ({ regraDoResponsavelLigada: regraLigada, aplicarRegraDoResponsavel: aplicarRegra }));
vi.mock("./sessao", async (original) => ({
  ...((await original()) as Record<string, unknown>),
  phoneIdDaSessao: phoneDaSessao,
  contarConexoesAtivas: conexoesAtivas,
  conexaoIrmaDoNumero: irma,
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
  enquete.mockClear();
  sinalDaEquipe.mockReset();
  sinalDaEquipe.mockResolvedValue({ reconhecido: false });
  conexoesAtivas.mockReset();
  conexoesAtivas.mockResolvedValue(1);
  irma.mockReset();
  irma.mockResolvedValue(null);
  regraLigada.mockReset();
  regraLigada.mockResolvedValue(false);
  aplicarRegra.mockClear();
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

  it("PC-053: com DOIS números na empresa, corpo sem phone_id é recusado (não dá para saber de qual número é)", async () => {
    conexoesAtivas.mockResolvedValue(2);
    const ok = await inboundPayloadBelongsToSession(admin, {
      session: sessao(ORG_A, "sess-a"),
      rawBody: JSON.stringify({ celular: "5500900000001", texto_mensagem: "oi" }),
      headers: new Headers(),
      secret: SEGREDO_A,
    });
    expect(ok).toBe(false);
    // A contagem foi feita escopada pela organização da sessão, nunca pelo corpo.
    expect(conexoesAtivas).toHaveBeenCalledWith(admin, ORG_A);
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

describe("entrada do canal — o voto na enquete do grupo (PC-050)", () => {
  const entregar = (rawBody: string) =>
    handleInboundWebhook(admin, {
      session: sessao(ORG_A, "sess-a"),
      rawBody,
      headers: new Headers({ [HEADER_DO_SEGREDO]: SEGREDO_A }),
      secret: SEGREDO_A,
    });
  const VOTO = { status: "registrado", enqueteId: "e1", contactId: "c1", opcao: "Quero que me chamem" };

  it("⭐ voto NOVO é a ativação: mesmo COM texto, nada é ingerido e a IA não roda", async () => {
    enquete.mockResolvedValueOnce({ ...VOTO, mudou: true });
    const r = await entregar(corpo({ texto_mensagem: "Olá! Vi que você votou na enquete." }));
    expect(r).toEqual({ ok: true, body: { status: "enquete_registrada", mudou: true, reason: "enquete_ativacao" } });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("o mesmo voto de novo com texto é conversa: entra como sempre", async () => {
    enquete.mockResolvedValueOnce({ ...VOTO, mudou: false });
    const r = await entregar(corpo({ texto_mensagem: "quero saber mais" }));
    expect(r.ok).toBe(true);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("ativação SEM texto termina aqui, com ou sem contato", async () => {
    enquete.mockResolvedValueOnce({ ...VOTO, mudou: false });
    expect(await entregar(JSON.stringify({ celular: "5500900000001", phone_id: "fone-da-empresa-a" }))).toEqual({
      ok: true,
      body: { status: "enquete_registrada", mudou: false, reason: "enquete_ativacao" },
    });
    enquete.mockResolvedValueOnce({ status: "sem_contato" });
    expect(await entregar(JSON.stringify({ celular: "5500900000001", phone_id: "fone-da-empresa-a" }))).toEqual({
      ok: true,
      body: { status: "enquete_sem_contato", reason: "enquete_sem_contato" },
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("quem votou 'não quero contato' e depois ESCREVE: a mensagem entra (o voto não engole conversa)", async () => {
    enquete.mockResolvedValueOnce({ status: "sem_contato" });
    await entregar(corpo({ texto_mensagem: "mudei de ideia" }));
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("⭐ 'não quero contato' com o voto no chat em TODO POST: 3 mensagens, 3 ingeridas (nenhuma engolida)", async () => {
    // Estado de verdade, como o banco: o contato nasce na 1ª mensagem; o voto é
    // gravado logo depois dela; dali em diante o mesmo voto é "mudou: false".
    let contatoExiste = false;
    let votoGravado = false;
    enquete.mockImplementation(async () => {
      if (!contatoExiste) return { status: "sem_contato" };
      if (!votoGravado) {
        votoGravado = true;
        return { ...VOTO, mudou: true };
      }
      return { ...VOTO, mudou: false };
    });
    ingest.mockImplementation(async () => {
      contatoExiste = true;
      return { status: "ingested", messageId: "m-1", conversationId: "c-1" };
    });
    for (const texto of ["oi", "mudei de ideia", "pode me chamar"]) {
      const r = await entregar(corpo({ texto_mensagem: texto, bot_context: "enquete:reparadora:Agora não" }));
      expect(r.ok).toBe(true);
    }
    expect(ingest).toHaveBeenCalledTimes(3);
    enquete.mockReset();
    enquete.mockImplementation(async () => ({ status: "sem_enquete" }));
    ingest.mockReset();
    ingest.mockImplementation(async () => ({ status: "ingested", messageId: "m-1", conversationId: "c-1" }));
  });

  it("chave desligada: a enquete não muda nada na entrada", async () => {
    const r = await entregar(corpo());
    expect(r.ok).toBe(true);
    expect(ingest).toHaveBeenCalledTimes(1);
  });
});

describe("entrada do canal dentro da plataforma — equipe assumiu (PC-058)", () => {
  const chamar = () =>
    handleInboundWebhook(admin, {
      session: sessao(ORG_A, "sess-a"),
      rawBody: corpo({ campos_personalizados: { LSIA: "assumido" } }),
      headers: new Headers({ [HEADER_DO_SEGREDO]: SEGREDO_A }),
      secret: SEGREDO_A,
    });

  it("o sinal reconhecido NÃO vira mensagem e responde equipe_assumiu", async () => {
    sinalDaEquipe.mockResolvedValue({ reconhecido: true, status: "aplicado", cardMovidoPara: "e-1" });
    const r = await chamar();
    expect(r).toEqual({ ok: true, body: { status: "equipe_assumiu", reason: "aplicado" } });
    expect(ingest).not.toHaveBeenCalled();
    // A organização e o número vêm da sessão (token do caminho), nunca do corpo.
    expect(sinalDaEquipe).toHaveBeenCalledWith(admin, expect.objectContaining({ orgId: ORG_A, channelSessionId: "sess-a" }));
  });

  it("sem o sinal (ou desligado), a mensagem entra como sempre", async () => {
    const r = await chamar();
    expect(r.ok).toBe(true);
    expect(ingest).toHaveBeenCalledTimes(1);
  });
});

describe("entrada do canal — o outro número da mesma conta pelo mesmo endereço", () => {
  const doOutroNumero = () => corpo({ phone_id: "fone-por-qr-da-mesma-conta" });

  it("a guarda aceita quando o número é de uma conexão IRMÃ (mesma organização e conta), escopada pela sessão", async () => {
    irma.mockResolvedValue("sess-irma");
    const ok = await inboundPayloadBelongsToSession(admin, {
      session: sessao(ORG_A, "sess-a"),
      rawBody: doOutroNumero(),
      headers: new Headers(),
      secret: SEGREDO_A,
    });
    expect(ok).toBe(true);
    expect(irma).toHaveBeenCalledWith(admin, ORG_A, "sess-a", "fone-por-qr-da-mesma-conta");
  });

  it("a mensagem do outro número é gravada na conexão DELE (a resposta sai pelo número certo)", async () => {
    irma.mockResolvedValue("sess-irma");
    const r = await handleInboundWebhook(admin, {
      session: sessao(ORG_A, "sess-a"),
      rawBody: doOutroNumero(),
      headers: new Headers({ [HEADER_DO_SEGREDO]: SEGREDO_A }),
      secret: SEGREDO_A,
    });
    expect(r.ok).toBe(true);
    expect(ingest).toHaveBeenCalledWith(
      admin,
      expect.anything(),
      expect.objectContaining({ organizationId: ORG_A, channelSessionId: "sess-irma" }),
    );
  });

  it("sem conexão irmã, nada entra", async () => {
    const r = await handleInboundWebhook(admin, {
      session: sessao(ORG_A, "sess-a"),
      rawBody: doOutroNumero(),
      headers: new Headers({ [HEADER_DO_SEGREDO]: SEGREDO_A }),
      secret: SEGREDO_A,
    });
    expect(r).toEqual({ ok: true, body: { status: "ignored", reason: "evento_de_outra_conta" } });
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe("entrada do canal — o responsável pelo chat decide a IA", () => {
  const chamar = (extra: Record<string, unknown> = {}) =>
    handleInboundWebhook(admin, {
      session: sessao(ORG_A, "sess-a"),
      rawBody: corpo(extra),
      headers: new Headers({ [HEADER_DO_SEGREDO]: SEGREDO_A }),
      secret: SEGREDO_A,
    });

  it("chave desligada: a ingestão não recebe a regra (como antes)", async () => {
    await chamar({ responsavel_email: "pessoa@exemplo.test" });
    const dono = ingest.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(dono.antesDaMensagem).toBeUndefined();
    expect(aplicarRegra).not.toHaveBeenCalled();
  });

  it("chave ligada: a regra roda antes da mensagem, com a organização e a conexão do token", async () => {
    regraLigada.mockResolvedValue(true);
    await chamar({ responsavel_email: "pessoa@exemplo.test" });
    expect(regraLigada).toHaveBeenCalledWith(admin, ORG_A, "sess-a");
    const dono = ingest.mock.calls[0]?.[2] as { antesDaMensagem?: (c: string) => Promise<void> };
    expect(typeof dono.antesDaMensagem).toBe("function");
    await dono.antesDaMensagem!("conv-9");
    expect(aplicarRegra).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ orgId: ORG_A, channelSessionId: "sess-a", conversationId: "conv-9", ligado: true }),
    );
  });
});
