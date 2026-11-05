import { describe, expect, it } from "vitest";

import {
  baseDaChance,
  calcularQualidade,
  nivelDaNota,
  PESOS_DA_NOTA,
  sinaisDaLinha,
  situacoesDoLead,
  temperaturaDoLead,
  type SinaisDoLead,
} from "./qualidade";

const AGORA = new Date("2026-11-05T13:00:00.000Z");
const horasAtras = (h: number) => new Date(AGORA.getTime() - h * 3_600_000).toISOString();

/** Um lead aberto sem nenhum sinal: entrou agora, ninguém escreveu. */
function lead(extra: Partial<SinaisDoLead> = {}): SinaisDoLead {
  return {
    status: "open",
    criadoEm: horasAtras(1),
    etapaDesde: horasAtras(1),
    chanceDaEtapa: 0,
    prazoDaEtapaHoras: null,
    chanceDaIa: null,
    faixaDaIa: null,
    mensagensDaEmpresa: 0,
    respostas: 0,
    ultimaRespostaEm: null,
    duplicadoDeDesqualificado: false,
    interesse: null,
    ...extra,
  };
}

describe("nível pela nota — as bordas da ordem (24/25, 44/45, 64/65)", () => {
  it.each([
    [0, "D"],
    [24, "D"],
    [25, "C"],
    [44, "C"],
    [45, "B"],
    [64, "B"],
    [65, "A"],
    [100, "A"],
  ] as const)("nota %i é nível %s", (nota, nivel) => {
    expect(nivelDaNota(nota)).toBe(nivel);
  });

  it("as bordas saem da nota calculada, não só da função de nível", () => {
    // 60% × 0,4 = 24 → D; +1 ponto faria C. Com a etapa a 62,5% (25) → C.
    expect(calcularQualidade(lead({ chanceDaIa: 60 }), AGORA)).toMatchObject({ nota: 24, nivel: "D" });
    expect(calcularQualidade(lead({ chanceDaIa: 62.5 }), AGORA)).toMatchObject({ nota: 25, nivel: "C" });
    // Sem a base: interesse (15) + respondeu (10) + 72 h (8) + IA morno (5) = 38.
    // A chance da IA decide a borda: 15% → 6 (44), 17,5% → 7 (45), 65% → 26 (64), 67,5% → 27 (65).
    const c44 = lead({ interesse: "BPC/LOAS", respostas: 1, mensagensDaEmpresa: 2, ultimaRespostaEm: horasAtras(30), faixaDaIa: "morno" });
    expect(calcularQualidade({ ...c44, chanceDaIa: 15 }, AGORA)).toMatchObject({ nota: 44, nivel: "C" });
    expect(calcularQualidade({ ...c44, chanceDaIa: 17.5 }, AGORA)).toMatchObject({ nota: 45, nivel: "B" });
    expect(calcularQualidade({ ...c44, chanceDaIa: 65 }, AGORA)).toMatchObject({ nota: 64, nivel: "B" });
    expect(calcularQualidade({ ...c44, chanceDaIa: 67.5 }, AGORA)).toMatchObject({ nota: 65, nivel: "A" });
  });
});

describe("a base: round(chance × 0,4) como o Postgres arredonda", () => {
  it.each([
    [70, 28],
    [61.25, 25], // 24,5 → 25 (metade para longe do zero)
    [1.25, 1], // 0,5 → 1
    [3.75, 2], // 1,5 → 2
    [0, 0],
    [100, 40],
  ])("chance %f dá %i", (chance, base) => {
    expect(baseDaChance(chance)).toBe(base);
  });
});

describe("a Joana da prévia: 86 = 28 + 15 + 15 + 20 + 8", () => {
  const joana = lead({
    chanceDaIa: 70,
    chanceDaEtapa: 70,
    interesse: "Auxílio-acidente",
    mensagensDaEmpresa: 6,
    respostas: 4,
    ultimaRespostaEm: horasAtras(30),
  });
  it("nota, nível e parcelas na ordem da prévia", () => {
    const q = calcularQualidade(joana, AGORA);
    expect(q.nota).toBe(86);
    expect(q.nivel).toBe("A");
    expect(q.parcelas.map((p) => [p.chave, p.pontos])).toEqual([
      ["chance", 28],
      ["etapa", 15],
      ["interesse", 15],
      ["respondeu_engajado", 20],
      ["janela_longa", 8],
    ]);
    expect(q.parcelas[0]).toMatchObject({ chance: 70, origemDaChance: "ia" });
    expect(q.temperatura).toBe("quente");
    expect(q.situacoes).toEqual(["esperando_fechamento"]);
  });
});

describe("cada soma e cada desconto da ordem", () => {
  it("sem chance da IA, vale a chance da etapa", () => {
    const q = calcularQualidade(lead({ chanceDaEtapa: 30 }), AGORA);
    expect(q.parcelas[0]).toMatchObject({ chave: "chance", pontos: 12, chance: 30, origemDaChance: "etapa" });
  });
  it("+15 só com etapa de 50% ou mais (49 não, 50 sim)", () => {
    expect(calcularQualidade(lead({ chanceDaEtapa: 49 }), AGORA).parcelas.map((p) => p.chave)).not.toContain("etapa");
    expect(calcularQualidade(lead({ chanceDaEtapa: 50 }), AGORA).parcelas.map((p) => p.chave)).toContain("etapa");
  });
  it("+10 respondeu 1 ou 2 vezes, +20 com 3 ou mais (nunca os dois)", () => {
    const chaves = (n: number) =>
      calcularQualidade(lead({ respostas: n, mensagensDaEmpresa: 1, ultimaRespostaEm: horasAtras(100) }), AGORA).parcelas;
    expect(chaves(2).find((p) => p.chave === "respondeu")?.pontos).toBe(10);
    expect(chaves(2).some((p) => p.chave === "respondeu_engajado")).toBe(false);
    expect(chaves(3).find((p) => p.chave === "respondeu_engajado")?.pontos).toBe(20);
    expect(chaves(3).some((p) => p.chave === "respondeu")).toBe(false);
  });
  it("+15 em menos de 24 h, +8 em menos de 72 h, nada depois (vale a maior)", () => {
    const janela = (h: number) =>
      calcularQualidade(lead({ respostas: 1, mensagensDaEmpresa: 1, ultimaRespostaEm: horasAtras(h) }), AGORA).parcelas
        .filter((p) => p.chave.startsWith("janela"))
        .map((p) => p.pontos);
    expect(janela(23.9)).toEqual([15]);
    expect(janela(24)).toEqual([8]);
    expect(janela(71.9)).toEqual([8]);
    expect(janela(72)).toEqual([]);
  });
  it("a janela só conta com resposta depois da empresa", () => {
    const q = calcularQualidade(lead({ respostas: 0, mensagensDaEmpresa: 0, ultimaRespostaEm: horasAtras(2) }), AGORA);
    expect(q.parcelas.some((p) => p.chave.startsWith("janela"))).toBe(false);
  });
  it("+5 IA morno, +10 IA quente", () => {
    expect(calcularQualidade(lead({ faixaDaIa: "morno" }), AGORA).parcelas).toContainEqual({ chave: "ia_morno", pontos: 5 });
    expect(calcularQualidade(lead({ faixaDaIa: "quente" }), AGORA).parcelas).toContainEqual({ chave: "ia_quente", pontos: 10 });
    expect(calcularQualidade(lead({ faixaDaIa: "frio" }), AGORA).parcelas).toEqual([]);
  });
  it("−10 nunca respondeu e entrou há mais de 48 h (48 exatas ainda não)", () => {
    expect(calcularQualidade(lead({ criadoEm: horasAtras(48) }), AGORA).parcelas.some((p) => p.chave === "nunca_respondeu")).toBe(false);
    const q = calcularQualidade(lead({ criadoEm: horasAtras(49), chanceDaEtapa: 50 }), AGORA);
    expect(q.parcelas).toContainEqual({ chave: "nunca_respondeu", pontos: -10 });
  });
  it("−10 com mais de 7 dias sem responder", () => {
    const q = calcularQualidade(
      lead({ respostas: 3, mensagensDaEmpresa: 4, ultimaRespostaEm: horasAtras(7 * 24 + 1), criadoEm: horasAtras(300) }),
      AGORA,
    );
    expect(q.parcelas).toContainEqual({ chave: "sem_responder", pontos: -10 });
    expect(q.nota).toBe(20 - 10);
  });
});

describe("limites e estados fixos", () => {
  it("a nota não fica negativa, e o ajuste aparece no porquê", () => {
    const q = calcularQualidade(lead({ criadoEm: horasAtras(500), ultimaRespostaEm: horasAtras(400) }), AGORA);
    expect(q.nota).toBe(0);
    expect(q.nivel).toBe("D");
    expect(q.parcelas.map((p) => [p.chave, p.pontos])).toEqual([
      ["nunca_respondeu", -10],
      ["sem_responder", -10],
      ["limite", 20],
    ]);
    expect(q.parcelas.reduce((a, p) => a + p.pontos, 0)).toBe(q.nota);
  });
  it("a nota não passa de 100", () => {
    const q = calcularQualidade(
      lead({ chanceDaIa: 100, chanceDaEtapa: 90, interesse: "X", respostas: 5, mensagensDaEmpresa: 5, ultimaRespostaEm: horasAtras(1), faixaDaIa: "quente" }),
      AGORA,
    );
    // 40 + 15 + 15 + 20 + 15 + 10 = 115
    expect(q.nota).toBe(100);
    expect(q.parcelas.at(-1)).toEqual({ chave: "limite", pontos: -15 });
  });
  it("ganho = 100, sem nível, com o porquê", () => {
    const q = calcularQualidade(lead({ status: "won", chanceDaEtapa: 100 }), AGORA);
    expect(q).toMatchObject({ nota: 100, nivel: null, estado: "ganho", temperatura: null, situacoes: [] });
    expect(q.parcelas).toEqual([{ chave: "ganho", pontos: 100 }]);
  });
  it("perdido = 0, sem nível", () => {
    const q = calcularQualidade(lead({ status: "lost", chanceDaIa: 90 }), AGORA);
    expect(q).toMatchObject({ nota: 0, nivel: null, estado: "perdido", temperatura: null });
    expect(q.parcelas).toEqual([{ chave: "perdido", pontos: 0 }]);
  });
  it("card duplicado de contato desqualificado = 0, nível D, frio", () => {
    const q = calcularQualidade(lead({ duplicadoDeDesqualificado: true, chanceDaEtapa: 80, respostas: 5 }), AGORA);
    expect(q).toMatchObject({ nota: 0, nivel: "D", estado: "duplicado", temperatura: "frio" });
    expect(q.parcelas).toEqual([{ chave: "duplicado", pontos: 0 }]);
  });
  it("as parcelas sempre somam a nota do lead aberto", () => {
    for (let i = 0; i < 200; i++) {
      const s = lead({
        chanceDaIa: i % 3 === 0 ? null : (i * 7) % 101,
        chanceDaEtapa: (i * 13) % 101,
        interesse: i % 2 ? "X" : null,
        respostas: i % 5,
        mensagensDaEmpresa: i % 4,
        ultimaRespostaEm: i % 6 ? horasAtras((i * 11) % 300) : null,
        criadoEm: horasAtras((i * 17) % 400),
        faixaDaIa: (["quente", "morno", "frio", null] as const)[i % 4]!,
      });
      const q = calcularQualidade(s, AGORA);
      expect(q.parcelas.reduce((a, p) => a + p.pontos, 0)).toBe(q.nota);
      expect(q.nota).toBeGreaterThanOrEqual(0);
      expect(q.nota).toBeLessThanOrEqual(100);
    }
  });
});

describe("temperatura (regra 5)", () => {
  it.each([
    [{ chanceDaEtapa: 50 }, "quente"],
    [{ faixaDaIa: "quente" as const }, "quente"],
    [{ faixaDaIa: "morno" as const }, "morno"],
    [{ respostas: 1, ultimaRespostaEm: horasAtras(71) }, "morno"],
    [{ respostas: 1, ultimaRespostaEm: horasAtras(73) }, "frio"],
    [{ respostas: 0, ultimaRespostaEm: horasAtras(1) }, "frio"],
    [{}, "frio"],
    [{ duplicadoDeDesqualificado: true, chanceDaEtapa: 90 }, "frio"],
  ])("%o → %s", (extra, temp) => {
    expect(temperaturaDoLead(lead(extra), AGORA)).toBe(temp);
  });
});

describe("situações do filtro", () => {
  it("sem resposta quando a empresa nunca escreveu", () => {
    expect(situacoesDoLead(lead({ chanceDaEtapa: 70 }), AGORA)).toEqual(["sem_resposta"]);
  });
  it("esperando fechamento E parado além do prazo da etapa", () => {
    const s = lead({ chanceDaEtapa: 70, mensagensDaEmpresa: 2, prazoDaEtapaHoras: 24, etapaDesde: horasAtras(25) });
    expect(situacoesDoLead(s, AGORA)).toEqual(["esperando_fechamento", "parado"]);
  });
  it("parado só em etapa com chance e com prazo", () => {
    expect(situacoesDoLead(lead({ mensagensDaEmpresa: 1, prazoDaEtapaHoras: 24, etapaDesde: horasAtras(100) }), AGORA)).toEqual([]);
    expect(situacoesDoLead(lead({ mensagensDaEmpresa: 1, chanceDaEtapa: 20, etapaDesde: horasAtras(100) }), AGORA)).toEqual([]);
    expect(situacoesDoLead(lead({ mensagensDaEmpresa: 1, chanceDaEtapa: 20, prazoDaEtapaHoras: 24, etapaDesde: horasAtras(23) }), AGORA)).toEqual([]);
  });
  it("lead fechado não tem situação", () => {
    expect(situacoesDoLead(lead({ status: "won" }), AGORA)).toEqual([]);
  });
});

describe("a linha do banco vira os fatos", () => {
  it("numeric em texto, nulos e vocabulário fora da lista", () => {
    expect(
      sinaisDaLinha({
        lead_id: "x",
        status: "open",
        criado_em: "2026-11-01T00:00:00Z",
        etapa_desde: null,
        chance_da_etapa: null,
        prazo_da_etapa_horas: "48.5",
        chance_da_ia: "70.00",
        faixa_da_ia: "fervendo",
        mensagens_da_empresa: "3",
        respostas: 2,
        ultima_resposta_em: null,
        duplicado_de_desqualificado: null,
        interesse: "  ",
      }),
    ).toEqual({
      status: "open",
      criadoEm: "2026-11-01T00:00:00Z",
      etapaDesde: null,
      chanceDaEtapa: 0,
      prazoDaEtapaHoras: 48.5,
      chanceDaIa: 70,
      faixaDaIa: null,
      mensagensDaEmpresa: 3,
      respostas: 2,
      ultimaRespostaEm: null,
      duplicadoDeDesqualificado: false,
      interesse: null,
    });
  });
  it("os pesos da ordem estão na constante", () => {
    expect(PESOS_DA_NOTA).toMatchObject({
      fatorDaChance: 0.4,
      etapaComChance: 15,
      interesseIdentificado: 15,
      respondeu: 10,
      respondeuEngajado: 20,
      respondeuNaJanelaCurta: 15,
      respondeuNaJanelaLonga: 8,
      iaMorno: 5,
      iaQuente: 10,
      nuncaRespondeu: -10,
      semResponder: -10,
    });
  });
});
