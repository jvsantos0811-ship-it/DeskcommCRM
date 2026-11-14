/**
 * O CRON DO RETRATO DE DADOS (v3 §8.2) — o que a rota decide, com o banco simulado.
 *
 *  - quem a lista do banco traz e não está parada recebe o retrato (com
 *    `soSeFaltar`, para rodar duas vezes não refazer);
 *  - organização parada fica de fora mesmo se o banco a listasse (o cinto);
 *  - uma organização que falha não para as outras, e a falha fica na auditoria;
 *  - rodada sem nada a fazer não audita; sem o segredo, 403 e nada roda;
 *  - organização com o Leitor da conversa ligado e a rodada diária aberta
 *    espera (PM-027 §3) — quem gera o retrato dela é o fim da rodada.
 * O fuso, a hora e o "já tem o do dia" são do banco: `tests/invariants/retrato-de-dados.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as GerarRetrato from "@/lib/dados/gerar-retrato";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/organizacao/operante", () => ({ idsDeOrgsParadas: vi.fn(async () => []) }));
const esperaOLeitor = vi.fn(async (..._a: unknown[]) => false);
vi.mock("@/lib/dados/leitor/rodadas", () => ({ retratoEsperaOLeitor: (...a: unknown[]) => esperaOLeitor(...a) }));
vi.mock("@/lib/dados/gerar-retrato", async (importOriginal) => {
  const real = await importOriginal<typeof GerarRetrato>();
  return {
    ...real,
    gerarRetratoDaOrg: vi.fn(),
    retratoPrecisaRefazer: vi.fn(async () => false),
    refazerRetratoDoDia: vi.fn(),
  };
});

import { audit } from "@/lib/audit";
import { ErroDoRetrato, gerarRetratoDaOrg, refazerRetratoDoDia, retratoPrecisaRefazer } from "@/lib/dados/gerar-retrato";
import { HORA_DO_RETRATO } from "@/lib/dados/retrato";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const PARADA = "33333333-3333-4333-8333-333333333333";

let pedidoAoBanco: Record<string, unknown> | null = null;
function admin(
  lista: Array<{ organization_id: string; dia: string }>,
  pelaFicha: Array<{ id: string; timezone: string | null; settings: unknown }> = [],
) {
  return {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      pedidoAoBanco = { fn, ...args };
      return { data: lista, error: null };
    }),
    from: () => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => ({ data: ids.map((id) => ({ id, settings: {}, timezone: null })), error: null }),
        // PC-037 §3: as organizações em que a chave `leitor.painel_pela_ficha` já foi tocada.
        not: async (_col: string, _op: string, _v: unknown) => ({ data: pelaFicha, error: null }),
      }),
    }),
  };
}

const pedido = (comSegredo = true) =>
  new NextRequest("http://localhost/api/v1/cron/dados-retrato", {
    headers: comSegredo ? { authorization: "Bearer segredo" } : {},
  });

const gravado = (gravou: boolean) => ({
  dia: "2026-11-05",
  geradoEm: "2026-11-05T09:11:00.000Z",
  gravado: gravou,
  motivo: gravou ? ("gravado" as const) : ("ja_existe" as const),
  proximoEm: null,
  apagados: 0,
  leads: 46,
});

beforeEach(() => {
  vi.clearAllMocks();
  esperaOLeitor.mockResolvedValue(false);
  pedidoAoBanco = null;
});

describe("cron dados-retrato", () => {
  it("gera o retrato de cada organização listada, pula a parada, e audita só o que gravou", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      admin([
        { organization_id: A, dia: "2026-11-05" },
        { organization_id: PARADA, dia: "2026-11-05" },
        { organization_id: B, dia: "2026-11-05" },
      ]) as never,
    );
    vi.mocked(idsDeOrgsParadas).mockResolvedValue([PARADA]);
    vi.mocked(gerarRetratoDaOrg).mockResolvedValueOnce(gravado(true)).mockResolvedValueOnce(gravado(false));
    const { GET } = await import("./route");
    const res = await GET(pedido());
    expect(res.status).toBe(200);
    expect(pedidoAoBanco).toEqual({ fn: "fn_dados_orgs_sem_retrato", p_hora: HORA_DO_RETRATO });
    expect(vi.mocked(gerarRetratoDaOrg).mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      [A, "cron", { soSeFaltar: true }],
      [B, "cron", { soSeFaltar: true }],
    ]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: A, action: "dados.retrato_gerado", metadata: expect.objectContaining({ origem: "cron" }) }),
    );
    const corpo = (await res.json()) as { data: { gerados: number; falhas: number } };
    expect(corpo.data).toMatchObject({ gerados: 1, falhas: 0 });
  });

  it("uma organização que falha não para as outras, e a falha é auditada", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      admin([
        { organization_id: A, dia: "2026-11-05" },
        { organization_id: B, dia: "2026-11-05" },
      ]) as never,
    );
    vi.mocked(gerarRetratoDaOrg)
      .mockRejectedValueOnce(new ErroDoRetrato("leads", "timeout"))
      .mockResolvedValueOnce(gravado(true));
    const { GET } = await import("./route");
    const res = await GET(pedido());
    const corpo = (await res.json()) as { data: { gerados: number; falhas: number } };
    expect(corpo.data).toMatchObject({ gerados: 1, falhas: 1 });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: A, action: "dados.retrato_falhou", metadata: expect.objectContaining({ etapa: "leads" }) }),
    );
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ organizationId: B, action: "dados.retrato_gerado" }));
  });

  it("rodada sem nada a fazer não audita; sem o segredo, 403 e nada roda", async () => {
    vi.mocked(createAdminClient).mockReturnValue(admin([]) as never);
    const { GET } = await import("./route");
    expect((await GET(pedido())).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
    expect((await GET(pedido(false))).status).toBe(403);
    expect(gerarRetratoDaOrg).not.toHaveBeenCalled();
  });

  it("organização com a rodada diária do Leitor aberta espera; as outras seguem", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      admin([
        { organization_id: A, dia: "2026-11-05" },
        { organization_id: B, dia: "2026-11-05" },
      ]) as never,
    );
    esperaOLeitor.mockImplementation(async (...a: unknown[]) => (a[1] as { id: string }).id === A);
    vi.mocked(gerarRetratoDaOrg).mockResolvedValueOnce(gravado(true));
    const { GET } = await import("./route");
    const corpo = (await (await GET(pedido())).json()) as { data: Record<string, number> };
    expect(vi.mocked(gerarRetratoDaOrg).mock.calls.map((c) => c[1])).toEqual([B]);
    expect(corpo.data).toMatchObject({ gerados: 1, esperando_o_leitor: 1 });
  });

  it("PC-037: refaz só a organização cujo retrato precisa (ficha mais nova ou régua trocada), pula a parada, e audita com origem ficha", async () => {
    vi.mocked(idsDeOrgsParadas).mockResolvedValueOnce([PARADA]);
    const ligada = { leitor: { escolha: "claude", painel_pela_ficha: true } };
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [],
        [
          { id: A, timezone: "America/Sao_Paulo", settings: ligada },
          { id: B, timezone: null, settings: { leitor: { painel_pela_ficha: false } } },
          { id: PARADA, timezone: null, settings: ligada },
        ],
      ) as never,
    );
    vi.mocked(retratoPrecisaRefazer).mockImplementation(async (_db, org) => org === A);
    vi.mocked(refazerRetratoDoDia).mockResolvedValueOnce(gravado(true));
    const { GET } = await import("./route");
    const corpo = (await (await GET(pedido())).json()) as { data: Record<string, number> };
    expect(vi.mocked(retratoPrecisaRefazer).mock.calls.map((c) => [c[1], c[3]])).toEqual([
      [A, 2],
      [B, 1],
    ]);
    expect(vi.mocked(refazerRetratoDoDia).mock.calls.map((c) => c[1])).toEqual([A]);
    expect(corpo.data).toMatchObject({ refeitos_pela_ficha: 1 });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: A, action: "dados.retrato_gerado", metadata: expect.objectContaining({ origem: "ficha" }) }),
    );
  });

  it("PC-037: o refazer que falha conta como falha e não para o cron", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      admin([], [{ id: A, timezone: null, settings: { leitor: { escolha: "claude", painel_pela_ficha: true } } }]) as never,
    );
    vi.mocked(retratoPrecisaRefazer).mockResolvedValueOnce(true);
    vi.mocked(refazerRetratoDoDia).mockImplementationOnce(async (_db, _org, opts) => {
      opts?.falhou?.(new Error("caiu"));
      return null;
    });
    const { GET } = await import("./route");
    const corpo = (await (await GET(pedido())).json()) as { data: Record<string, number> };
    expect(corpo.data).toMatchObject({ refeitos_pela_ficha: 0, falhas: 1 });
  });
});
