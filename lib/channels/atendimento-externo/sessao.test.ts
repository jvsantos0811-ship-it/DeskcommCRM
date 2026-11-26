import { describe, expect, it } from "vitest";

import { CONFIG_VAZIA } from "./config";
import {
  MAXIMO_DE_NUMEROS,
  escolherAlvoDaConexao,
  escolherConexaoEmUso,
  principalDoAtendimento,
  type SessaoDoAtendimentoExterno,
} from "./sessao";

/**
 * PC-053 — dois números da plataforma na mesma organização. A escolha de QUAL
 * linha uma credencial grava (e qual conexão uma configuração atinge) é pura, e
 * é onde mora o risco: gravar por cima do número que já atende o calaria.
 */
function sessao(id: string, phoneId: string, extra: Partial<SessaoDoAtendimentoExterno> = {}): SessaoDoAtendimentoExterno {
  return {
    id,
    servidor: "s1",
    accountId: "conta-1",
    phoneId,
    displayName: null,
    status: "WORKING",
    webhookPathToken: `tok-${id}`,
    temChave: true,
    segredoCifrado: "x",
    config: CONFIG_VAZIA,
    archivedAt: null,
    createdAt: `2026-11-2${id.length}T00:00:00Z`,
    chaveCifrada: "cifrada",
    ...extra,
  };
}

const A = sessao("a", "fone-oficial", { createdAt: "2026-11-20T00:00:00Z" });
const B = sessao("b", "fone-qr", { createdAt: "2026-11-25T00:00:00Z" });

describe("escolherAlvoDaConexao — quem tem UM número não muda", () => {
  it("sem conexão nenhuma: cria", () => {
    expect(escolherAlvoDaConexao([], { phoneId: "fone-oficial" })).toEqual({ tipo: "nova" });
  });

  it("um número, mesma credencial colada de novo: troca a chave da mesma linha", () => {
    const alvo = escolherAlvoDaConexao([A], { phoneId: "fone-oficial" });
    expect(alvo).toEqual({ tipo: "existente", sessao: A });
  });

  it("um número, sem dizer qual, com OUTRO phone_id: troca a principal, como antes do PC-053", () => {
    const alvo = escolherAlvoDaConexao([A], { phoneId: "fone-trocado" });
    expect(alvo).toEqual({ tipo: "existente", sessao: A });
  });

  it("a única conexão desconectada volta (com conversas e configuração)", () => {
    const fora = { ...A, archivedAt: "2026-11-24T00:00:00Z" };
    expect(escolherAlvoDaConexao([fora], { phoneId: "outro" })).toEqual({ tipo: "existente", sessao: fora });
  });
});

describe("escolherAlvoDaConexao — o segundo número", () => {
  it("'Adicionar' com número novo: cria ao lado, sem tocar o primeiro", () => {
    expect(escolherAlvoDaConexao([A], { phoneId: "fone-qr", novo: true })).toEqual({ tipo: "nova" });
  });

  it("'Adicionar' com o número que já atende: recusa em vez de gravar por cima", () => {
    expect(escolherAlvoDaConexao([A], { phoneId: "fone-oficial", novo: true })).toEqual({
      tipo: "numero_ja_conectado",
    });
  });

  it("'Adicionar' com dois em uso: teto", () => {
    expect(escolherAlvoDaConexao([A, B], { phoneId: "fone-3", novo: true })).toEqual({
      tipo: "teto",
      maximo: MAXIMO_DE_NUMEROS,
    });
  });

  it("dois em uso e nenhum pedido: recusa em vez de adivinhar", () => {
    expect(escolherAlvoDaConexao([A, B], { phoneId: "fone-3" })).toEqual({ tipo: "numero_nao_informado" });
  });

  it("dois em uso, credencial do número B colada sem pedido: vai para o B, não para a principal", () => {
    expect(escolherAlvoDaConexao([A, B], { phoneId: "fone-qr" })).toEqual({ tipo: "existente", sessao: B });
  });

  it("pedido explícito: aquela conexão, e só ela", () => {
    expect(escolherAlvoDaConexao([A, B], { phoneId: "fone-qr", channelSessionId: "b" })).toEqual({
      tipo: "existente",
      sessao: B,
    });
  });

  it("pedido explícito com o número de OUTRA conexão em uso: recusa", () => {
    expect(escolherAlvoDaConexao([A, B], { phoneId: "fone-oficial", channelSessionId: "b" })).toEqual({
      tipo: "numero_em_outra_conexao",
    });
  });

  it("pedido de conexão que não é desta organização: não encontrada", () => {
    expect(escolherAlvoDaConexao([A], { phoneId: "x", channelSessionId: "de-outra-org" })).toEqual({
      tipo: "nao_encontrada",
    });
  });

  it("número de uma conexão desconectada volta — mas ocupa vaga e passa pelo teto", () => {
    const fora = sessao("c", "fone-velho", { archivedAt: "2026-11-01T00:00:00Z" });
    expect(escolherAlvoDaConexao([A, fora], { phoneId: "fone-velho", novo: true })).toEqual({
      tipo: "existente",
      sessao: fora,
    });
    expect(escolherAlvoDaConexao([A, B, fora], { phoneId: "fone-velho", novo: true })).toEqual({
      tipo: "teto",
      maximo: MAXIMO_DE_NUMEROS,
    });
  });
});

describe("escolherConexaoEmUso — configuração e troca de endereço", () => {
  it("um número e nenhum pedido: o único (comportamento de antes)", () => {
    expect(escolherConexaoEmUso([A], null)).toEqual({ sessao: A });
  });

  it("dois números e nenhum pedido: recusa", () => {
    expect(escolherConexaoEmUso([A, B], null)).toEqual({ motivo: "numero_nao_informado" });
  });

  it("pedido de um número em uso: ele", () => {
    expect(escolherConexaoEmUso([A, B], "b")).toEqual({ sessao: B });
  });

  it("pedido de conexão desconectada ou de outra organização: não encontrada", () => {
    const fora = { ...B, archivedAt: "2026-11-26T00:00:00Z" };
    expect(escolherConexaoEmUso([A, fora], "b")).toEqual({ motivo: "nao_encontrada" });
    expect(escolherConexaoEmUso([A], "zzz")).toEqual({ motivo: "nao_encontrada" });
  });

  it("nenhuma em uso: conecte antes", () => {
    expect(escolherConexaoEmUso([], null)).toEqual({ motivo: "nenhuma" });
  });
});

describe("principalDoAtendimento", () => {
  it("a mais antiga em uso; sem nenhuma em uso, a desconectada mais recente", () => {
    expect(principalDoAtendimento([A, B])).toBe(A);
    const foraA = { ...A, archivedAt: "x" };
    const foraB = { ...B, archivedAt: "y" };
    expect(principalDoAtendimento([foraA, B])).toBe(B);
    expect(principalDoAtendimento([foraA, foraB])).toBe(foraB);
    expect(principalDoAtendimento([])).toBeNull();
  });
});

describe("conexaoIrmaDoNumero — o outro número da mesma conta", () => {
  async function irmaCom(atual: Record<string, unknown> | null, achada: { id: string } | null) {
    const { conexaoIrmaDoNumero } = await import("./sessao");
    const filtros: Array<[string, unknown]> = [];
    let chamada = 0;
    const from = () => {
      const minha = ++chamada;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push([`${minha}:${c}`, v]), q),
        is: (c: string, v: unknown) => (filtros.push([`${minha}:${c}`, v]), q),
        neq: (c: string, v: unknown) => (filtros.push([`${minha}:neq:${c}`, v]), q),
        limit: () => q,
        maybeSingle: async () => ({ data: minha === 1 ? atual : achada, error: null }),
      };
      return q;
    };
    const id = await conexaoIrmaDoNumero({ from } as never, "org-1", "sess-a", "fone-b");
    return { id, filtros };
  }

  it("acha só na MESMA organização, servidor e conta, ativa e diferente da atual", async () => {
    const { id, filtros } = await irmaCom({ chatguru_servidor: "s22", chatguru_account_id: "conta-1" }, { id: "sess-b" });
    expect(id).toBe("sess-b");
    expect(filtros).toEqual(
      expect.arrayContaining([
        ["2:organization_id", "org-1"],
        ["2:chatguru_servidor", "s22"],
        ["2:chatguru_account_id", "conta-1"],
        ["2:chatguru_phone_id", "fone-b"],
        ["2:archived_at", null],
        ["2:neq:id", "sess-a"],
      ]),
    );
  });

  it("conexão atual sem conta conhecida: nenhuma irmã (nem pergunta)", async () => {
    const { id, filtros } = await irmaCom({ chatguru_servidor: null, chatguru_account_id: null }, { id: "sess-b" });
    expect(id).toBeNull();
    expect(filtros.some(([c]) => c.startsWith("2:"))).toBe(false);
  });
});
