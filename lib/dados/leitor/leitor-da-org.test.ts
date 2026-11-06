/**
 * O CARTÃO DO LEITOR E A CHAVE DA INSTALAÇÃO (PM-027, decisão do dono de 06/11:
 * o Leitor usa a mesma chave de IA que o resto do CRM).
 *
 * O "tem chave?" da tela tem de ser a MESMA pergunta da leitura: a credencial da
 * organização vence; sem ela, a chave da instalação (`.env`) daquele provedor;
 * sem nenhuma, `sem_chave` — e só então.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Voltar a contar só a credencial da organização (`temChave = comChave.has`):
 *   os casos "instalação com a chave da Anthropic" acusam.
 * - Trocar `instalacaoAtendeOModelo` por um "sempre true": o caso do Google sem
 *   chave nenhuma acusa.
 * - Deixar a chave da instalação passar à frente da da organização: o caso
 *   "credencial própria continua valendo" acusa.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { env } from "@/lib/env";

import type { RodadaNaTela } from "./bateria-admin";
import { conferirEscolha, modelosNoCartao } from "./leitor-da-org";
import { instalacaoAtendeOModelo } from "./modelo-escolhido";
import type { ModeloDoCatalogo } from "./modelos-principais";

const HAIKU = { provider: "anthropic", model_id: "claude-haiku-5-5" };
const SONNET = { provider: "anthropic", model_id: "claude-sonnet-5-5" };
const GEMINI = { provider: "google", model_id: "gemini-3.5-flash-lite" };

const catalogo: ModeloDoCatalogo[] = [HAIKU, SONNET, GEMINI].map((m) => ({
  ...m,
  display_name: m.model_id,
  input_price_per_million_cents: 100,
  output_price_per_million_cents: 500,
}));

function aprovada(m: { provider: string; model_id: string }): RodadaNaTela {
  return {
    id: `r-${m.model_id}`,
    provider: m.provider,
    model_id: m.model_id,
    juiz_provider: "openai",
    juiz_model_id: "gpt-6.1-sol",
    credencial_organization_id: null,
    status: "terminada",
    criada_em: "2026-11-06T12:00:00Z",
    terminada_em: "2026-11-06T12:30:00Z",
    casos_total: 78,
    casos_feitos: 78,
    acertos: 78,
    bloqueantes: 75,
    bloqueantes_acertos: 75,
    regra_v2: 48,
    qualidade_acertos: 70,
    aprovado: true,
    tempo_medio_ms: 2_000,
    custo_cents: 12,
    erro: null,
  };
}

const rodadas = new Map([HAIKU, SONNET, GEMINI].map((m) => [`${m.provider}/${m.model_id}`, aprovada(m)]));

/** A instalação com chave só da Anthropic (o retrato da VPS do dono). */
const soAnthropic = (m: { provider: string }) => m.provider === "anthropic";

function achar(lista: ReturnType<typeof modelosNoCartao>, m: { provider: string; model_id: string }) {
  return lista.find((x) => x.provider === m.provider && x.model_id === m.model_id)!;
}

describe("o cartão do Leitor conta a chave da instalação", () => {
  it("organização sem credencial e instalação com a chave da Anthropic: o Haiku tem chave, da instalação", () => {
    const lista = modelosNoCartao(catalogo, new Set(), rodadas, null, soAnthropic);
    const haiku = achar(lista, HAIKU);
    expect(haiku.temChave).toBe(true);
    expect(haiku.origemDaChave).toBe("instalacao");
    expect(conferirEscolha({ modelos: lista }, HAIKU, null)).toBeNull();
  });

  it("a reserva também pode usar a chave da instalação", () => {
    const lista = modelosNoCartao(catalogo, new Set(), rodadas, null, soAnthropic);
    expect(conferirEscolha({ modelos: lista }, HAIKU, SONNET)).toBeNull();
  });

  it("sem credencial e sem chave daquele provedor na instalação (Google): continua sem chave", () => {
    const lista = modelosNoCartao(catalogo, new Set(), rodadas, null, soAnthropic);
    const gemini = achar(lista, GEMINI);
    expect(gemini.temChave).toBe(false);
    expect(gemini.origemDaChave).toBeNull();
    expect(conferirEscolha({ modelos: lista }, GEMINI, null)).toBe("sem_chave");
    expect(conferirEscolha({ modelos: lista }, HAIKU, GEMINI)).toBe("sem_chave");
  });

  it("organização com credencial própria: continua valendo a dela (a instalação nem é perguntada)", () => {
    const perguntou = vi.fn(soAnthropic);
    const lista = modelosNoCartao(catalogo, new Set(["anthropic", "google"]), rodadas, null, perguntou);
    expect(achar(lista, HAIKU).origemDaChave).toBe("empresa");
    expect(achar(lista, GEMINI).origemDaChave).toBe("empresa");
    expect(perguntou).not.toHaveBeenCalled();
  });

  it("a régua da bateria não muda: modelo não aprovado e reserva igual seguem recusados", () => {
    const reprovado = new Map(rodadas);
    reprovado.set("anthropic/claude-sonnet-5-5", { ...aprovada(SONNET), aprovado: false });
    const lista = modelosNoCartao(catalogo, new Set(), reprovado, null, soAnthropic);
    expect(conferirEscolha({ modelos: lista }, SONNET, null)).toBe("modelo_nao_aprovado");
    expect(conferirEscolha({ modelos: lista }, HAIKU, SONNET)).toBe("reserva_nao_aprovada");
    expect(conferirEscolha({ modelos: lista }, HAIKU, HAIKU)).toBe("reserva_igual");
  });
});

describe("instalacaoAtendeOModelo é a pergunta da leitura (resolveLanguageModel)", () => {
  const nomes = ["AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
  const antes = Object.fromEntries(nomes.map((n) => [n, (env as Record<string, unknown>)[n]]));
  const definir = (valores: Partial<Record<(typeof nomes)[number], string>>) => {
    for (const n of nomes) (env as Record<string, unknown>)[n] = valores[n];
  };
  afterEach(() => {
    for (const n of nomes) (env as Record<string, unknown>)[n] = antes[n];
  });

  it("com ANTHROPIC_API_KEY: atende o Haiku e não atende o Gemini", () => {
    definir({ ANTHROPIC_API_KEY: "sk-ant-de-teste" });
    expect(instalacaoAtendeOModelo(HAIKU)).toBe(true);
    expect(instalacaoAtendeOModelo(GEMINI)).toBe(false);
  });

  it("com OPENAI_API_KEY só: atende o GPT e não o Haiku", () => {
    definir({ OPENAI_API_KEY: "sk-de-teste" });
    expect(instalacaoAtendeOModelo({ provider: "openai", model_id: "gpt-6-luna" })).toBe(true);
    expect(instalacaoAtendeOModelo(HAIKU)).toBe(false);
  });

  it("com o gateway (ou o OpenRouter): atende qualquer provedor", () => {
    definir({ OPENROUTER_API_KEY: "sk-or-de-teste" });
    expect(instalacaoAtendeOModelo(GEMINI)).toBe(true);
    expect(instalacaoAtendeOModelo(HAIKU)).toBe(true);
  });

  it("sem chave nenhuma na instalação: não atende ninguém", () => {
    definir({});
    expect(instalacaoAtendeOModelo(HAIKU)).toBe(false);
    expect(instalacaoAtendeOModelo(GEMINI)).toBe(false);
  });
});
