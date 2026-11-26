/**
 * O responsável pelo chat na plataforma decide se a IA fala: preenchido = a
 * equipe assumiu (a IA cala, sem diálogo); vazio numa conversa que ESTA regra
 * calou = o chat voltou ao setor, e a IA volta. Silêncio por outro motivo não
 * é desfeito.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { assumiu, devolver } = vi.hoisted(() => ({
  assumiu: vi.fn(async (..._a: unknown[]) => ({ aplicado: true }) as Record<string, unknown>),
  devolver: vi.fn(async (..._a: unknown[]) => ({ ok: true }) as Record<string, unknown>),
}));
vi.mock("@/lib/escalacao/equipe-assumiu", () => ({ equipeAssumiuRespondendo: assumiu }));
vi.mock("@/lib/escalacao/retomada", () => ({ devolverAtendimentoAoAgente: devolver }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  MARCA_CALADA_PELO_RESPONSAVEL,
  aplicarRegraDoResponsavel,
  regraDoResponsavelLigada,
  temResponsavel,
} from "./responsavel";

const ORG = "org-1";

function banco(inicial: { metadata?: Record<string, unknown>; bot_silenced_until?: string | null }, config: unknown = {}) {
  const estado = { metadata: inicial.metadata ?? {}, bot_silenced_until: inicial.bot_silenced_until ?? null };
  const filtros: Array<[string, string, unknown]> = [];
  const updates: Array<Record<string, unknown>> = [];
  const from = (tabela: string) => {
    let patch: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {
      select: () => q,
      update: (p: Record<string, unknown>) => {
        patch = p;
        return q;
      },
      eq: (c: string, v: unknown) => {
        filtros.push([tabela, c, v]);
        if (patch && c === "id") {
          updates.push(patch);
          Object.assign(estado, patch);
        }
        return q;
      },
      maybeSingle: async () => {
        if (tabela === "channel_sessions") return { data: { chatguru_config: config }, error: null };
        return { data: { ...estado }, error: null };
      },
    };
    return q;
  };
  return { admin: { from } as never, estado, filtros, updates };
}

const base = { orgId: ORG, channelSessionId: "sess-1", conversationId: "conv-1" };

beforeEach(() => {
  assumiu.mockReset();
  assumiu.mockResolvedValue({ aplicado: true });
  devolver.mockReset();
  devolver.mockResolvedValue({ ok: true });
});

describe("temResponsavel (pura)", () => {
  it("e-mail ou nome preenchido = tem; vazio, espaço ou ausente = não tem", () => {
    expect(temResponsavel({ responsavel_email: "x@y.test" })).toBe(true);
    expect(temResponsavel({ responsavel_nome: "Fulana" })).toBe(true);
    expect(temResponsavel({ responsavel_email: "  ", responsavel_nome: "" })).toBe(false);
    expect(temResponsavel({})).toBe(false);
    expect(temResponsavel(null)).toBe(false);
  });
});

describe("aplicarRegraDoResponsavel", () => {
  it("desligada: nada é lido nem mudado", async () => {
    const b = banco({});
    expect(await aplicarRegraDoResponsavel(b.admin, { ...base, corpo: { responsavel_email: "a@b.test" }, ligado: false })).toBe("desligado");
    expect(b.filtros).toHaveLength(0);
    expect(assumiu).not.toHaveBeenCalled();
  });

  it("⭐ responsável preenchido: a equipe assumiu pela plataforma, e a conversa é marcada como calada pela regra", async () => {
    const b = banco({});
    expect(await aplicarRegraDoResponsavel(b.admin, { ...base, corpo: { responsavel_email: "a@b.test" }, ligado: true })).toBe("calou");
    expect(assumiu).toHaveBeenCalledWith(b.admin, expect.objectContaining({ organizationId: ORG, conversationId: "conv-1", origem: "plataforma", userId: null }));
    expect(b.estado.metadata[MARCA_CALADA_PELO_RESPONSAVEL]).toBe(true);
    // Toda leitura e escrita escopada pela organização de quem chamou.
    expect(b.filtros.filter(([, c]) => c === "organization_id").every(([, , v]) => v === ORG)).toBe(true);
  });

  it("responsável preenchido de novo, já calada: não refaz nada", async () => {
    assumiu.mockResolvedValue({ aplicado: false, motivo: "ja_assumida" });
    const b = banco({ metadata: { [MARCA_CALADA_PELO_RESPONSAVEL]: true }, bot_silenced_until: "infinity" });
    expect(await aplicarRegraDoResponsavel(b.admin, { ...base, corpo: { responsavel_nome: "Fulana" }, ligado: true })).toBe("ja_calada");
    expect(b.updates).toHaveLength(0);
  });

  it("⭐ responsável vazio numa conversa que a REGRA calou: a IA volta (sem acordar antes da mensagem nova)", async () => {
    const b = banco({ metadata: { [MARCA_CALADA_PELO_RESPONSAVEL]: true, outra: 1 }, bot_silenced_until: "infinity" });
    expect(await aplicarRegraDoResponsavel(b.admin, { ...base, corpo: { responsavel_email: "" }, ligado: true })).toBe("devolveu");
    expect(devolver).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, actor: { type: "webhook_source", id: "sess-1" } }),
      { conversationId: "conv-1", acordarIa: false },
    );
    expect(b.estado.metadata[MARCA_CALADA_PELO_RESPONSAVEL]).toBeUndefined();
    expect(b.estado.metadata.outra).toBe(1);
  });

  it("⭐ responsável vazio numa conversa calada por OUTRO motivo (passagem, CRM, sempre humano): nada muda", async () => {
    const b = banco({ metadata: {}, bot_silenced_until: "infinity" });
    expect(await aplicarRegraDoResponsavel(b.admin, { ...base, corpo: {}, ligado: true })).toBe("segue");
    expect(devolver).not.toHaveBeenCalled();
    expect(b.updates).toHaveLength(0);
  });

  it("a devolução recusada (ex.: contato sempre humano) mantém a marca e não acorda nada", async () => {
    devolver.mockResolvedValue({ ok: false, erro: "contato_sempre_humano" });
    const b = banco({ metadata: { [MARCA_CALADA_PELO_RESPONSAVEL]: true }, bot_silenced_until: "infinity" });
    expect(await aplicarRegraDoResponsavel(b.admin, { ...base, corpo: {}, ligado: true })).toBe("nao_aplicado");
    expect(b.estado.metadata[MARCA_CALADA_PELO_RESPONSAVEL]).toBe(true);
  });

  it("alguém já devolveu pela tela (não está calada): só limpa a marca que sobrou", async () => {
    const b = banco({ metadata: { [MARCA_CALADA_PELO_RESPONSAVEL]: true }, bot_silenced_until: null });
    expect(await aplicarRegraDoResponsavel(b.admin, { ...base, corpo: {}, ligado: true })).toBe("segue");
    expect(devolver).not.toHaveBeenCalled();
    expect(b.estado.metadata[MARCA_CALADA_PELO_RESPONSAVEL]).toBeUndefined();
  });

  it("nunca lança: erro do serviço vira nao_aplicado", async () => {
    assumiu.mockRejectedValue(new Error("falhou"));
    const b = banco({});
    expect(await aplicarRegraDoResponsavel(b.admin, { ...base, corpo: { responsavel_email: "a@b.test" }, ligado: true })).toBe("nao_aplicado");
  });
});

describe("regraDoResponsavelLigada", () => {
  it("lê a chave da conexão; ausente ou ilegível = desligada", async () => {
    expect(await regraDoResponsavelLigada(banco({}, { acoes: [], ia_so_sem_responsavel: true }).admin, ORG, "s")).toBe(true);
    expect(await regraDoResponsavelLigada(banco({}, { acoes: [] }).admin, ORG, "s")).toBe(false);
    expect(await regraDoResponsavelLigada(banco({}, "lixo").admin, ORG, "s")).toBe(false);
  });
});
