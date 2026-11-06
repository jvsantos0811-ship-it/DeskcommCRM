/**
 * "ATUALIZAR AGORA" (v3 §8.3): suporte só leitura barrado antes do efeito,
 * gerente para cima, organização da SESSÃO, no máximo uma vez a cada 30 min —
 * a recusa é 409 com a hora de voltar e fica na auditoria como o sucesso.
 * A trava de verdade é do banco (`tests/invariants/retrato-de-dados.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as GerarRetrato from "@/lib/dados/gerar-retrato";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/dados/leitor/rodadas", () => ({ rodadaManualDoLeitor: vi.fn(async () => null) }));
vi.mock("@/lib/dados/leitor/ler-lead", () => ({ criarLeitor: vi.fn(() => vi.fn()) }));
vi.mock("@/lib/dados/gerar-retrato", async (importOriginal) => {
  const real = await importOriginal<typeof GerarRetrato>();
  return { ...real, gerarRetratoDaOrg: vi.fn() };
});

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { gerarRetratoDaOrg } from "@/lib/dados/gerar-retrato";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
let filtros: Array<[string, unknown]> = [];

function admin(ultimoGeradoEm: string | null) {
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.eq = (col: string, v: unknown) => {
    filtros.push([col, v]);
    return c;
  };
  c.order = () => c;
  c.limit = () => c;
  c.maybeSingle = async () => ({ data: ultimoGeradoEm ? { gerado_em: ultimoGeradoEm } : null, error: null });
  return { from: () => c };
}

beforeEach(() => {
  vi.clearAllMocks();
  filtros = [];
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: USER, idioma: "pt-BR" }, org: { orgId: ORG, role: "manager" } } as never);
});

describe("POST /api/v1/dados/qualidade/atualizar", () => {
  it("gera o retrato da organização da sessão, como manual, e audita", async () => {
    vi.mocked(createAdminClient).mockReturnValue(admin(new Date(Date.now() - 31 * 60_000).toISOString()) as never);
    vi.mocked(gerarRetratoDaOrg).mockResolvedValue({
      dia: "2026-11-05",
      geradoEm: "2026-11-05T13:00:00.000Z",
      gravado: true,
      motivo: "gravado",
      proximoEm: "2026-11-05T13:30:00.000Z",
      apagados: 0,
      leads: 46,
    });
    const { POST } = await import("./route");
    const res = await POST();
    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(filtros).toContainEqual(["organization_id", ORG]);
    expect(vi.mocked(gerarRetratoDaOrg).mock.calls[0]?.slice(1, 3)).toEqual([ORG, "manual"]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "dados.retrato_gerado", organizationId: ORG, actorUserId: USER }),
    );
  });

  it("menos de 30 minutos depois do último: 409 com a hora de voltar, auditado, e nada é montado", async () => {
    const ha10 = new Date(Date.now() - 10 * 60_000).toISOString();
    vi.mocked(createAdminClient).mockReturnValue(admin(ha10) as never);
    const { POST } = await import("./route");
    const res = await POST();
    expect(res.status).toBe(409);
    const corpo = (await res.json()) as { error: { code: string; message: string; details: { proximo_em: string } } };
    expect(corpo.error.code).toBe("retrato_recente");
    expect(corpo.error.message).toMatch(/menos de 30 minutos/);
    expect(Date.parse(corpo.error.details.proximo_em)).toBe(Date.parse(ha10) + 30 * 60_000);
    expect(gerarRetratoDaOrg).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "dados.retrato_recusado", organizationId: ORG }));
  });

  it("o banco recusou no meio (outro clique gravou antes): também 409 e auditado", async () => {
    vi.mocked(createAdminClient).mockReturnValue(admin(null) as never);
    vi.mocked(gerarRetratoDaOrg).mockResolvedValue({
      dia: "2026-11-05",
      geradoEm: "2026-11-05T12:59:00.000Z",
      gravado: false,
      motivo: "recente",
      proximoEm: "2026-11-05T13:29:00.000Z",
      apagados: 0,
      leads: 46,
    });
    const { POST } = await import("./route");
    expect((await POST()).status).toBe(409);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "dados.retrato_recusado" }));
  });

  it("abaixo de gerente recebe a recusa do requireRole; suporte só leitura é barrado antes", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }),
    } as never);
    const { POST } = await import("./route");
    expect((await POST()).status).toBe(403);
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(new Response(null, { status: 403 }) as never);
    expect((await POST()).status).toBe(403);
    expect(gerarRetratoDaOrg).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
