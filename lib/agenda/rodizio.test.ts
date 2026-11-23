import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { listaDoRodizio, ordemDaVez, ordemDoRodizio } from "./rodizio";

// O rodízio lê a equipe pelo client ADMIN quando há service role (RLS do
// atendente). Aqui o banco é o dublê: desliga o admin para a leitura cair nele.
vi.mock("@/lib/audit", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  isServiceRoleConfigured: () => false,
}));

describe("rodízio de responsáveis (PC-052)", () => {
  const maria = "11111111-1111-4111-8111-111111111111";
  const jessica = "22222222-2222-4222-8222-222222222222";
  const ana = "33333333-3333-4333-8333-333333333333";

  it("sem histórico, começa pela primeira da lista", () => {
    expect(ordemDaVez([maria, jessica], null)).toEqual([maria, jessica]);
  });

  it("a vez é de quem vem depois de quem recebeu o último compromisso", () => {
    expect(ordemDaVez([maria, jessica], maria)).toEqual([jessica, maria]);
    expect(ordemDaVez([maria, jessica], jessica)).toEqual([maria, jessica]);
    expect(ordemDaVez([maria, jessica, ana], jessica)).toEqual([ana, maria, jessica]);
  });

  it("alterna 5 e 5 em 10 marcações seguidas", () => {
    const contagem = new Map<string, number>();
    let ultimo: string | null = null;
    for (let i = 0; i < 10; i++) {
      const daVez: string = ordemDaVez([maria, jessica], ultimo)[0]!;
      contagem.set(daVez, (contagem.get(daVez) ?? 0) + 1);
      ultimo = daVez;
    }
    expect(contagem.get(maria)).toBe(5);
    expect(contagem.get(jessica)).toBe(5);
  });

  it("quem recebeu o último e saiu da lista não trava a vez", () => {
    expect(ordemDaVez([maria, jessica], ana)).toEqual([maria, jessica]);
  });

  it("lista vazia ou ilegível = sem rodízio", () => {
    expect(ordemDaVez([], maria)).toEqual([]);
    expect(listaDoRodizio(null)).toEqual([]);
    expect(listaDoRodizio("x")).toEqual([]);
    expect(listaDoRodizio([maria, maria, "", 3, jessica])).toEqual([maria, jessica]);
  });
});

describe("ordemDoRodizio — leitura que falha (PC-052)", () => {
  const ORG = "org-1";
  const maria = "11111111-1111-4111-8111-111111111111";
  const jessica = "22222222-2222-4222-8222-222222222222";

  function cliente(erroNosMembros: boolean): SupabaseClient {
    const api = (tabela: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        in: () => q,
        neq: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            tabela === "user_organizations" && erroNosMembros
              ? { data: null, error: { message: "falhou" } }
              : { data: [{ user_id: maria }, { user_id: jessica }], error: null },
          ).then(resolve),
      };
      return q;
    };
    return { from: api } as unknown as SupabaseClient;
  }

  it("sem saber quem é da equipe, não há rodízio (vale o responsável padrão)", async () => {
    expect(await ordemDoRodizio(cliente(true), ORG, "tipo", [maria, jessica])).toEqual([]);
  });

  it("com a equipe lida, a ordem começa pela primeira", async () => {
    expect(await ordemDoRodizio(cliente(false), ORG, "tipo", [maria, jessica])).toEqual([maria, jessica]);
  });
});
