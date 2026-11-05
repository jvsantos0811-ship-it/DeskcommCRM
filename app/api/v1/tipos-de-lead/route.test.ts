import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const TIPO_ID = "33333333-3333-4333-8333-333333333333";

let inserido: Record<string, unknown> | null = null;
let atualizado: Record<string, unknown> | null = null;
let filtros: Array<[string, unknown]> = [];
let erroDoInsert: { code: string } | null = null;

function cadeia(resposta: () => unknown) {
  const c: Record<string, unknown> = {};
  c.eq = (col: string, v: unknown) => {
    filtros.push([col, v]);
    return c;
  };
  c.select = () => c;
  c.maybeSingle = async () => resposta();
  c.single = async () => resposta();
  return c;
}

function admin() {
  return {
    from: (tabela: string) => {
      if (tabela === "organizations") return cadeia(() => ({ data: { currency: "BRL" }, error: null }));
      return {
        select: () => cadeia(() => ({ data: { preco_cents: 100000 }, error: null })),
        insert: (linha: Record<string, unknown>) => {
          inserido = linha;
          return cadeia(() =>
            erroDoInsert ? { data: null, error: erroDoInsert } : { data: { id: TIPO_ID, ...linha }, error: null },
          );
        },
        update: (patch: Record<string, unknown>) => {
          atualizado = patch;
          return cadeia(() => ({ data: { id: TIPO_ID, preco_cents: patch.preco_cents ?? 100000 }, error: null }));
        },
      };
    },
  };
}

function pedido(metodo: string, corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/tipos-de-lead", {
    method: metodo,
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  inserido = null;
  atualizado = null;
  filtros = [];
  erroDoInsert = null;
  vi.mocked(createAdminClient).mockReturnValue(admin() as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
});

describe("POST /api/v1/tipos-de-lead", () => {
  it("cria o item como tipo de lead, na organização da SESSÃO, com a moeda da organização, e audita", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      pedido("POST", {
        nome: "Auxílio-acidente",
        preco_cents: 300000,
        valor_confirmado: true,
        organization_id: "99999999-9999-4999-8999-999999999999",
        moeda: "USD",
        tipo_de_lead: false,
      }),
    );
    expect(res.status).toBe(201);
    expect(requireSupportWrite).toHaveBeenCalled();
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(inserido).toMatchObject({
      organization_id: ORG_ID,
      nome: "Auxílio-acidente",
      codigo: "tl-auxilio-acidente",
      preco_cents: 300000,
      valor_confirmado: true,
      tipo_de_lead: true,
      moeda: "BRL",
      controla_estoque: false,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "tipo_de_lead.created", organizationId: ORG_ID, resourceId: TIPO_ID }),
    );
  });

  it("papel abaixo de gerente recebe a recusa do requireRole e nada é gravado", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }),
    } as never);
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", { nome: "BPC/LOAS", preco_cents: 1 }));
    expect(res.status).toBe(403);
    expect(inserido).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("suporte só leitura é barrado antes do efeito", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(new Response(null, { status: 403 }) as never);
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", { nome: "BPC/LOAS", preco_cents: 1 }));
    expect(res.status).toBe(403);
    expect(inserido).toBeNull();
  });

  it("valor negativo é 422; nome repetido é 409", async () => {
    const { POST } = await import("./route");
    expect((await POST(pedido("POST", { nome: "BPC/LOAS", preco_cents: -1 }))).status).toBe(422);
    erroDoInsert = { code: "23505" };
    expect((await POST(pedido("POST", { nome: "BPC/LOAS", preco_cents: 1 }))).status).toBe(409);
  });
});

describe("PATCH /api/v1/tipos-de-lead/:id", () => {
  it("muda o valor filtrando organização e tipo_de_lead, e audita o antes e o depois", async () => {
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(pedido("PATCH", { preco_cents: 320000, valor_confirmado: true }), {
      params: Promise.resolve({ id: TIPO_ID }),
    });
    expect(res.status).toBe(200);
    expect(atualizado).toEqual({ preco_cents: 320000, valor_confirmado: true });
    expect(filtros).toContainEqual(["organization_id", ORG_ID]);
    expect(filtros).toContainEqual(["tipo_de_lead", true]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tipo_de_lead.updated",
        metadata: expect.objectContaining({ preco_cents: { antes: 100000, depois: 320000 } }),
      }),
    );
  });

  it("corpo vazio é 422 e não grava", async () => {
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(pedido("PATCH", {}), { params: Promise.resolve({ id: TIPO_ID }) });
    expect(res.status).toBe(422);
    expect(atualizado).toBeNull();
  });
});
