/**
 * GET /api/v1/ai/providers — "Indexar o seu material" e "Buscar no seu
 * material" anunciam o modelo de EMBEDDING que roda (fork, briefing item 8).
 *
 * Os dois pontos eram `fixo` sem resposta própria: o resolvedor descia até o
 * padrão da organização, e o painel dizia `claude-sonnet-5` onde nenhum vetor
 * sai de modelo de conversa. Agora a rota pergunta à mesma escada do indexador
 * (`anunciarEmbedding` → `resolverChaveDeEmbedding`), ponto a ponto.
 *
 * Mede a rota de ponta a ponta, com o anúncio dublado: o que a escada decide é
 * medido em `lib/ai/embeddings/anuncio.test.ts` e em `chave.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloDoAnuncio from "@/lib/ai/embeddings/anuncio";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const anunciarEmbedding = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/embeddings/anuncio", async (original) => ({
  ...(await original<typeof ModuloDoAnuncio>()),
  anunciarEmbedding,
}));

const banco = vi.hoisted(() => ({
  lista: {} as Record<string, unknown[]>,
  unica: {} as Record<string, unknown>,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const chain: Record<string, unknown> = {
        maybeSingle: async () => ({ data: banco.unica[tabela] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
          Promise.resolve({ data: banco.lista[tabela] ?? [], error: null }).then(ok, erro),
      };
      for (const m of ["select", "eq", "is", "not", "order", "limit"]) chain[m] = () => chain;
      return chain;
    },
  }),
}));

import { GET } from "@/app/api/v1/ai/providers/route";

type Ponto = { id: string; efetivo: { modelId: string | null; porQue: string }; avisos: string[] };

async function pontos(): Promise<Ponto[]> {
  const res = await GET();
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { pontos: Ponto[] } }).data.pontos;
}

function ponto(lista: Ponto[], id: string): Ponto {
  const p = lista.find((x) => x.id === id);
  expect(p, `ponto ${id} sumiu do painel`).toBeDefined();
  return p!;
}

const ORG = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  banco.lista = {};
  // O padrão da organização é um modelo de CONVERSA — era ele que vazava.
  banco.unica = { organizations: { settings: { llm: { provider: "anthropic", default_model: "claude-sonnet-5" } } } };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "actor", idioma: "pt-BR" },
    org: { orgId: ORG, role: "admin" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
});

describe("GET /api/v1/ai/providers — os pontos de embedding", () => {
  it("⭐ anunciam o modelo de embedding da escada, e não o modelo de conversa", async () => {
    anunciarEmbedding.mockImplementation(async (_org: string, id: string) => ({
      provider: "openai",
      modelId: "openai/text-embedding-3-small",
      motivo: "Usando uma chave da organização cadastrada em Credenciais.",
      avisos: id === "embedding_consultar" ? ["aviso da escada"] : [],
    }));

    const lista = await pontos();

    for (const id of ["embedding_indexar", "embedding_consultar"]) {
      expect(ponto(lista, id).efetivo.modelId).toBe("openai/text-embedding-3-small");
      expect(ponto(lista, id).efetivo.porQue).toBe("Usando uma chave da organização cadastrada em Credenciais.");
    }
    expect(ponto(lista, "embedding_consultar").avisos).toContain("aviso da escada");
    // Cada ponto pergunta pelo seu nome: o binding de um não decide o outro.
    expect(anunciarEmbedding).toHaveBeenCalledWith(ORG, "embedding_indexar");
    expect(anunciarEmbedding).toHaveBeenCalledWith(ORG, "embedding_consultar");
  });

  it("controle: os pontos de conversa seguem o padrão da organização", async () => {
    anunciarEmbedding.mockResolvedValue({ provider: "openai", modelId: "openai/text-embedding-3-small", motivo: "x", avisos: [] });
    const lista = await pontos();
    expect(ponto(lista, "agent_turn").efetivo.modelId).not.toBe("openai/text-embedding-3-small");
  });

  it("sem chave: '—' com o que falta", async () => {
    anunciarEmbedding.mockResolvedValue({
      provider: "",
      modelId: null,
      motivo: "Nenhuma chave para preparar o seu material. Cadastre uma chave da OpenAI ou do Google em Credenciais.",
      avisos: [],
    });
    const p = ponto(await pontos(), "embedding_indexar");
    expect(p.efetivo.modelId).toBeNull();
    expect(p.efetivo.porQue).toMatch(/Nenhuma chave/);
  });

  it("a leitura da chave falhou: o painel abre, e o cartão diz que não confirmou", async () => {
    anunciarEmbedding.mockRejectedValue(new Error("banco fora"));
    const lista = await pontos();
    const p = ponto(lista, "embedding_consultar");
    expect(p.efetivo.modelId).toBeNull();
    expect(p.efetivo.porQue).toMatch(/Não consegui confirmar/);
    expect(p.efetivo.modelId).not.toBe("claude-sonnet-5");
  });
});
