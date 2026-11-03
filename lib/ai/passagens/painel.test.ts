import { describe, expect, it } from "vitest";

import { ficouSemResposta, montarPainelDePassagens, type LinhaDaPassagem } from "./painel";

/**
 * PC-014 — o painel de passagens da Central: os quatro números por dia (no fuso
 * da organização) e a lista de quem passou para quem.
 */
const AGORA = new Date("2026-11-03T18:00:00Z"); // 15h em São Paulo
const nomes = new Map([
  ["rec", "Recepção"],
  ["raq", "Raquel"],
  ["neg", "Negado"],
]);

function linha(over: Partial<LinhaDaPassagem>): LinhaDaPassagem {
  return {
    de_agente_id: "rec",
    para_agente_id: "raq",
    origem: "ferramenta",
    desfecho: "passou",
    created_at: "2026-11-03T13:00:00Z",
    destino_respondeu_em: "2026-11-03T13:00:20Z",
    ...over,
  };
}

const opts = { agora: AGORA, fuso: "America/Sao_Paulo", dias: 1, nomes, equipe: "Equipe", removido: "Agente removido" };

describe("montarPainelDePassagens", () => {
  it("conta passagens, sem resposta em 2 min, laços e roteador × ferramenta do dia", () => {
    const p = montarPainelDePassagens(
      [
        linha({}),
        linha({ destino_respondeu_em: null }), // sem resposta
        linha({ destino_respondeu_em: "2026-11-03T13:03:00Z" }), // respondeu depois de 2 min
        linha({ origem: "roteador", de_agente_id: "raq", para_agente_id: "neg" }),
        linha({ desfecho: "laco" }),
        linha({ origem: "equipe", de_agente_id: null, destino_respondeu_em: null }), // equipe não conta como sem resposta
        linha({ created_at: "2026-11-03T02:00:00Z" }), // 23h do dia 2 em São Paulo: fora de "hoje"
      ],
      opts,
    );
    expect(p.totais).toEqual({
      passagens: 5,
      semRespostaEm2Min: 2,
      lacos: 1,
      peloRoteador: 1,
      pelaFerramenta: 3,
      pelaEquipe: 1,
    });
    expect(p.pares[0]).toEqual({ de: "Recepção", para: "Raquel", total: 3 });
    expect(p.pares.map((x) => `${x.de}→${x.para}`)).toContain("Equipe→Raquel");
  });

  it("passagem recente ainda não conta como sem resposta (não deu tempo)", () => {
    expect(
      ficouSemResposta(linha({ created_at: "2026-11-03T17:59:30Z", destino_respondeu_em: null }), AGORA.getTime()),
    ).toBe(false);
  });

  it("sete dias: um resumo por dia, do mais antigo ao de hoje", () => {
    const p = montarPainelDePassagens([linha({ created_at: "2026-10-30T15:00:00Z" })], { ...opts, dias: 7 });
    expect(p.dias).toHaveLength(7);
    expect(p.dias[6]!.dia).toBe("2026-11-03");
    expect(p.dias.find((d) => d.dia === "2026-10-30")!.passagens).toBe(1);
  });
});
