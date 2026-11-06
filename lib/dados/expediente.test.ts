import { describe, expect, it } from "vitest";

import {
  avisoDeHorarioPadrao,
  completouHorasDeExpediente,
  diasUteisEntre,
  expedienteDaOrg,
  instanteLocal,
  jornadaMaisLongaMs,
  msDeExpedienteEntre,
  passouDeDiasUteis,
} from "./expediente";

const H = 60 * 60 * 1000;
const SP = "America/Sao_Paulo";
const padrao = expedienteDaOrg({}, SP);

/** Hora local de São Paulo (UTC−3, sem horário de verão desde 2019). */
const sp = (dia: string, hhmm: string) => new Date(`${dia}T${hhmm}:00-03:00`);

describe("expediente da organização", () => {
  it("sem horário cadastrado: seg–sex, 8h–18h no fuso da organização, e a tela avisa", () => {
    expect(padrao.cadastrado).toBe(false);
    expect(padrao.timezone).toBe(SP);
    expect(padrao.windows).toHaveLength(5);
    expect(avisoDeHorarioPadrao(padrao, (s) => s)).toBe(
      "Horário da equipe não cadastrado: usando seg–sex, 8h–18h",
    );
  });

  it("horário cadastrado vence o padrão e não mostra aviso", () => {
    const e = expedienteDaOrg(
      { horario_da_equipe: { timezone: SP, windows: [{ dow: 1, start: "09:00", end: "12:00" }] } },
      "Asia/Tokyo",
    );
    expect(e.cadastrado).toBe(true);
    expect(e.timezone).toBe(SP);
    expect(avisoDeHorarioPadrao(e, (s) => s)).toBeNull();
  });

  it("fuso inválido da organização cai em São Paulo", () => {
    expect(expedienteDaOrg(null, "America/Lugar_Nenhum").timezone).toBe(SP);
  });
});

describe("1 dia útil = a jornada mais longa da semana", () => {
  it("padrão: 10 h", () => {
    expect(jornadaMaisLongaMs(padrao)).toBe(10 * H);
  });

  it("janelas partidas somam no mesmo dia; vale o dia mais longo", () => {
    const windows = [
      ...[1, 2, 3, 4, 5].flatMap((dow) => [
        { dow, start: "08:00", end: "12:00" },
        { dow, start: "13:00", end: "18:00" },
      ]),
      { dow: 6, start: "09:00", end: "13:00" },
    ];
    expect(jornadaMaisLongaMs({ windows })).toBe(9 * H);
  });
});

describe("horas de expediente entre dois instantes", () => {
  it("dentro do mesmo dia útil: o relógio", () => {
    // 05/11/2026 é quinta-feira.
    expect(msDeExpedienteEntre(sp("2026-11-05", "09:00"), sp("2026-11-05", "11:30"), padrao)).toBe(2.5 * H);
  });

  it("noite e fim de semana não contam: sexta 17h → segunda 9h = 2 h", () => {
    // 06/11/2026 sexta, 09/11/2026 segunda.
    expect(msDeExpedienteEntre(sp("2026-11-06", "17:00"), sp("2026-11-09", "09:00"), padrao)).toBe(2 * H);
  });

  it("feriado nacional de 20/11/2026 (sexta) não conta", () => {
    // quinta 19/11 17h → segunda 23/11 9h: 1 h na quinta + 0 no feriado + 1 h na segunda.
    expect(msDeExpedienteEntre(sp("2026-11-19", "17:00"), sp("2026-11-23", "09:00"), padrao)).toBe(2 * H);
    // Controle: a semana anterior, sem feriado, conta a sexta inteira (10 h).
    expect(msDeExpedienteEntre(sp("2026-11-12", "17:00"), sp("2026-11-16", "09:00"), padrao)).toBe(12 * H);
  });

  it("antes do expediente e depois dele não contam", () => {
    expect(msDeExpedienteEntre(sp("2026-11-05", "05:00"), sp("2026-11-05", "08:30"), padrao)).toBe(0.5 * H);
    expect(msDeExpedienteEntre(sp("2026-11-05", "17:30"), sp("2026-11-05", "23:00"), padrao)).toBe(0.5 * H);
  });

  it("fim antes do início dá zero", () => {
    expect(msDeExpedienteEntre(sp("2026-11-05", "11:00"), sp("2026-11-05", "09:00"), padrao)).toBe(0);
  });

  it("fuso de outra organização (Tóquio, UTC+9)", () => {
    const toquio = expedienteDaOrg({}, "Asia/Tokyo");
    expect(instanteLocal("2026-11-05", "08:00", "Asia/Tokyo")).toBe(Date.parse("2026-11-04T23:00:00Z"));
    // 09h → 12h em Tóquio = 3 h.
    expect(
      msDeExpedienteEntre(new Date("2026-11-05T00:00:00Z"), new Date("2026-11-05T03:00:00Z"), toquio),
    ).toBe(3 * H);
  });

  it("horário de verão: o dia de 23 h nos EUA conta as 10 h da janela", () => {
    // 08/03/2026, domingo: troca de horário em Nova York. Segunda 09/03, janela 8h–18h.
    const ny = expedienteDaOrg({}, "America/New_York");
    const inicio = new Date(instanteLocal("2026-03-07", "00:00", "America/New_York"));
    const fim = new Date(instanteLocal("2026-03-10", "00:00", "America/New_York"));
    // sábado e domingo nada; segunda inteira = 10 h.
    expect(msDeExpedienteEntre(inicio, fim, ny)).toBe(10 * H);
  });
});

describe("prazos em dias úteis e horas", () => {
  it("2 dias úteis = 20 h de expediente; exatamente 2 ainda não passou", () => {
    const desde = sp("2026-11-03", "08:00"); // terça
    expect(diasUteisEntre(desde, sp("2026-11-04", "18:00"), padrao)).toBe(2);
    expect(passouDeDiasUteis(desde, sp("2026-11-04", "18:00"), 2, padrao)).toBe(false);
    expect(passouDeDiasUteis(desde, sp("2026-11-05", "08:01"), 2, padrao)).toBe(true);
  });

  it("3 dias úteis atravessando o feriado de 20/11", () => {
    const desde = sp("2026-11-18", "18:00"); // quarta, fim do expediente
    // quinta (10 h) + sexta feriado (0) + segunda (10 h) = 2 dias; terça 24/11 completa o 3º.
    expect(passouDeDiasUteis(desde, sp("2026-11-24", "18:00"), 3, padrao)).toBe(false);
    expect(passouDeDiasUteis(desde, sp("2026-11-25", "08:30"), 3, padrao)).toBe(true);
  });

  it("1 hora de expediente: o lead que escreve às 17h30 de sexta completa a hora segunda 8h30", () => {
    const desde = sp("2026-11-06", "17:30");
    expect(completouHorasDeExpediente(desde, sp("2026-11-06", "23:59"), 1, padrao)).toBe(false);
    expect(completouHorasDeExpediente(desde, sp("2026-11-09", "08:29"), 1, padrao)).toBe(false);
    expect(completouHorasDeExpediente(desde, sp("2026-11-09", "08:30"), 1, padrao)).toBe(true);
  });
});
