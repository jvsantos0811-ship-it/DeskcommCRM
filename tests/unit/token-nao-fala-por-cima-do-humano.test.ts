/**
 * QUEM CHEGA POR TOKEN NÃO ENVIA COM A CONVERSA EM ATENDIMENTO HUMANO
 * (briefing do Operador, 26/10/2026, item 2.1).
 *
 * `crm_send_whatsapp_message` (MCP) e a REST por Bearer passavam por
 * `sendMessageHandler`, que só barrava contato bloqueado e pessoal: um agente
 * externo falava por cima da pessoa da equipe que atendia o cliente. Os
 * desfechos:
 *
 *   1. token + `force_human` → 409 `conversa_com_humano`, e NADA é gravado;
 *   2. token + outra conversa do contato silenciada → o mesmo (o predicado é o
 *      de `isLeadInHandoff`, por CONTATO, não por conversa);
 *   3. token + `ai_opt_out` → o mesmo;
 *   4. controle: token sem trava → segue enviando;
 *   5. pessoa pela tela, com o contato em atendimento humano → segue enviando
 *      (é ela quem atende);
 *   6. envio interno do motor (`ai_agent` SEM token: o aviso ao cliente antes
 *      do silêncio, o link de reunião autorizado) → segue enviando.
 *
 * Dublê compartilhado (`tests/helpers/duble-do-handler`): um dublê local é o
 * que o gate `send-message-handler-nao-ganha-novo-duble` proíbe.
 */
import { describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { deriveActor } from "@/lib/mcp/auth";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/a.jpg" }, error: null }),
      }),
    },
  }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const TOKEN_ID = "77777777-7777-4777-8777-777777777777";

const ctxToken: HandlerCtx = { organization_id: ORG, actor: deriveActor(["mcp:write"], TOKEN_ID), requestId: "req-token" };
const ctxTela: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "55555555-5555-4555-8555-555555555555" },
  requestId: "req-tela",
};
const ctxMotor: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "ai_agent", id: "agent-engine:aviso", role: "agent" },
  requestId: "req-motor",
};

/** Canal por QR, sem janela de 24 h: o único gate em jogo é o deste arquivo. */
function conversa() {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    provider_conversation_id: null,
    last_inbound_at: null,
    contacts: { phone_number: "+5531999998888", wa_identity: null, wa_lid: null, is_blocked: false },
    channel_sessions: {
      id: SESSION,
      organization_id: ORG,
      provider: "waha",
      waha_session_name: "default",
      status: "WORKING",
      archived_at: null,
    },
  };
}

const TEXTO = { conversation_id: CONV, type: "text", body: "oi" } as SendMessageInput;

async function recusa(ctx: HandlerCtx, atendimentoHumano: Parameters<typeof criarDubleDoHandler>[0]["atendimentoHumano"]) {
  const { supabase, capturas } = criarDubleDoHandler({ conversation: conversa(), atendimentoHumano });
  const erro = await sendMessageHandler(supabase, ctx, TEXTO).catch((e: unknown) => e);
  return { erro, capturas };
}

describe("envio por token com o contato em atendimento humano", () => {
  it.each([
    ["force_human", { force_human: true }],
    ["outra conversa do contato silenciada", { conversasSilenciadas: 1 }],
    ["ai_opt_out", { ai_opt_out: true }],
  ] as const)("%s: 409 conversa_com_humano, e nada é gravado", async (_nome, travas) => {
    const { erro, capturas } = await recusa(ctxToken, travas);

    expect(erro, "o token falou por cima de quem atende").toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(409);
    expect((erro as ApiError).code).toBe("conversa_com_humano");
    // O MCP devolve só a mensagem ao cliente dele: o código tem de estar nela.
    expect((erro as ApiError).message).toContain("conversa_com_humano");
    expect(capturas.inserts.messages, "uma linha nasceu para um envio recusado").toHaveLength(0);
    // A leitura é do CONTATO da conversa, na organização da sessão.
    expect(capturas.filtros.contacts).toEqual(
      expect.arrayContaining([
        { coluna: "organization_id", valor: ORG },
        { coluna: "id", valor: CONTACT },
      ]),
    );
  });

  it("controle: token sem trava nenhuma segue enviando", async () => {
    const { erro, capturas } = await recusa(ctxToken, undefined);

    expect(erro).not.toBeInstanceOf(ApiError);
    expect(capturas.inserts.messages).toHaveLength(1);
  });

  it("a pessoa da equipe, pela tela, segue podendo — é ela quem atende", async () => {
    const { erro, capturas } = await recusa(ctxTela, { force_human: true, conversasSilenciadas: 1 });

    expect(erro).not.toBeInstanceOf(ApiError);
    expect(capturas.inserts.messages).toHaveLength(1);
  });

  it("envio interno do motor (sem token) não é barrado aqui — o aviso antes do silêncio tem de sair", async () => {
    const { erro, capturas } = await recusa(ctxMotor, { force_human: true });

    expect(erro).not.toBeInstanceOf(ApiError);
    expect(capturas.inserts.messages).toHaveLength(1);
  });
});
