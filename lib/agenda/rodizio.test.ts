import { describe, expect, it } from "vitest";

import { listaDoRodizio, ordemDaVez } from "./rodizio";

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
