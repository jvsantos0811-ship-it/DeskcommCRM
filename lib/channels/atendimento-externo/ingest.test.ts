import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ingestão do canal dentro da plataforma de atendimento (PC-047). O cliente do
 * banco é um gravador: cada consulta, escrita e RPC fica registrada, e o teste
 * confere que TODAS levam a organização de quem chamou — o client é de service
 * role e ignora a RLS, então o filtro à mão é a única defesa.
 */
const { efeitos, marcar } = vi.hoisted(() => ({
  efeitos: vi.fn(async (..._args: unknown[]) => undefined),
  marcar: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("@/lib/escalacao/resposta-whatsapp-ao-caso", () => ({
  consumirRespostaDoSuporteNoWhatsApp: async () => false,
}));
vi.mock("../contato-por-telefone", () => ({ encontrarContatoPorTelefone: async () => null }));
vi.mock("../pos-entrada", () => ({ aplicarEfeitosPosEntrada: efeitos }));
vi.mock("../marcar-conversa", () => ({ marcarConversaComMensagem: marcar }));

import { lerEntrada } from "./entrada";
import { ingestAtendimentoExterno } from "./ingest";

const ORG_A = "00000000-0000-4000-8000-00000000000a";

interface Registro {
  tabela: string;
  op: "select" | "update" | "insert";
  filtros: Record<string, unknown>;
  corpo?: Record<string, unknown>;
}

function gravador(opcoes: { erroNoInsert?: { code: string; message: string }; eco?: boolean } = {}) {
  const registros: Registro[] = [];
  const rpcs: { nome: string; params: Record<string, unknown> }[] = [];
  const admin = {
    rpc: async (nome: string, params: Record<string, unknown>) => {
      rpcs.push({ nome, params });
      if (nome === "fn_upsert_wa_contact") return { data: "contato-a", error: null };
      if (nome === "fn_upsert_wa_conversation") return { data: "conversa-a", error: null };
      return { data: null, error: null };
    },
    from: (tabela: string) => {
      const reg: Registro = { tabela, op: "select", filtros: {} };
      registros.push(reg);
      const resposta = () => {
        if (tabela === "messages" && reg.op === "insert") {
          return opcoes.erroNoInsert ? { data: null, error: opcoes.erroNoInsert } : { data: { id: "msg-1" }, error: null };
        }
        if (tabela === "messages" && reg.op === "select") {
          return { data: opcoes.eco ? { id: "saida-1" } : null, error: null };
        }
        if (tabela === "conversations" && reg.op === "select") {
          return { data: { provider_conversation_id: null, metadata: { outra_marca: true }, updated_at: "t0" }, error: null };
        }
        return { data: null, error: null };
      };
      const b: Record<string, unknown> = {
        select: () => b,
        gte: () => b,
        limit: () => b,
        eq: (k: string, v: unknown) => {
          reg.filtros[k] = v;
          return b;
        },
        update: (corpo: Record<string, unknown>) => {
          reg.op = "update";
          reg.corpo = corpo;
          return b;
        },
        insert: (corpo: Record<string, unknown>) => {
          reg.op = "insert";
          reg.corpo = corpo;
          return b;
        },
        maybeSingle: async () => resposta(),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(resposta()).then(ok),
      };
      return b;
    },
  };
  return { admin: admin as never, registros, rpcs };
}

function entrada(extra: Record<string, unknown> = {}) {
  const r = lerEntrada(
    JSON.stringify({
      celular: "5500900000001",
      texto_mensagem: "oi, quero saber do caso",
      chat_id: "chat-teste-1",
      datetime_post: "2026-11-22 08:54:00",
      link_chat: "https://s7.chatguru.app/chats#chat-teste-1",
      ...extra,
    }),
  );
  if (!r.ok || !("entrada" in r)) throw new Error("devia ler");
  return r.entrada;
}

beforeEach(() => {
  efeitos.mockClear();
  marcar.mockClear();
});

describe("ingestão do canal dentro da plataforma — tudo escopado pela organização", () => {
  it("toda consulta, escrita e RPC leva a organização de quem chamou", async () => {
    const { admin, registros, rpcs } = gravador();
    const r = await ingestAtendimentoExterno(admin, entrada(), { organizationId: ORG_A, channelSessionId: "sess-a" });
    expect(r).toEqual({ status: "ingested", messageId: "msg-1", conversationId: "conversa-a" });

    for (const reg of registros) {
      if (reg.op === "insert") expect(reg.corpo?.organization_id, reg.tabela).toBe(ORG_A);
      else expect(reg.filtros.organization_id, `${reg.op} em ${reg.tabela}`).toBe(ORG_A);
    }
    for (const rpc of rpcs) {
      const org = rpc.params.p_org ?? rpc.params.p_organization_id;
      expect(org, rpc.nome).toBe(ORG_A);
    }
  });

  it("grava o endereço do chat como a plataforma o tem e o link, sem apagar outra marca", async () => {
    const { admin, registros } = gravador();
    await ingestAtendimentoExterno(admin, entrada(), { organizationId: ORG_A, channelSessionId: "sess-a" });
    const updates = registros.filter((r) => r.tabela === "conversations" && r.op === "update");
    expect(updates[0]?.corpo).toEqual({ provider_conversation_id: "5500900000001" });
    const doLink = updates.find((u) => u.corpo?.metadata);
    expect(doLink?.corpo?.metadata).toEqual({ outra_marca: true, link_externo: "https://s7.chatguru.app/chats#chat-teste-1" });
    // Trava otimista: só grava se ninguém mexeu na linha entre a leitura e a escrita.
    expect(doLink?.filtros.updated_at).toBe("t0");
  });

  it("a mensagem entra com o id derivado e na sessão do token", async () => {
    const { admin, registros } = gravador();
    await ingestAtendimentoExterno(admin, entrada(), { organizationId: ORG_A, channelSessionId: "sess-a" });
    const msg = registros.find((r) => r.tabela === "messages" && r.op === "insert");
    expect(msg?.corpo).toMatchObject({
      organization_id: ORG_A,
      channel_session_id: "sess-a",
      direction: "inbound",
      type: "text",
      body: "oi, quero saber do caso",
    });
    expect(String(msg?.corpo?.external_id)).toMatch(/^ext_[0-9a-f]{40}$/);
    expect(efeitos).toHaveBeenCalledWith(admin, expect.objectContaining({ organizationId: ORG_A, channelSessionId: "sess-a" }));
  });

  it("o eco da própria resposta não entra como se fosse o cliente", async () => {
    const { admin, registros } = gravador({ eco: true });
    const r = await ingestAtendimentoExterno(admin, entrada(), { organizationId: ORG_A, channelSessionId: "sess-a" });
    expect(r).toEqual({ status: "ignored", reason: "eco_do_proprio_envio" });
    expect(registros.some((x) => x.tabela === "messages" && x.op === "insert")).toBe(false);
    const consultaDoEco = registros.find((x) => x.tabela === "messages" && x.op === "select");
    expect(consultaDoEco?.filtros).toMatchObject({ organization_id: ORG_A, conversation_id: "conversa-a", direction: "outbound" });
    expect(efeitos).not.toHaveBeenCalled();
  });

  it("frase curta repetida pelo cliente NÃO é tratada como eco", async () => {
    const { admin, registros } = gravador({ eco: true });
    const r = await ingestAtendimentoExterno(admin, entrada({ texto_mensagem: "Bom dia!" }), {
      organizationId: ORG_A,
      channelSessionId: "sess-a",
    });
    expect(r.status).toBe("ingested");
    expect(registros.some((x) => x.tabela === "messages" && x.op === "select")).toBe(false);
  });

  it("reentrega (23505) é 'duplicate' e não acorda o agente de novo", async () => {
    const { admin } = gravador({ erroNoInsert: { code: "23505", message: "duplicate key" } });
    const r = await ingestAtendimentoExterno(admin, entrada(), { organizationId: ORG_A, channelSessionId: "sess-a" });
    expect(r).toEqual({ status: "duplicate" });
    expect(efeitos).not.toHaveBeenCalled();
    expect(marcar).not.toHaveBeenCalled();
  });
});
