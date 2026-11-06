/**
 * A régua da bateria do Leitor: comparar, o efeito do juiz e o placar.
 *
 * SABOTAGEM:
 * - comparar a ficha inteira nos casos da Regra v2 (e não a Situação/Temperatura
 *   pela regra): o caso "campo diferente que não muda o resultado passa" acusa;
 * - trocar o efeito do juiz "com o modelo" por "erra": o caso correspondente acusa;
 * - aprovar sem olhar a Qualidade: o caso dos 3 erros de Qualidade acusa.
 */
import { describe, expect, it } from "vitest";

import {
  aplicarDecisao,
  conferirCaso,
  daFormaCurta,
  juizPara,
  placarDaBateria,
  type CasoDaBateria,
  type ResultadoDoCaso,
} from "./bateria";

const RELOGIO = new Date("2026-11-05T21:40:00-03:00");

function casoRegraV2(curta: Parameters<typeof daFormaCurta>[0], id = "B10"): CasoDaBateria {
  const { ficha, banco } = daFormaCurta(curta, 2026);
  return { id, bloqueia: true, relogio: RELOGIO, gabarito: { tipo: "regra_v2", ficha, banco } };
}

// B10: contrato enviado, o lead falou hoje → Contrato enviado · Quente.
const B10 = { contato: "lead", interesse: "Auxílio-acidente", contou: "sim", requisitos: "atende", negociacao: "contrato_enviado", bola: "lead", fala: "05/11 11:34", palavras: true, risco: false } as const;

describe("conferirCaso — Regra v2 (pela regra fixa)", () => {
  it("a mesma ficha passa, com a Qualidade igual", () => {
    const c = casoRegraV2(B10);
    expect(conferirCaso(c, c.gabarito.ficha as never)).toEqual({ passou: true, qualidadeIgual: true, divergencias: [] });
  });

  it("um campo diferente que não muda Situação nem Temperatura ainda passa", () => {
    const c = casoRegraV2(B10);
    const doModelo = { ...daFormaCurta(B10, 2026).ficha, objecao: "preco" as const };
    expect(conferirCaso(c, doModelo).passou).toBe(true);
  });

  it("o modelo que não viu o contrato erra, e a divergência diz por quê", () => {
    const c = casoRegraV2(B10);
    const doModelo = { ...daFormaCurta(B10, 2026).ficha, negociacao: "nenhuma" as const };
    const r = conferirCaso(c, doModelo);
    expect(r.passou).toBe(false);
    expect(r.divergencias.map((d) => d.campo)).toEqual(["situacao", "negociacao"]);
  });

  it("cliente lido como lead erra (nenhum cliente vira lead)", () => {
    const c = casoRegraV2({ contato: "cliente", interesse: "Auxílio-acidente", risco: false }, "B04");
    const doModelo = { ...daFormaCurta({ contato: "lead", contou: "sim" }, 2026).ficha };
    expect(conferirCaso(c, doModelo).passou).toBe(false);
  });
});

describe("conferirCaso — casos do Gestor (ficha parcial)", () => {
  const base = daFormaCurta({ contato: "lead" }, 2026);
  const parcial = (ficha: object, extra: object = {}): CasoDaBateria => ({
    id: "EQ1",
    bloqueia: true,
    relogio: new Date("2026-11-07T06:00:00-03:00"),
    gabarito: { tipo: "parcial", ficha, banco: base.banco, ...extra },
  });
  const espera = { motivo: "ia_disse_que_equipe_chama", desde: "2026-11-04T08:39-03:00" } as const;

  it("EQ1: a espera com o mesmo motivo e o 'desde' até 15 min de diferença passa", () => {
    const c = parcial({ esperando_a_equipe: espera });
    const ok = { ...base.ficha, esperando_a_equipe: { motivo: espera.motivo, desde: "2026-11-04T08:45", prova: "Assim que a equipe…" } };
    expect(conferirCaso(c, ok).passou).toBe(true);
    const tarde = { ...ok, esperando_a_equipe: { ...ok.esperando_a_equipe, desde: "2026-11-04T09:30" } };
    expect(conferirCaso(c, tarde).passou).toBe(false);
    const outroMotivo = { ...ok, esperando_a_equipe: { ...ok.esperando_a_equipe, motivo: "lead_pediu_pessoa" as const } };
    expect(conferirCaso(c, outroMotivo).passou).toBe(false);
  });

  it("EQ4: o gabarito diz que não há espera — o modelo que inventa uma erra", () => {
    const c = parcial({ contato: "cliente", esperando_a_equipe: null }, { situacao: "Já é cliente" });
    expect(conferirCaso(c, { ...base.ficha, contato: "cliente" }).passou).toBe(true);
    const inventou = { ...base.ficha, contato: "cliente" as const, esperando_a_equipe: { motivo: espera.motivo, desde: "2026-10-29T07:47", prova: "x" } };
    expect(conferirCaso(c, inventou).passou).toBe(false);
  });

  it("CL1: Situação e Temperatura do gabarito também contam", () => {
    const c = parcial(
      { contato: "lead", interesse: "Implante", aguardando: { evento: "avaliação", data: "2026-11-12T10:00-03:00" } },
      { situacao: "Aguardando evento", temperatura: "Agendado" },
    );
    const ok = { ...base.ficha, interesse: "implante", aguardando: { evento: "avaliação com a dentista", data: "2026-11-12T10:00" } };
    expect(conferirCaso(c, ok).passou).toBe(true);
    expect(conferirCaso(c, { ...ok, aguardando: null }).passou).toBe(false);
  });
});

describe("o juiz (PM-027 §9.1)", () => {
  it("o efeito de cada decisão", () => {
    expect(aplicarDecisao("A", "A")).toEqual({ acerto: false, corrigirGabarito: false, revisarGabarito: false });
    expect(aplicarDecisao("B", "A")).toEqual({ acerto: true, corrigirGabarito: true, revisarGabarito: false });
    expect(aplicarDecisao("as_duas_erradas", "B")).toEqual({ acerto: false, corrigirGabarito: false, revisarGabarito: true });
    expect(aplicarDecisao("duvida", "B")).toEqual({ acerto: false, corrigirGabarito: false, revisarGabarito: true });
  });

  it("nunca é o modelo testado", () => {
    expect(juizPara({ model_id: "claude-haiku-5-5" }, null)).toEqual({ provider: "anthropic", model_id: "claude-opus-5-5" });
    expect(juizPara({ model_id: "anthropic/claude-opus-5-5" }, null)).toEqual({ provider: "openai", model_id: "gpt-6.1-sol" });
    expect(juizPara({ model_id: "gpt-6.1-sol" }, { provider: "openai", model_id: "gpt-6.1-sol" })).toEqual({
      provider: "anthropic",
      model_id: "claude-opus-5-5",
    });
    expect(juizPara({ model_id: "claude-haiku-5-5" }, { provider: "google", model_id: "gemini-4-argon" })).toEqual({
      provider: "google",
      model_id: "gemini-4-argon",
    });
  });
});

describe("o placar", () => {
  const r = (bloqueia: boolean, acerto: boolean, regraV2 = true, qualidadeIgual: boolean | null = true): ResultadoDoCaso => ({
    caso: { id: "x", bloqueia, relogio: RELOGIO, gabarito: { tipo: regraV2 ? "regra_v2" : "parcial", ficha: {}, banco: daFormaCurta({ contato: "lead" }, 2026).banco } },
    acerto,
    qualidadeIgual: regraV2 ? qualidadeIgual : null,
  });

  it("aprova com 100% nos que bloqueiam, mesmo errando os que não bloqueiam", () => {
    const p = placarDaBateria([r(true, true), r(true, true), r(false, false, false)]);
    expect(p).toMatchObject({ total: 3, acertos: 2, bloqueantes: 2, bloqueantesAcertos: 2, aprovado: true });
  });

  it("um bloqueante errado reprova", () => {
    expect(placarDaBateria([r(true, true), r(true, false)]).aprovado).toBe(false);
  });

  it("Qualidade: até 2 erros nos casos da Regra v2 aprova; 3 reprova", () => {
    const dois = [r(true, true, true, false), r(true, true, true, false), r(true, true)];
    expect(placarDaBateria(dois).aprovado).toBe(true);
    expect(placarDaBateria([...dois, r(true, true, true, false)]).aprovado).toBe(false);
  });

  it("bateria vazia não aprova ninguém", () => {
    expect(placarDaBateria([]).aprovado).toBe(false);
  });
});
