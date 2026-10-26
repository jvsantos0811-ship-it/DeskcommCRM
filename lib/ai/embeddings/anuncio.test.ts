/**
 * O anúncio dos pontos de embedding sai da MESMA escada do indexador
 * (fork, briefing do Operador item 8).
 *
 * A parte pura (`anuncioDaChave`) diz o que a tela mostra para cada degrau; a
 * parte com I/O (`anunciarEmbedding`) prova que pergunta à `resolverChaveDeEmbedding`
 * com o ponto e a família certos, e que uma família ilegível vira aviso — não
 * um painel quebrado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloDaChave from "@/lib/ai/embeddings/chave";

const familiaDaBase = vi.fn();
const resolverChaveDeEmbedding = vi.fn();

vi.mock("@/lib/ai/embeddings/chave", async (original) => ({
  ...(await original<typeof ModuloDaChave>()),
  familiaDaBase: (...a: unknown[]) => familiaDaBase(...a),
  resolverChaveDeEmbedding: (...a: unknown[]) => resolverChaveDeEmbedding(...a),
}));

import { FamiliaDaBaseIlegivelError, type ChaveDeEmbedding } from "@/lib/ai/embeddings/chave";
import { AVISO_DA_FAMILIA_ILEGIVEL } from "@/lib/ai/embeddings/estado";

import {
  anunciarEmbedding,
  anuncioDaChave,
  SEM_CHAVE_DA_OPENAI,
  SEM_CHAVE_DO_GOOGLE,
  SEM_CHAVE_NENHUMA,
} from "./anuncio";

function chave(over: Partial<ChaveDeEmbedding> = {}): ChaveDeEmbedding {
  return {
    apiKey: "sk-nao-sai-daqui",
    baseUrl: null,
    provedor: "openai",
    viaGateway: false,
    origem: "credencial_da_organizacao",
    rotulo: "Chave do escritório",
    avisos: [],
    ...over,
  };
}

describe("anuncioDaChave — o que a tela diz em cada degrau", () => {
  it("⭐ chave da OpenAI → o modelo da OpenAI e o porquê", () => {
    const a = anuncioDaChave(chave(), "openai");
    expect(a.modelId).toBe("openai/text-embedding-3-small");
    expect(a.motivo).toBe("Usando uma chave da organização cadastrada em Credenciais.");
  });

  it("chave do Google → o modelo do Google", () => {
    expect(anuncioDaChave(chave({ provedor: "google" }), "google").modelId).toBe("google/gemini-embedding-001");
  });

  it("gateway e OpenRouter dão o mesmo vetor da OpenAI", () => {
    expect(anuncioDaChave(chave({ provedor: "gateway", origem: "gateway_da_instalacao" }), null).modelId).toBe(
      "openai/text-embedding-3-small",
    );
    expect(anuncioDaChave(chave({ provedor: "openrouter" }), null).modelId).toBe("openai/text-embedding-3-small");
  });

  it("a chave nunca vai para o anúncio", () => {
    expect(JSON.stringify(anuncioDaChave(chave(), "openai"))).not.toContain("sk-nao-sai-daqui");
  });

  it("os avisos da escada chegam à tela", () => {
    expect(anuncioDaChave(chave({ avisos: ["duas chaves"] }), "openai").avisos).toEqual(["duas chaves"]);
  });

  it("sem chave: '—' e o que fazer, pela família da base", () => {
    expect(anuncioDaChave(null, null)).toMatchObject({ modelId: null, motivo: SEM_CHAVE_NENHUMA });
    expect(anuncioDaChave(null, "openai").motivo).toBe(SEM_CHAVE_DA_OPENAI);
    expect(anuncioDaChave(null, "google").motivo).toBe(SEM_CHAVE_DO_GOOGLE);
  });
});

describe("anunciarEmbedding — pergunta à mesma escada do indexador", () => {
  beforeEach(() => {
    familiaDaBase.mockReset();
    resolverChaveDeEmbedding.mockReset();
  });

  it("⭐ passa o ponto e a família da base para `resolverChaveDeEmbedding`", async () => {
    familiaDaBase.mockResolvedValue({ familia: "google", origem: "indice" });
    resolverChaveDeEmbedding.mockResolvedValue(chave({ provedor: "google" }));

    const a = await anunciarEmbedding("org-1", "embedding_consultar");

    expect(resolverChaveDeEmbedding).toHaveBeenCalledWith("org-1", "embedding_consultar", { familia: "google" });
    expect(a.modelId).toBe("google/gemini-embedding-001");
  });

  it("família ilegível vira aviso, e a escada roda sem restrição", async () => {
    familiaDaBase.mockRejectedValue(new FamiliaDaBaseIlegivelError("org-1", "timeout"));
    resolverChaveDeEmbedding.mockResolvedValue(chave());

    const a = await anunciarEmbedding("org-1", "embedding_indexar");

    expect(resolverChaveDeEmbedding).toHaveBeenCalledWith("org-1", "embedding_indexar", { familia: null });
    expect(a.avisos).toContain(AVISO_DA_FAMILIA_ILEGIVEL);
    expect(a.modelId).toBe("openai/text-embedding-3-small");
  });

  it("outro erro não é engolido aqui — quem decide é a rota", async () => {
    familiaDaBase.mockRejectedValue(new Error("banco fora"));
    await expect(anunciarEmbedding("org-1", "embedding_indexar")).rejects.toThrow("banco fora");
  });
});
