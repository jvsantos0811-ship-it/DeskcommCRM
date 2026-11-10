/**
 * PC-029 — a equipe que responde ASSUME a conversa (pelo CRM ou pelo celular).
 *
 * O serviço inteiro, contra um banco de mentira que aplica os filtros de
 * verdade: quem fica com a conversa, o silêncio DURÁVEL da IA, o contato "só
 * humano", as agendadas canceladas, a linha do tempo, o card no funil — e o que
 * NÃO conta como pessoa (eco do nosso envio, resposta automática do app,
 * grupo). Os casos "eco de mensagem do app com e sem pessoa identificada" são o
 * teste automatizado que o pedido exige.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const movimentos: Array<{ leadId: string; body: Record<string, unknown>; actor: unknown }> = [];
const linhasDoTempo: Array<Record<string, unknown>> = [];
const auditorias: Array<Record<string, unknown>> = [];

vi.mock("@/app/api/v1/leads/_handler", () => ({
  moveLeadHandler: vi.fn(
    async (_s: unknown, ctx: { actor: unknown }, leadId: string, body: Record<string, unknown>) => {
      movimentos.push({ leadId, body, actor: ctx.actor });
      return {};
    },
  ),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    auditorias.push(e);
  }),
}));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({
  registrarTrocaDeComando: vi.fn(async (e: Record<string, unknown>) => {
    linhasDoTempo.push(e);
  }),
}));
vi.mock("@/lib/users/nome-do-atendente", () => ({
  nomesDosAtendentes: vi.fn(
    async (ids: string[]) => new Map(ids.map((id) => [id, id === "u-ana" ? "Ana" : null])),
  ),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  MOTIVO_EQUIPE_RESPONDEU_PELO_CELULAR,
  MOTIVO_EQUIPE_RESPONDEU_PELO_CRM,
  equipeAssumiuRespondendo,
  esquecerTextosAutomaticos,
} from "./equipe-assumiu";

type Linha = Record<string, unknown>;

const ORG = "org-1";
const CONVERSA = "conv-1";
const ETAPA_NOVO = "11111111-1111-4111-8111-111111111111";
const ETAPA_EQUIPE = "22222222-2222-4222-8222-222222222222";
const ETAPA_CONTRATO = "33333333-3333-4333-8333-333333333333";
const ETAPA_GANHO = "44444444-4444-4444-8444-444444444444";

interface Cenario {
  conversa?: Partial<Linha>;
  responsavel?: string | null;
  mensagens?: Linha[];
  etapaDoCard?: string;
  automaticos?: Array<{ texto: string; conversas: number; vezes: number; no_prazo: number }>;
  assumirDevolve?: unknown[];
}

function banco(c: Cenario = {}) {
  const conversa: Linha = {
    id: CONVERSA,
    organization_id: ORG,
    contact_id: "contato-1",
    channel_session_id: "sessao-1",
    is_group: false,
    assigned_to_user_id: null,
    bot_silenced_until: null,
    last_handoff_reason: null,
    last_handoff_at: null,
    service_started_at: null,
    ...c.conversa,
  };
  const contato: Linha = { id: "contato-1", organization_id: ORG, force_human: false };
  const tabelas: Record<string, Linha[]> = {
    conversations: [conversa],
    channel_sessions: [
      { id: "sessao-1", organization_id: ORG, responsavel_user_id: c.responsavel ?? null },
    ],
    contacts: [contato],
    messages: c.mensagens ?? [],
    crm_leads: [
      {
        id: "lead-1",
        organization_id: ORG,
        contact_id: "contato-1",
        pipeline_id: "funil-1",
        stage_id: c.etapaDoCard ?? ETAPA_NOVO,
        status: "open",
        last_activity_at: "2026-11-10T10:00:00Z",
        created_at: "2026-11-01T10:00:00Z",
      },
    ],
    crm_pipelines: [
      {
        id: "funil-1",
        organization_id: ORG,
        is_default: true,
        is_archived: false,
        settings: { etapa_quando_equipe_assume: ETAPA_EQUIPE },
      },
    ],
    crm_stages: [
      {
        id: ETAPA_NOVO,
        organization_id: ORG,
        pipeline_id: "funil-1",
        position: 1,
        is_won: false,
        is_lost: false,
        is_archived: false,
      },
      {
        id: ETAPA_EQUIPE,
        organization_id: ORG,
        pipeline_id: "funil-1",
        position: 2,
        is_won: false,
        is_lost: false,
        is_archived: false,
      },
      {
        id: ETAPA_CONTRATO,
        organization_id: ORG,
        pipeline_id: "funil-1",
        position: 3,
        is_won: false,
        is_lost: false,
        is_archived: false,
      },
      {
        id: ETAPA_GANHO,
        organization_id: ORG,
        pipeline_id: "funil-1",
        position: 4,
        is_won: true,
        is_lost: false,
        is_archived: false,
      },
    ],
  };
  const rpcs: Array<{ fn: string; args: Linha; via: string }> = [];

  const consulta = (nome: string) => {
    const iguais: Array<[string, unknown]> = [];
    const diferentes: Array<[string, unknown]> = [];
    let patch: Linha | null = null;
    const casa = () =>
      (tabelas[nome] ?? []).filter(
        (l) => iguais.every(([k, v]) => l[k] === v) && diferentes.every(([k, v]) => l[k] !== v),
      );
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (k: string, v: unknown) => {
        iguais.push([k, v]);
        return q;
      },
      neq: (k: string, v: unknown) => {
        diferentes.push([k, v]);
        return q;
      },
      gte: () => q,
      limit: () => q,
      update: (p: Linha) => {
        patch = p;
        return q;
      },
      maybeSingle: async () => ({ data: casa()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => {
        if (patch) {
          for (const l of casa()) Object.assign(l, patch);
          return Promise.resolve(ok({ data: null, error: null }));
        }
        return Promise.resolve(ok({ data: casa(), error: null }));
      },
    };
    return q;
  };

  const rpc = (via: string) => async (fn: string, args: Linha) => {
    rpcs.push({ fn, args, via });
    if (fn === "fn_conversation_assign") {
      const devolve = c.assumirDevolve ?? [{ id: CONVERSA }];
      if (devolve.length > 0) Object.assign(conversa, { assigned_to_user_id: args.p_to_user_id });
      return { data: devolve, error: null };
    }
    if (fn === "fn_cancelar_agendadas_da_conversa") return { data: 2, error: null };
    if (fn === "fn_textos_automaticos_do_celular")
      return { data: c.automaticos ?? [], error: null };
    return { data: null, error: null };
  };

  const admin = { from: (n: string) => consulta(n), rpc: rpc("admin") };
  const daSessao = { from: (n: string) => consulta(n), rpc: rpc("sessao") };
  return { admin: admin as never, daSessao: daSessao as never, conversa, contato, rpcs };
}

beforeEach(() => {
  movimentos.length = 0;
  linhasDoTempo.length = 0;
  auditorias.length = 0;
  esquecerTextosAutomaticos();
});

describe("resposta pela TELA do CRM", () => {
  it("assume para quem respondeu, cala a IA de vez, só humano, cancela agendadas, linha do tempo e card", async () => {
    const b = banco();
    const r = await equipeAssumiuRespondendo(b.admin, {
      organizationId: ORG,
      conversationId: CONVERSA,
      origem: "crm",
      userId: "u-ana",
      clientDoAssumir: b.daSessao,
    });

    expect(r).toMatchObject({
      aplicado: true,
      dono: "u-ana",
      agendadasCanceladas: 2,
      cardMovidoPara: ETAPA_EQUIPE,
    });
    // O "Assumir" é o mesmo do botão, pela sessão de quem respondeu.
    const assumir = b.rpcs.find((x) => x.fn === "fn_conversation_assign");
    expect(assumir).toMatchObject({
      via: "sessao",
      args: { p_to_user_id: "u-ana", p_reason: "claim", p_enforce_expected: true },
    });
    const conversa = b.conversa;
    expect(conversa.assigned_to_user_id).toBe("u-ana");
    expect(conversa.bot_silenced_until).toBe("infinity");
    expect(conversa.last_handoff_reason).toBe(MOTIVO_EQUIPE_RESPONDEU_PELO_CRM);
    expect(conversa.last_handoff_at).toEqual(expect.any(String));
    expect(b.contato.force_human).toBe(true);
    expect(b.rpcs.map((x) => x.fn)).toContain("fn_cancelar_agendadas_da_conversa");
    expect(linhasDoTempo).toEqual([
      expect.objectContaining({
        tipo: "conversation_claimed",
        motivo: "Equipe assumiu respondendo pelo CRM (Ana)",
      }),
    ]);
    expect(movimentos).toEqual([
      {
        leadId: "lead-1",
        body: { to_stage_id: ETAPA_EQUIPE, reason: "Equipe assumiu respondendo pelo CRM (Ana)" },
        actor: { type: "user", id: "u-ana" },
      },
    ]);
    expect(auditorias.map((a) => a.action)).toContain("conversation.claimed");
  });

  it("conversa que já é de OUTRA pessoa não é tomada — mas a IA cala do mesmo jeito", async () => {
    const b = banco({ conversa: { assigned_to_user_id: "u-bruno" } });
    const r = await equipeAssumiuRespondendo(b.admin, {
      organizationId: ORG,
      conversationId: CONVERSA,
      origem: "crm",
      userId: "u-ana",
    });
    expect(r.aplicado).toBe(true);
    expect(b.rpcs.map((x) => x.fn)).not.toContain("fn_conversation_assign");
    expect(b.conversa.assigned_to_user_id).toBe("u-bruno");
    expect(b.conversa.bot_silenced_until).toBe("infinity");
  });

  it("a SEGUNDA mensagem do mesmo episódio não refaz nota, linha do tempo nem movimento", async () => {
    const b = banco();
    await equipeAssumiuRespondendo(b.admin, {
      organizationId: ORG,
      conversationId: CONVERSA,
      origem: "crm",
      userId: "u-ana",
    });
    const r = await equipeAssumiuRespondendo(b.admin, {
      organizationId: ORG,
      conversationId: CONVERSA,
      origem: "crm",
      userId: "u-ana",
    });
    expect(r).toMatchObject({ aplicado: false, motivo: "ja_assumida" });
    expect(b.rpcs.filter((x) => x.fn === "fn_cancelar_agendadas_da_conversa")).toHaveLength(1);
    expect(linhasDoTempo).toHaveLength(1);
    expect(movimentos).toHaveLength(1);
  });

  it('depois do "Devolver para a IA" (novo atendimento), responder de novo é episódio NOVO', async () => {
    const b = banco({
      conversa: {
        bot_silenced_until: null,
        last_handoff_reason: MOTIVO_EQUIPE_RESPONDEU_PELO_CRM,
        last_handoff_at: "2026-11-10T09:00:00Z",
        service_started_at: "2026-11-10T10:00:00Z",
      },
    });
    const r = await equipeAssumiuRespondendo(b.admin, {
      organizationId: ORG,
      conversationId: CONVERSA,
      origem: "crm",
      userId: "u-ana",
    });
    expect(r.aplicado).toBe(true);
    expect(b.conversa.bot_silenced_until).toBe("infinity");
  });
});

describe("eco de mensagem do app do celular (coexistência)", () => {
  it("COM pessoa identificada (responsável do número): a conversa fica com ela", async () => {
    const b = banco({ responsavel: "u-carla" });
    const r = await equipeAssumiuRespondendo(b.admin, {
      organizationId: ORG,
      conversationId: CONVERSA,
      origem: "celular",
      userId: null,
      texto: "Oi! Aqui é a Carla, do escritório.",
    });
    expect(r).toMatchObject({ aplicado: true, dono: "u-carla", cardMovidoPara: ETAPA_EQUIPE });
    const assumir = b.rpcs.find((x) => x.fn === "fn_conversation_assign");
    expect(assumir).toMatchObject({ via: "admin", args: { p_to_user_id: "u-carla" } });
    expect(b.conversa.assigned_to_user_id).toBe("u-carla");
    expect(b.conversa.bot_silenced_until).toBe("infinity");
    expect(b.conversa.last_handoff_reason).toBe(MOTIVO_EQUIPE_RESPONDEU_PELO_CELULAR);
    expect(b.contato.force_human).toBe(true);
    expect(linhasDoTempo).toEqual([
      expect.objectContaining({
        motivo: "Equipe assumiu respondendo pelo celular",
        actor: { type: "user", id: "u-carla" },
      }),
    ]);
  });

  it('SEM pessoa identificada: a conversa fica sem dono, "Equipe (celular)", e a IA cala do mesmo jeito', async () => {
    const b = banco({ responsavel: null });
    const r = await equipeAssumiuRespondendo(b.admin, {
      organizationId: ORG,
      conversationId: CONVERSA,
      origem: "celular",
      userId: null,
      texto: "Já te respondo com os detalhes.",
    });
    expect(r).toMatchObject({ aplicado: true, dono: null });
    expect(b.rpcs.map((x) => x.fn)).not.toContain("fn_conversation_assign");
    expect(b.conversa.assigned_to_user_id).toBeNull();
    expect(b.conversa.bot_silenced_until).toBe("infinity");
    expect(b.contato.force_human).toBe(true);
    expect(b.rpcs.map((x) => x.fn)).toContain("fn_cancelar_agendadas_da_conversa");
    expect(linhasDoTempo).toEqual([
      expect.objectContaining({
        motivo: "Equipe assumiu respondendo pelo celular",
        actor: { type: "webhook_source", id: "sessao-1" },
      }),
    ]);
  });

  it("o eco do NOSSO envio que chegou antes do id (mesmo texto, minutos atrás) não é pessoa", async () => {
    const b = banco({
      mensagens: [
        {
          id: "m-ia",
          organization_id: ORG,
          conversation_id: CONVERSA,
          direction: "outbound",
          sent_via: "ai",
          status: "queued",
          body: "Consigo te encaixar amanhã às 15h. Fica bom?",
        },
      ],
    });
    const r = await equipeAssumiuRespondendo(b.admin, {
      organizationId: ORG,
      conversationId: CONVERSA,
      origem: "celular",
      userId: null,
      texto: "consigo te encaixar amanhã às 15h.  Fica bom?",
    });
    expect(r).toMatchObject({ aplicado: false, motivo: "eco_proprio" });
    expect(b.conversa.bot_silenced_until).toBeNull();
  });

  it("CONTROLE: com um envio nosso no ar, texto DIFERENTE é pessoa (regra do #519)", async () => {
    const b = banco({
      mensagens: [
        {
          id: "m-ia",
          organization_id: ORG,
          conversation_id: CONVERSA,
          direction: "outbound",
          sent_via: "ai",
          status: "queued",
          body: "Fica bom amanhã?",
        },
      ],
    });
    const r = await equipeAssumiuRespondendo(b.admin, {
      organizationId: ORG,
      conversationId: CONVERSA,
      origem: "celular",
      userId: null,
      texto: "Pode deixar que eu cuido, aqui é o Rafael",
    });
    expect(r.aplicado).toBe(true);
  });

  it("a resposta AUTOMÁTICA do app (saudação/ausência) não conta como pessoa", async () => {
    const b = banco({
      automaticos: [
        {
          texto: "olá! recebemos sua mensagem e já retornamos.",
          conversas: 12,
          vezes: 12,
          no_prazo: 12,
        },
      ],
    });
    const r = await equipeAssumiuRespondendo(b.admin, {
      organizationId: ORG,
      conversationId: CONVERSA,
      origem: "celular",
      userId: null,
      texto: "Olá! Recebemos sua mensagem e já retornamos.",
    });
    expect(r).toMatchObject({ aplicado: false, motivo: "automatica" });
    expect(b.conversa.bot_silenced_until).toBeNull();
    expect(b.contato.force_human).toBe(false);
  });
});

describe("o que fica de fora", () => {
  it("grupo nunca é assumido (a IA não responde em grupo)", async () => {
    const b = banco({ conversa: { is_group: true } });
    const r = await equipeAssumiuRespondendo(b.admin, {
      organizationId: ORG,
      conversationId: CONVERSA,
      origem: "crm",
      userId: "u-ana",
    });
    expect(r).toMatchObject({ aplicado: false, motivo: "grupo" });
    expect(b.conversa.bot_silenced_until).toBeNull();
  });

  it("card DEPOIS da etapa da equipe (ex.: contrato) fica onde está", async () => {
    const b = banco({ etapaDoCard: ETAPA_CONTRATO });
    const r = await equipeAssumiuRespondendo(b.admin, {
      organizationId: ORG,
      conversationId: CONVERSA,
      origem: "crm",
      userId: "u-ana",
    });
    expect(r.aplicado).toBe(true);
    expect(r.cardMovidoPara).toBeNull();
    expect(movimentos).toEqual([]);
  });

  it("card GANHO fica onde está", async () => {
    const b = banco({ etapaDoCard: ETAPA_GANHO });
    const r = await equipeAssumiuRespondendo(b.admin, {
      organizationId: ORG,
      conversationId: CONVERSA,
      origem: "crm",
      userId: "u-ana",
    });
    expect(r.cardMovidoPara).toBeNull();
    expect(movimentos).toEqual([]);
  });

  it("conversa de outra organização não é lida nem mexida", async () => {
    const b = banco();
    const r = await equipeAssumiuRespondendo(b.admin, {
      organizationId: "org-2",
      conversationId: CONVERSA,
      origem: "crm",
      userId: "u-ana",
    });
    expect(r).toMatchObject({ aplicado: false, motivo: "sem_conversa" });
    expect(b.conversa.bot_silenced_until).toBeNull();
  });

  it("nunca lança: banco quebrado vira `erro`, e a mensagem já enviada segue", async () => {
    const quebrado = {
      from: () => {
        throw new Error("banco fora");
      },
      rpc: async () => ({ data: null, error: null }),
    };
    await expect(
      equipeAssumiuRespondendo(quebrado as never, {
        organizationId: ORG,
        conversationId: CONVERSA,
        origem: "crm",
        userId: "u-ana",
      }),
    ).resolves.toMatchObject({ aplicado: false, motivo: "erro" });
  });
});

describe('o botão "Assumir" usa o mesmo pedaço comum (PC-024/PC-029)', () => {
  it("a rota do Assumir deixa o contato só humano e cancela as agendadas DEPOIS de assumir", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const rota = readFileSync(
      resolve(__dirname, "../../app/api/v1/conversations/[id]/claim/route.ts"),
      "utf8",
    );
    const conflito = rota.indexOf('fail("state_conflict"');
    const efeito = rota.indexOf("await contatoSoHumanoEAgendadasCanceladas(");
    expect(conflito).toBeGreaterThan(-1);
    // Só quem venceu a disputa mexe no contato e nas agendadas.
    expect(efeito).toBeGreaterThan(conflito);
  });

  it("o pedaço comum: só humano + agendadas, e nunca lança", async () => {
    const { contatoSoHumanoEAgendadasCanceladas } = await import("./equipe-assumiu");
    const b = banco();
    const n = await contatoSoHumanoEAgendadasCanceladas(b.admin, {
      organizationId: ORG,
      conversationId: CONVERSA,
      contactId: "contato-1",
    });
    expect(n).toBe(2);
    expect(b.contato.force_human).toBe(true);
    const quebrado = {
      from: () => {
        throw new Error("fora");
      },
      rpc: async () => ({ data: null, error: null }),
    };
    await expect(
      contatoSoHumanoEAgendadasCanceladas(quebrado as never, {
        organizationId: ORG,
        conversationId: CONVERSA,
        contactId: "contato-1",
      }),
    ).resolves.toBe(0);
  });
});
