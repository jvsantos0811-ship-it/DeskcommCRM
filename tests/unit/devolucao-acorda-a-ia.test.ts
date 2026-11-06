/**
 * DEVOLVER À IA COM O CLIENTE ESPERANDO ACORDA A IA (PM-025 §0).
 *
 * O defeito medido na produção: a mensagem que chegou com a conversa nas mãos
 * de uma pessoa (ou com a conta suspensa) tinha o pedido de turno consumido sem
 * job; quando a conversa voltava à IA, ninguém pedia de novo, e o cliente ficava
 * sem resposta até escrever outra vez. 12 devoluções em 21 dias, nenhuma
 * respondida.
 *
 * Escrito por EFEITO: o que sai para o banco é o pedido de turno, com o payload
 * que o dreno do agente lê (`lib/agent-engine/edge/crm/drain.ts`).
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Tirar o `direction !== "inbound"`: o caso "a última mensagem é nossa" acusa
 *   (a IA falaria por cima da equipe).
 * - Tirar a checagem de `is_personal`: o caso do contato pessoal acusa.
 * - Tirar a leitura de pedido vivo: o caso "já pedido" acusa (pedido em dobro).
 * - Fazer a função lançar: o caso de falha de leitura acusa.
 */
import { describe, expect, it, vi } from "vitest";

import { acordarIaSeOClienteEspera } from "@/lib/escalacao/acordar-ia-na-devolucao";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const ORG = "22222222-2222-4222-8222-222222222222";
const CONV = "44444444-4444-4444-8444-444444444444";
const CONTATO = "55555555-5555-4555-8555-555555555555";
const CANAL = "77777777-7777-4777-8777-777777777777";
const MSG = "88888888-8888-4888-8888-888888888888";

interface Cenario {
  conversa?: Record<string, unknown> | null;
  ultima?: Record<string, unknown> | null;
  contato?: Record<string, unknown> | null;
  pedidosVivos?: Array<Record<string, unknown>>;
  erroAoLerMensagem?: { message: string };
  erroNoEmit?: { message: string };
}

function fazerSupabase(c: Cenario) {
  const rpc: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const filtrosPorTabela: Record<string, Array<[string, unknown]>> = {};
  const from = (tabela: string) => {
    const filtros: Array<[string, unknown]> = (filtrosPorTabela[tabela] ??= []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: (col: string, v: unknown) => {
        filtros.push([col, v]);
        return chain;
      },
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => {
        if (tabela === "conversations") return Promise.resolve({ data: c.conversa ?? null, error: null });
        if (tabela === "messages") {
          return Promise.resolve({ data: c.ultima ?? null, error: c.erroAoLerMensagem ?? null });
        }
        if (tabela === "contacts") return Promise.resolve({ data: c.contato ?? null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: tabela === "event_log" ? (c.pedidosVivos ?? []) : [], error: null }).then(res),
    };
    return chain;
  };
  const supabase = {
    from,
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpc.push({ fn, args });
      return Promise.resolve({ data: null, error: c.erroNoEmit ?? null });
    },
  };
  return { supabase, rpc, filtrosPorTabela };
}

const conversaComCliente = (over: Record<string, unknown> = {}) => ({
  id: CONV,
  contact_id: CONTATO,
  channel_session_id: CANAL,
  is_group: false,
  ...over,
});

async function acordar(c: Cenario) {
  const banco = fazerSupabase(c);
  const desfecho = await acordarIaSeOClienteEspera(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    banco.supabase as any,
    { organizationId: ORG, conversationId: CONV, requestId: "req-1", origem: "user" },
  );
  return { desfecho, ...banco };
}

describe("devolver à IA com o cliente esperando", () => {
  it("a última mensagem é do cliente: pede o turno para ELA, com o payload do dreno", async () => {
    const r = await acordar({
      conversa: conversaComCliente(),
      ultima: { id: MSG, direction: "inbound" },
      contato: { is_personal: false, is_blocked: false, ai_opt_out: false },
    });

    expect(r.desfecho).toBe("acordou");
    expect(r.rpc).toHaveLength(1);
    expect(r.rpc[0]!.fn).toBe("emit_event");
    expect(r.rpc[0]!.args).toMatchObject({
      p_event_type: "ai_agent.dispatch_requested",
      p_entity_kind: "message",
      p_entity_id: MSG,
      p_organization_id: ORG,
      p_payload: {
        organization_id: ORG,
        conversation_id: CONV,
        contact_id: CONTATO,
        channel_session_id: CANAL,
        inbound_message_id: MSG,
      },
    });
  });

  it("toda leitura filtra a organização", async () => {
    const r = await acordar({
      conversa: conversaComCliente(),
      ultima: { id: MSG, direction: "inbound" },
      contato: {},
    });
    for (const tabela of ["conversations", "messages", "contacts", "event_log"]) {
      expect(r.filtrosPorTabela[tabela], tabela).toContainEqual(["organization_id", ORG]);
    }
  });

  it("a última mensagem é nossa (IA ou equipe pelo celular): não acorda", async () => {
    const r = await acordar({
      conversa: conversaComCliente(),
      ultima: { id: MSG, direction: "outbound" },
      contato: {},
    });
    expect(r.desfecho).toBe("ninguem_esperando");
    expect(r.rpc).toEqual([]);
  });

  it("conversa sem mensagem: não acorda", async () => {
    const r = await acordar({ conversa: conversaComCliente(), ultima: null, contato: {} });
    expect(r.desfecho).toBe("ninguem_esperando");
    expect(r.rpc).toEqual([]);
  });

  it.each([
    ["pessoal", { is_personal: true }],
    ["bloqueado", { is_blocked: true }],
    ["sempre atendimento humano", { ai_opt_out: true }],
  ])("contato %s: não acorda", async (_nome, contato) => {
    const r = await acordar({
      conversa: conversaComCliente(),
      ultima: { id: MSG, direction: "inbound" },
      contato,
    });
    expect(r.desfecho).toBe("contato_parado");
    expect(r.rpc).toEqual([]);
  });

  it("grupo: não acorda", async () => {
    const r = await acordar({
      conversa: conversaComCliente({ is_group: true }),
      ultima: { id: MSG, direction: "inbound" },
      contato: {},
    });
    expect(r.desfecho).toBe("fora_do_alcance");
    expect(r.rpc).toEqual([]);
  });

  it("já há pedido vivo para a mesma mensagem: não pede em dobro", async () => {
    const r = await acordar({
      conversa: conversaComCliente(),
      ultima: { id: MSG, direction: "inbound" },
      contato: {},
      pedidosVivos: [{ id: "ev-1" }],
    });
    expect(r.desfecho).toBe("ja_pedido");
    expect(r.rpc).toEqual([]);
  });

  it("falha de leitura não lança: vira 'falhou' e nada é pedido", async () => {
    const r = await acordar({
      conversa: conversaComCliente(),
      erroAoLerMensagem: { message: "timeout" },
    });
    expect(r.desfecho).toBe("falhou");
    expect(r.rpc).toEqual([]);
  });

  it("falha ao emitir não lança: vira 'falhou'", async () => {
    const r = await acordar({
      conversa: conversaComCliente(),
      ultima: { id: MSG, direction: "inbound" },
      contato: {},
      erroNoEmit: { message: "boom" },
    });
    expect(r.desfecho).toBe("falhou");
  });
});
