/**
 * PC-058 — o diálogo que a equipe executa na plataforma (ChatGuru) ao assumir o
 * chat: o POST que carrega o `valor_ao_passar` no campo da IA. Com a chave da
 * conexão ligada ele vira "a equipe assumiu" (o mesmo serviço do PC-029) e NÃO
 * vira mensagem; desligada, ou sem o valor, o POST segue o caminho de sempre.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const chamadas: Array<Record<string, unknown>> = [];
let resultadoDoServico: Record<string, unknown> = { aplicado: true, cardMovidoPara: "etapa-equipe" };
let contatoAchado: { id: string; phone_number: string } | null = { id: "contato-1", phone_number: "5531999998888" };

vi.mock("@/lib/escalacao/equipe-assumiu", () => ({
  equipeAssumiuRespondendo: vi.fn(async (_admin: unknown, e: Record<string, unknown>) => {
    chamadas.push(e);
    return resultadoDoServico;
  }),
}));
vi.mock("../contato-por-telefone", () => ({
  encontrarContatoPorTelefone: vi.fn(async () => contatoAchado),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { ehSinalDeEquipeAssumiu, tratarEquipeAssumiuDoPost } from "./equipe-assumiu";

const ORG = "org-1";
const SESSAO = "sessao-1";
const LIGADA = {
  campo_da_ia: { nome: "LSIA", valor_ao_passar: "equipe" },
  acoes: [],
  valor_quando_equipe_assume: "assumido",
};

function admin(config: unknown, conversas: Array<Record<string, unknown>> = [{ id: "conv-1" }]) {
  const lidas: string[] = [];
  const gravacoes: Array<{ tabela: string; valores: Record<string, unknown> }> = [];
  const filtros: Array<{ tabela: string; coluna: string; valor: unknown }> = [];
  const from = (tabela: string) => {
    lidas.push(tabela);
    const q: Record<string, unknown> = {
      select: () => q,
      update: (valores: Record<string, unknown>) => {
        gravacoes.push({ tabela, valores });
        return q;
      },
      eq: (coluna: string, valor: unknown) => {
        filtros.push({ tabela, coluna, valor });
        return q;
      },
      order: () => q,
      limit: () => q,
      maybeSingle: async () => {
        if (tabela === "channel_sessions") return { data: { chatguru_config: config }, error: null };
        if (tabela === "conversations") return { data: conversas[0] ?? null, error: null };
        return { data: null, error: null };
      },
    };
    return q;
  };
  return { cliente: { from } as never, lidas, filtros, gravacoes };
}

const post = (campos: unknown, extra: Record<string, unknown> = {}) => ({
  celular: "5531999998888",
  texto_mensagem: "última mensagem do chat",
  campos_personalizados: campos,
  ...extra,
});

beforeEach(() => {
  chamadas.length = 0;
  resultadoDoServico = { aplicado: true, cardMovidoPara: "etapa-equipe" };
  contatoAchado = { id: "contato-1", phone_number: "5531999998888" };
});

describe("ehSinalDeEquipeAssumiu (regra pura)", () => {
  const config = {
    campoDaIa: { nome: "LSIA", valorAoPassar: "equipe" },
    valorQuandoEquipeAssume: "assumido",
    variavelQuandoEquipeAssume: null as string | null,
  };

  it("reconhece o valor, sem acento e sem caixa, em objeto ou em JSON-texto", () => {
    expect(ehSinalDeEquipeAssumiu(post({ LSIA: "assumido" }), config)).toBe(true);
    expect(ehSinalDeEquipeAssumiu(post({ LSIA: " Assumído " }), config)).toBe(true);
    expect(ehSinalDeEquipeAssumiu(post('{"LSIA":"assumido"}'), config)).toBe(true);
  });

  it("o valor da PASSAGEM da IA nunca é sinal (a mensagem do lead depois da passagem não é engolida)", () => {
    expect(ehSinalDeEquipeAssumiu(post({ LSIA: "equipe" }), config)).toBe(false);
    // Mesmo se a conexão foi gravada com os dois iguais (a tela recusa; a regra não confia só nela).
    expect(ehSinalDeEquipeAssumiu(post({ LSIA: "equipe" }), { ...config, valorQuandoEquipeAssume: "Equipe" })).toBe(false);
  });

  it("não reconhece outro valor, outro campo ou campo ausente", () => {
    expect(ehSinalDeEquipeAssumiu(post({ LSIA: "novo" }), config)).toBe(false);
    expect(ehSinalDeEquipeAssumiu(post({ OUTRO: "assumido" }), config)).toBe(false);
    expect(ehSinalDeEquipeAssumiu(post(undefined), config)).toBe(false);
  });

  it("valor vazio (desligado) ou sem campo da IA: nunca é sinal", () => {
    expect(ehSinalDeEquipeAssumiu(post({ LSIA: "assumido" }), { ...config, valorQuandoEquipeAssume: null })).toBe(false);
    expect(ehSinalDeEquipeAssumiu(post({ LSIA: "" }), { ...config, valorQuandoEquipeAssume: "" })).toBe(false);
    expect(ehSinalDeEquipeAssumiu(post({ LSIA: "assumido" }), { ...config, campoDaIa: null })).toBe(false);
  });
});

describe("ehSinalDeEquipeAssumiu pela variável de contexto (bot_context)", () => {
  // A forma real do ChatGuru: o diálogo grava a variável de contexto, que chega em todo POST.
  const config = {
    campoDaIa: null,
    valorQuandoEquipeAssume: "assumido",
    variavelQuandoEquipeAssume: "LSIA" as string | null,
  };

  it("reconhece a variável em objeto ou em JSON-texto, sem acento e sem caixa", () => {
    expect(ehSinalDeEquipeAssumiu(post({}, { bot_context: { URA: "x", LSIA: "assumido" } }), config)).toBe(true);
    expect(ehSinalDeEquipeAssumiu(post({}, { bot_context: '{"LSIA":" Assumído "}' }), config)).toBe(true);
  });

  it("o valor de antes (novo), outra variável ou contexto ausente: não é sinal", () => {
    expect(ehSinalDeEquipeAssumiu(post({}, { bot_context: { LSIA: "novo" } }), config)).toBe(false);
    expect(ehSinalDeEquipeAssumiu(post({}, { bot_context: { OUTRA: "assumido" } }), config)).toBe(false);
    expect(ehSinalDeEquipeAssumiu(post({}), config)).toBe(false);
    expect(ehSinalDeEquipeAssumiu(post({}, { bot_context: "lixo" }), config)).toBe(false);
  });

  it("com a variável preenchida, o campo personalizado de mesmo nome não conta", () => {
    expect(ehSinalDeEquipeAssumiu(post({ LSIA: "assumido" }, { bot_context: { LSIA: "novo" } }), config)).toBe(false);
  });

  it("sem valor (desligado), a variável sozinha nunca é sinal", () => {
    expect(
      ehSinalDeEquipeAssumiu(post({}, { bot_context: { LSIA: "assumido" } }), { ...config, valorQuandoEquipeAssume: null }),
    ).toBe(false);
  });
});

describe("tratarEquipeAssumiuDoPost", () => {
  it("só a TRANSIÇÃO é sinal: com o valor já consumido, o POST seguinte vira mensagem normal", async () => {
    const cfg = { acoes: [], valor_quando_equipe_assume: "assumido", variavel_quando_equipe_assume: "LSIA" };
    const a = admin(cfg, [{ id: "conv-1", metadata: { equipe_assumiu_na_plataforma_consumido: true } }]);
    const r = await tratarEquipeAssumiuDoPost(a.cliente, {
      orgId: ORG,
      channelSessionId: SESSAO,
      corpo: { celular: "5531999998888", texto_mensagem: "mensagem do lead", bot_context: { LSIA: "assumido" } },
    });
    expect(r).toEqual({ reconhecido: false });
    expect(chamadas).toHaveLength(0);
    expect(a.gravacoes).toHaveLength(0);
  });

  it("o primeiro POST com o valor marca a conversa como consumida", async () => {
    const cfg = { acoes: [], valor_quando_equipe_assume: "assumido", variavel_quando_equipe_assume: "LSIA" };
    const a = admin(cfg, [{ id: "conv-1", metadata: { outra: 1 } }]);
    await tratarEquipeAssumiuDoPost(a.cliente, {
      orgId: ORG,
      channelSessionId: SESSAO,
      corpo: { celular: "5531999998888", texto_mensagem: "x", bot_context: { LSIA: "assumido" } },
    });
    expect(a.gravacoes).toEqual([
      { tabela: "conversations", valores: { metadata: { outra: 1, equipe_assumiu_na_plataforma_consumido: true } } },
    ]);
    expect(a.filtros).toContainEqual({ tabela: "conversations", coluna: "id", valor: "conv-1" });
  });

  it("efeito que falha não consome a marca: o próximo POST tenta de novo", async () => {
    resultadoDoServico = { aplicado: false, motivo: "erro" };
    const cfg = { acoes: [], valor_quando_equipe_assume: "assumido", variavel_quando_equipe_assume: "LSIA" };
    const a = admin(cfg, [{ id: "conv-1", metadata: {} }]);
    const r = await tratarEquipeAssumiuDoPost(a.cliente, {
      orgId: ORG,
      channelSessionId: SESSAO,
      corpo: { celular: "5531999998888", texto_mensagem: "x", bot_context: { LSIA: "assumido" } },
    });
    expect(r).toEqual({ reconhecido: true, status: "nao_aplicado" });
    expect(a.gravacoes).toHaveLength(0);
  });

  it("POST com outro valor rearma a transição e segue como mensagem", async () => {
    const cfg = { acoes: [], valor_quando_equipe_assume: "assumido", variavel_quando_equipe_assume: "LSIA" };
    const a = admin(cfg, [{ id: "conv-1", metadata: { equipe_assumiu_na_plataforma_consumido: true } }]);
    const r = await tratarEquipeAssumiuDoPost(a.cliente, {
      orgId: ORG,
      channelSessionId: SESSAO,
      corpo: { celular: "5531999998888", texto_mensagem: "oi", bot_context: { LSIA: "novo" } },
    });
    expect(r).toEqual({ reconhecido: false });
    expect(a.gravacoes).toEqual([
      { tabela: "conversations", valores: { metadata: { equipe_assumiu_na_plataforma_consumido: false } } },
    ]);
  });

  it("POST com outro valor e nada consumido: não grava nada", async () => {
    const cfg = { acoes: [], valor_quando_equipe_assume: "assumido", variavel_quando_equipe_assume: "LSIA" };
    const a = admin(cfg, [{ id: "conv-1", metadata: {} }]);
    await tratarEquipeAssumiuDoPost(a.cliente, {
      orgId: ORG,
      channelSessionId: SESSAO,
      corpo: { celular: "5531999998888", texto_mensagem: "oi", bot_context: { LSIA: "novo" } },
    });
    expect(a.gravacoes).toHaveLength(0);
  });

  it("pela variável de contexto: aplica mesmo sem campos personalizados no POST", async () => {
    const a = admin({ acoes: [], valor_quando_equipe_assume: "assumido", variavel_quando_equipe_assume: "LSIA" });
    const r = await tratarEquipeAssumiuDoPost(a.cliente, {
      orgId: ORG,
      channelSessionId: SESSAO,
      corpo: { celular: "5531999998888", texto_mensagem: "x", bot_context: { LSIA: "assumido" } },
    });
    expect(r).toEqual({ reconhecido: true, status: "aplicado", cardMovidoPara: "etapa-equipe" });
    expect(chamadas).toHaveLength(1);
  });

  it("ligada e com o valor: aplica pelo serviço do PC-029, origem plataforma, e o POST não vira mensagem", async () => {
    const a = admin(LIGADA);
    const r = await tratarEquipeAssumiuDoPost(a.cliente, {
      orgId: ORG,
      channelSessionId: SESSAO,
      corpo: post({ LSIA: "assumido" }),
    });
    expect(r).toEqual({ reconhecido: true, status: "aplicado", cardMovidoPara: "etapa-equipe" });
    expect(chamadas).toEqual([
      expect.objectContaining({ organizationId: ORG, conversationId: "conv-1", origem: "plataforma", userId: null }),
    ]);
    // A organização e o número vêm de quem chama, e toda leitura filtra por eles.
    for (const tabela of ["channel_sessions", "conversations"]) {
      expect(a.filtros).toContainEqual({ tabela, coluna: "organization_id", valor: ORG });
    }
    expect(a.filtros).toContainEqual({ tabela: "channel_sessions", coluna: "id", valor: SESSAO });
    expect(a.filtros).toContainEqual({ tabela: "conversations", coluna: "channel_session_id", valor: SESSAO });
  });

  it("desligada (padrão): não é sinal, nada é aplicado", async () => {
    const a = admin({ ...LIGADA, valor_quando_equipe_assume: undefined });
    const r = await tratarEquipeAssumiuDoPost(a.cliente, {
      orgId: ORG,
      channelSessionId: SESSAO,
      corpo: post({ LSIA: "assumido" }),
    });
    expect(r).toEqual({ reconhecido: false });
    expect(chamadas).toHaveLength(0);
  });

  it("POST comum, sem campos personalizados nem contexto: nem lê a conexão", async () => {
    const a = admin(LIGADA);
    const r = await tratarEquipeAssumiuDoPost(a.cliente, {
      orgId: ORG,
      channelSessionId: SESSAO,
      corpo: { celular: "5531999998888", texto_mensagem: "oi" },
    });
    expect(r).toEqual({ reconhecido: false });
    expect(a.lidas).toHaveLength(0);
  });

  it("contato ou conversa que o CRM não conhece: reconhecido e descartado, sem criar nada", async () => {
    contatoAchado = null;
    const semContato = await tratarEquipeAssumiuDoPost(admin(LIGADA).cliente, {
      orgId: ORG,
      channelSessionId: SESSAO,
      corpo: post({ LSIA: "assumido" }),
    });
    expect(semContato).toEqual({ reconhecido: true, status: "sem_contato" });

    contatoAchado = { id: "contato-1", phone_number: "5531999998888" };
    const semConversa = await tratarEquipeAssumiuDoPost(admin(LIGADA, []).cliente, {
      orgId: ORG,
      channelSessionId: SESSAO,
      corpo: post({ LSIA: "assumido" }),
    });
    expect(semConversa).toEqual({ reconhecido: true, status: "sem_conversa" });
    expect(chamadas).toHaveLength(0);
  });

  it("já com a equipe: reconhecido, sem refazer", async () => {
    resultadoDoServico = { aplicado: false, motivo: "ja_assumida" };
    const r = await tratarEquipeAssumiuDoPost(admin(LIGADA).cliente, {
      orgId: ORG,
      channelSessionId: SESSAO,
      corpo: post({ LSIA: "assumido" }),
    });
    expect(r).toEqual({ reconhecido: true, status: "ja_assumida" });
  });
});
