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
  const filtros: Array<{ tabela: string; coluna: string; valor: unknown }> = [];
  const from = (tabela: string) => {
    lidas.push(tabela);
    const q: Record<string, unknown> = {
      select: () => q,
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
  return { cliente: { from } as never, lidas, filtros };
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
  const config = { campoDaIa: { nome: "LSIA", valorAoPassar: "equipe" }, valorQuandoEquipeAssume: "assumido" };

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

describe("tratarEquipeAssumiuDoPost", () => {
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

  it("POST comum, sem campos personalizados: nem lê a conexão", async () => {
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
