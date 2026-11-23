import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ audit: vi.fn(), token: vi.fn() }));
vi.mock("@/lib/audit", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  audit: deps.audit,
}));
vi.mock("@/lib/agenda/google/sync-executor", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  tokenForConnection: deps.token,
}));

import { alterarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import { aparenciaDaPresenca, COR_DA_PRESENCA, presencaLiberaOHorario } from "@/lib/agenda/presenca-cor";
import { pintarPresencasPendentes } from "@/lib/agenda/presenca";
import { paraEventoDoGoogle, type AgendamentoParaGoogle } from "@/lib/agenda/google/evento";
import { localProjection } from "@/lib/agenda/google/sync-model";
import { ocupadosDoDono } from "@/lib/agenda/ocupados";
import { agendaInterna, lerModeloDoEvento } from "@/lib/agenda/modelo-do-evento";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PC-052 parte 2 — a presença do lead com cor no Google.
 *
 * O que este arquivo vigia, e por que cada caso existe:
 *  - a cor e a transparência saem no evento NOVO e NÃO mexem na projeção do
 *    sync (senão todo compromisso publicado ganharia um PATCH `sendUpdates=all`);
 *  - "não vai" libera o horário no motor;
 *  - a presença só se grava em compromisso de tipo com presença, e a recusa
 *    acontece ANTES da escrita;
 *  - a pintura no Google é um PATCH só de cor, sem aviso a ninguém, e só marca
 *    "pintado" quando o Google aceitou.
 */

const ORG = "00000000-0000-4000-8000-000000000001";
const COMPROMISSO = "00000000-0000-4000-8000-0000000000cc";

const base: AgendamentoParaGoogle = {
  id: COMPROMISSO,
  organization_id: ORG,
  title: "Ana – 1234",
  description: "qualificação",
  starts_at: "2026-11-25T12:00:00.000Z",
  ends_at: "2026-11-25T12:30:00.000Z",
  time_zone: "America/Sao_Paulo",
  status: "confirmed",
  location_kind: "phone",
};

describe("cor da presença", () => {
  it("amarelo, verde e vermelho; só o vermelho libera o horário", () => {
    expect(aparenciaDaPresenca("aguardando")).toEqual({ colorId: COR_DA_PRESENCA.aguardando, transparency: "opaque" });
    expect(aparenciaDaPresenca("confirmada")).toEqual({ colorId: COR_DA_PRESENCA.confirmada, transparency: "opaque" });
    expect(aparenciaDaPresenca("nao_vai")).toEqual({ colorId: COR_DA_PRESENCA.nao_vai, transparency: "transparent" });
    expect(presencaLiberaOHorario("nao_vai")).toBe(true);
    expect(presencaLiberaOHorario("confirmada")).toBe(false);
    expect(aparenciaDaPresenca(null)).toBeNull();
    expect(aparenciaDaPresenca("outra")).toBeNull();
  });

  it("o evento novo nasce pintado; sem presença, o corpo é o de sempre", () => {
    const pintado = paraEventoDoGoogle({ ...base, lead_presence: "aguardando" });
    expect(pintado.colorId).toBe("5");
    expect(pintado.transparency).toBe("opaque");

    const vermelho = paraEventoDoGoogle({ ...base, lead_presence: "nao_vai" });
    expect(vermelho.colorId).toBe("11");
    expect(vermelho.transparency).toBe("transparent");

    const deSempre = paraEventoDoGoogle(base);
    expect(deSempre.colorId).toBeUndefined();
    expect(deSempre.transparency).toBe("opaque");
  });

  it("a presença NÃO muda a projeção do sync (nenhum PATCH em massa)", () => {
    const sem = localProjection(base);
    for (const p of ["aguardando", "confirmada", "nao_vai"] as const) {
      expect(localProjection({ ...base, lead_presence: p })).toEqual(sem);
    }
  });
});

describe("ocupação", () => {
  it("quem não vai libera o horário; o resto ocupa", () => {
    const linha = (lead_presence: string | null) => ({
      starts_at: base.starts_at,
      ends_at: base.ends_at,
      status: "confirmed",
      lead_presence,
    });
    expect(ocupadosDoDono([linha("nao_vai")], []).ocupados).toHaveLength(0);
    expect(ocupadosDoDono([linha("confirmada")], []).ocupados).toHaveLength(1);
    expect(ocupadosDoDono([linha("aguardando")], []).ocupados).toHaveLength(1);
    expect(ocupadosDoDono([linha(null)], []).ocupados).toHaveLength(1);
  });
});

describe("agenda interna", () => {
  it("lê a opção do modelo do evento; ausente = desligada", () => {
    const comOpcao = { modelo_do_evento_agenda: { titulo: "{primeiro_nome}", descricao: "completa", agenda_interna: true } };
    expect(lerModeloDoEvento(comOpcao)?.agenda_interna).toBe(true);
    expect(agendaInterna(comOpcao)).toBe(true);
    expect(agendaInterna({ modelo_do_evento_agenda: { titulo: "x", descricao: "basica" } })).toBe(false);
    expect(agendaInterna(null)).toBe(false);
  });
});

/** Cliente falso que registra as chamadas e devolve a linha do compromisso. */
function sbDoCompromisso(linha: Record<string, unknown>, chamadas: Array<{ rpc: string; args: unknown }>) {
  const api = {
    from() {
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: linha, error: null }),
        single: async () => ({ data: linha, error: null }),
      };
      return q;
    },
    async rpc(nome: string, args: { p_patch?: Record<string, unknown> }) {
      chamadas.push({ rpc: nome, args });
      if (nome === "fn_appointment_change") return { data: { ...linha, ...(args.p_patch ?? {}) }, error: null };
      return { data: null, error: null };
    },
  };
  return api as unknown as SupabaseClient;
}

const ctxDaIA = (): HandlerCtx =>
  ({
    organization_id: ORG,
    requestId: "req-pc052",
    actor: { type: "ai_agent", id: "run-1", role: "agent" },
  }) as unknown as HandlerCtx;

const compromisso = (lead_presence: string | null, status = "confirmed") => ({
  id: COMPROMISSO,
  revision: 3,
  owner_user_id: "00000000-0000-4000-8000-0000000000aa",
  contact_id: null,
  event_type_id: null,
  status,
  time_zone: "America/Sao_Paulo",
  starts_at: base.starts_at,
  lead_presence,
});

describe("registrar a presença", () => {
  beforeEach(() => vi.clearAllMocks());

  it("tipo sem presença: recusa SEM escrever", async () => {
    const chamadas: Array<{ rpc: string; args: unknown }> = [];
    await expect(
      alterarAgendamentoHandler(sbDoCompromisso(compromisso(null), chamadas), ctxDaIA(), {
        id: COMPROMISSO,
        lead_presence: "confirmada",
      }),
    ).rejects.toMatchObject({ status: 422, code: "agenda_presenca_desligada" });
    expect(chamadas.some((c) => c.rpc === "fn_appointment_change")).toBe(false);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("grava a presença, audita e não vira transição", async () => {
    const chamadas: Array<{ rpc: string; args: unknown }> = [];
    const r = await alterarAgendamentoHandler(sbDoCompromisso(compromisso("aguardando"), chamadas), ctxDaIA(), {
      id: COMPROMISSO,
      lead_presence: "nao_vai",
    });
    const escrita = chamadas.find((c) => c.rpc === "fn_appointment_change");
    expect((escrita?.args as { p_patch: Record<string, unknown> }).p_patch).toEqual({ lead_presence: "nao_vai" });
    expect(r).toMatchObject({ lead_presence: "nao_vai" });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agenda.appointment_presence_recorded",
        metadata: expect.objectContaining({ lead_presence: "nao_vai", anterior: "aguardando" }),
      }),
    );
  });

  it("a mesma presença de novo não escreve nada", async () => {
    const chamadas: Array<{ rpc: string; args: unknown }> = [];
    const r = await alterarAgendamentoHandler(sbDoCompromisso(compromisso("confirmada"), chamadas), ctxDaIA(), {
      id: COMPROMISSO,
      lead_presence: "confirmada",
    });
    expect(r).toMatchObject({ inalterado: true });
    expect(chamadas.some((c) => c.rpc === "fn_appointment_change")).toBe(false);
  });

  it("compromisso que já não vai acontecer: recusa", async () => {
    const chamadas: Array<{ rpc: string; args: unknown }> = [];
    await expect(
      alterarAgendamentoHandler(sbDoCompromisso(compromisso("aguardando", "completed"), chamadas), ctxDaIA(), {
        id: COMPROMISSO,
        lead_presence: "confirmada",
      }),
    ).rejects.toMatchObject({ status: 422, code: "agenda_presenca_fora_de_hora" });
  });
});

describe("pintar no Google", () => {
  beforeEach(() => vi.clearAllMocks());

  const pendente = {
    id: COMPROMISSO,
    organization_id: ORG,
    lead_presence: "confirmada",
    google_connection_id: "00000000-0000-4000-8000-0000000000dd",
    google_calendar_id: "agenda@exemplo.com",
    google_event_id: "deskcommapp123",
  };

  function adminFalso(linhas: unknown[], updates: Array<Record<string, unknown>>) {
    return {
      from() {
        let atualizacao: Record<string, unknown> | null = null;
        const q: Record<string, unknown> = {
          select: () => q,
          not: () => q,
          is: () => q,
          in: () => q,
          order: () => q,
          limit: async () => ({ data: linhas, error: null }),
          update: (v: Record<string, unknown>) => {
            atualizacao = v;
            return q;
          },
          eq: () => {
            if (atualizacao) updates.push(atualizacao);
            atualizacao = null;
            return q;
          },
        };
        return q;
      },
    } as never;
  }

  it("PATCH só de cor, sem aviso, e marca como pintado", async () => {
    deps.token.mockResolvedValue("tok");
    const updates: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await pintarPresencasPendentes(adminFalso([pendente], updates), { fetchImpl });
    expect(r).toEqual({ pintados: 1, falhas: 0 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("sendUpdates=none");
    expect(url).toContain(encodeURIComponent("agenda@exemplo.com"));
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ colorId: "10", transparency: "opaque" });
    expect(updates[0]).toEqual({ lead_presence_painted: "confirmada" });
  });

  it("o Google recusou: não marca como pintado (a próxima rodada tenta de novo)", async () => {
    deps.token.mockResolvedValue("tok");
    const updates: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 403 }));
    const r = await pintarPresencasPendentes(adminFalso([pendente], updates), { fetchImpl });
    expect(r).toEqual({ pintados: 0, falhas: 1 });
    expect(updates).toHaveLength(0);
  });
});
