/**
 * Quem o Leitor lê — os casos de gatilho do Gestor (GT1–GT4, LV1) e as bordas.
 *
 * SABOTAGEM:
 * - tirar o `ligadoEm` do marco: o GT4 (ligar o Leitor lê a base) acusa;
 * - trocar `ultimaEntrada` por `ultimaSaida` na conversa ativa: o GT1 acusa;
 * - deixar `pode_voltar` cair no caminho comum: "lead perdido com follow-up" acusa.
 */
import { describe, expect, it } from "vitest";

import { decidirLeitura, type CandidatoAoLeitor } from "./selecao";

// Clínica de teste dos casos inventados: seg–sex 9h–18h e sábado 8h–12h.
const CLINICA = {
  timezone: "America/Sao_Paulo",
  windows: [...[1, 2, 3, 4, 5].map((dow) => ({ dow, start: "09:00", end: "18:00" })), { dow: 6, start: "08:00", end: "12:00" }],
};
const LIGADO_EM = new Date("2026-11-02T06:00-03:00"); // segunda
const ctx = { ligadoEm: LIGADO_EM, expediente: CLINICA };
const d = (s: string) => new Date(s);

function candidato(
  p: Partial<Omit<CandidatoAoLeitor, "conversa">> & { conversa: Partial<CandidatoAoLeitor["conversa"]> },
): CandidatoAoLeitor {
  return {
    posicao: p.posicao ?? "com_potencial",
    leituraAnterior: p.leituraAnterior === undefined ? { mensagensAte: d("2026-11-02T08:00-03:00") } : p.leituraAnterior,
    conversa: { criadaEm: d("2026-10-20T10:00-03:00"), ultimaEntrada: null, ultimaSaida: null, ...p.conversa },
  };
}

describe("decidirLeitura — casos do Gestor", () => {
  it("GT1: follow-up para lead calado há 4 dias úteis não dispara", () => {
    // O lead falou na segunda 10h; a IA cobrou na sexta 11h (4 dias úteis depois).
    const c = candidato({
      leituraAnterior: { mensagensAte: d("2026-11-02T10:00-03:00") },
      conversa: { ultimaEntrada: d("2026-11-02T10:00-03:00"), ultimaSaida: d("2026-11-06T11:00-03:00") },
    });
    expect(decidirLeitura(c, ctx)).toEqual({ ler: false, motivo: "conversa_parada" });
  });

  it("GT2: equipe manda o contrato para lead que falou ontem — dispara", () => {
    const c = candidato({
      leituraAnterior: { mensagensAte: d("2026-11-04T15:00-03:00") },
      conversa: { ultimaEntrada: d("2026-11-04T15:00-03:00"), ultimaSaida: d("2026-11-05T10:00-03:00") },
    });
    expect(decidirLeitura(c, ctx)).toEqual({ ler: true, gatilho: "mensagem_da_equipe" });
  });

  it("GT3: mudança de etapa sozinha (nenhuma mensagem nova) não dispara", () => {
    const c = candidato({
      leituraAnterior: { mensagensAte: d("2026-11-04T15:00-03:00") },
      conversa: { ultimaEntrada: d("2026-11-04T15:00-03:00"), ultimaSaida: d("2026-11-04T14:00-03:00") },
    });
    expect(decidirLeitura(c, ctx)).toEqual({ ler: false, motivo: "sem_novidade" });
  });

  it("GT4: ligar o Leitor não lê a base — 500 leads parados, zero leituras", () => {
    let lidos = 0;
    for (let i = 0; i < 500; i += 1) {
      const c = candidato({
        leituraAnterior: null,
        conversa: {
          criadaEm: d("2026-09-01T10:00-03:00"),
          ultimaEntrada: d("2026-10-15T10:00-03:00"),
          ultimaSaida: d("2026-10-16T10:00-03:00"),
        },
      });
      if (decidirLeitura(c, ctx).ler) lidos += 1;
    }
    expect(lidos).toBe(0);
  });

  it("LV1: lead desqualificado que continua escrevendo é lido como 'lead que voltou'", () => {
    const c = candidato({
      posicao: "pode_voltar",
      leituraAnterior: null,
      conversa: { ultimaEntrada: d("2026-11-04T13:27-03:00"), ultimaSaida: d("2026-11-04T14:11-03:00") },
    });
    expect(decidirLeitura(c, ctx)).toEqual({ ler: true, gatilho: "lead_voltou" });
  });
});

describe("decidirLeitura — bordas", () => {
  it("chat novo depois de ligar o Leitor: lido como chat novo", () => {
    const c = candidato({
      leituraAnterior: null,
      conversa: { criadaEm: d("2026-11-03T09:00-03:00"), ultimaEntrada: d("2026-11-03T09:00-03:00") },
    });
    expect(decidirLeitura(c, ctx)).toEqual({ ler: true, gatilho: "chat_novo" });
  });

  it("lead já lido que escreveu de novo: mensagem do lead", () => {
    const c = candidato({ conversa: { ultimaEntrada: d("2026-11-03T09:00-03:00") } });
    expect(decidirLeitura(c, ctx)).toEqual({ ler: true, gatilho: "mensagem_do_lead" });
  });

  it("a mensagem que a leitura anterior já viu não dispara de novo", () => {
    const c = candidato({
      leituraAnterior: { mensagensAte: d("2026-11-03T09:00-03:00") },
      conversa: { ultimaEntrada: d("2026-11-03T09:00-03:00") },
    });
    expect(decidirLeitura(c, ctx).ler).toBe(false);
  });

  it("lead perdido sem mensagem nova do lead (só follow-up) não é lido", () => {
    const c = candidato({
      posicao: "pode_voltar",
      conversa: { ultimaEntrada: d("2026-10-30T09:00-03:00"), ultimaSaida: d("2026-11-03T09:00-03:00") },
    });
    expect(decidirLeitura(c, ctx)).toEqual({ ler: false, motivo: "nao_voltou" });
  });

  it("fora do alcance (funil não lido, ganho, arquivado) nunca é lido", () => {
    const c = candidato({ posicao: "fora", conversa: { ultimaEntrada: d("2026-11-03T09:00-03:00") } });
    expect(decidirLeitura(c, ctx)).toEqual({ ler: false, motivo: "fora_do_alcance" });
  });

  it("saída nova para contato que nunca escreveu não dispara (não há conversa ativa)", () => {
    const c = candidato({ leituraAnterior: null, conversa: { ultimaSaida: d("2026-11-03T09:00-03:00") } });
    expect(decidirLeitura(c, ctx)).toEqual({ ler: false, motivo: "conversa_parada" });
  });

  it("borda dos 3 dias úteis: exatamente 3 jornadas ainda é conversa ativa", () => {
    // Jornada mais longa = 9 h. De segunda 9h a quarta 18h = 3 × 9 h.
    const c = candidato({
      leituraAnterior: { mensagensAte: d("2026-11-02T09:00-03:00") },
      conversa: { ultimaEntrada: d("2026-11-02T09:00-03:00"), ultimaSaida: d("2026-11-04T18:00-03:00") },
    });
    expect(decidirLeitura(c, ctx)).toEqual({ ler: true, gatilho: "mensagem_da_equipe" });
  });
});
