/**
 * "Esperando a equipe" — os casos do Gestor (EQ1–EQ8 e CL3) na regra pura.
 *
 * SABOTAGEM:
 * - deixar a resposta da IA fechar a espera: o EQ7 acusa;
 * - não contar o celular como pessoa: o EQ4 acusa;
 * - contar o feriado como dia útil: o CL3 acusa;
 * - começar a espera da passagem manual na própria passagem: o EQ6 acusa.
 */
import { describe, expect, it } from "vitest";

import { textosAutomaticos } from "@/lib/messaging/textos-automaticos";

import { avaliarEspera, marcarRespostasAutomaticas, type FalaDaConversa, type FontesDaEspera } from "./esperando-a-equipe";

const BORBORA = { timezone: "America/Sao_Paulo", windows: [1, 2, 3, 4, 5].map((dow) => ({ dow, start: "08:00", end: "17:00" })) };
const CLINICA = {
  timezone: "America/Sao_Paulo",
  windows: [...[1, 2, 3, 4, 5].map((dow) => ({ dow, start: "09:00", end: "18:00" })), { dow: 6, start: "08:00", end: "12:00" }],
};
const d = (s: string) => new Date(s);
const nada: FontesDaEspera = { ficha: null, passagem: null, casoAberto: null, etapaSoHumano: null };
const fala = (direction: "inbound" | "outbound", sent_via: string, em: string, extra: Partial<FalaDaConversa> = {}): FalaDaConversa => ({
  direction,
  sent_via,
  status: direction === "inbound" ? "received" : "delivered",
  created_at: d(em).toISOString(),
  ...extra,
});

describe("Esperando a equipe — casos do Gestor", () => {
  it("EQ1: a IA prometeu a equipe em 04/11 08:39 — fora do painel em 06/11 06:00, dentro em 07/11 06:00", () => {
    const f = { ...nada, ficha: { motivo: "ia_disse_que_equipe_chama" as const, desde: d("2026-11-04T08:39-03:00") } };
    const falas = [fala("outbound", "ai", "2026-11-04T08:39-03:00")];
    const em06 = avaliarEspera(f, falas, d("2026-11-06T06:00-03:00"), BORBORA);
    const em07 = avaliarEspera(f, falas, d("2026-11-07T06:00-03:00"), BORBORA);
    expect(em06).toMatchObject({ esperando: true, noPainel: false, quemFalouPorUltimo: "ia" });
    expect(em07).toMatchObject({ esperando: true, noPainel: true, motivo: "ia_disse_que_equipe_chama" });
    if (em06.esperando) expect(em06.diasUteis).toBeCloseTo(17.35 / 9, 2); // 8h21 + 9h
  });

  it("EQ2 e EQ3: o fim de semana não conta", () => {
    const eq2 = { ...nada, ficha: { motivo: "ia_disse_que_equipe_chama" as const, desde: d("2026-11-05T16:45-03:00") } };
    expect(avaliarEspera(eq2, [], d("2026-11-09T06:00-03:00"), BORBORA)).toMatchObject({ noPainel: false });
    expect(avaliarEspera(eq2, [], d("2026-11-10T06:00-03:00"), BORBORA)).toMatchObject({ noPainel: true });
    const eq3 = { ...nada, ficha: { motivo: "ia_disse_que_equipe_chama" as const, desde: d("2026-11-06T08:20-03:00") } };
    expect(avaliarEspera(eq3, [], d("2026-11-10T06:00-03:00"), BORBORA)).toMatchObject({ noPainel: false });
    expect(avaliarEspera(eq3, [], d("2026-11-11T06:00-03:00"), BORBORA)).toMatchObject({ noPainel: true });
  });

  it("EQ4: a pessoa respondeu pelo celular depois da promessa da IA — nunca entra", () => {
    const f = { ...nada, passagem: { em: d("2026-10-29T07:47-03:00"), manualPeloCanal: false } };
    const falas = [fala("outbound", "ai", "2026-10-29T07:47-03:00"), fala("outbound", "external_device", "2026-10-29T08:59-03:00")];
    expect(avaliarEspera(f, falas, d("2026-11-06T06:00-03:00"), BORBORA)).toEqual({ esperando: false });
  });

  it("EQ5: o lead mandou 'Ok' e a pessoa respondeu — fora", () => {
    const f = { ...nada, passagem: { em: d("2026-10-29T13:21-03:00"), manualPeloCanal: false } };
    const falas = [
      fala("outbound", "ai", "2026-10-29T13:21-03:00"),
      fala("outbound", "external_device", "2026-10-30T10:00-03:00"),
      fala("inbound", "external_device", "2026-10-30T10:03-03:00"),
      fala("outbound", "external_device", "2026-10-30T10:04-03:00"),
    ];
    expect(avaliarEspera(f, falas, d("2026-11-06T06:00-03:00"), BORBORA)).toEqual({ esperando: false });
  });

  it("EQ6: passagem manual, depois o áudio do lead sem resposta de pessoa — desde o áudio", () => {
    const f = { ...nada, passagem: { em: d("2026-10-28T10:05-03:00"), manualPeloCanal: true } };
    const falas = [
      fala("outbound", "external_device", "2026-10-28T10:04-03:00"),
      fala("outbound", "ai", "2026-10-28T11:27-03:00"),
      fala("inbound", "external_device", "2026-10-28T11:51-03:00"),
    ];
    const r = avaliarEspera(f, falas, d("2026-11-06T06:00-03:00"), BORBORA);
    expect(r).toMatchObject({ esperando: true, noPainel: true, quemFalouPorUltimo: "lead" });
    if (r.esperando) expect(r.desde.toISOString()).toBe(d("2026-10-28T11:51-03:00").toISOString());
  });

  it("EQ7: o lead mandou áudio e só a IA respondeu — continua no painel (resposta da IA não tira)", () => {
    const f = { ...nada, passagem: { em: d("2026-10-28T10:04-03:00"), manualPeloCanal: true } };
    const falas = [fala("inbound", "external_device", "2026-10-28T11:26-03:00"), fala("outbound", "ai", "2026-10-28T11:28-03:00")];
    const r = avaliarEspera(f, falas, d("2026-11-06T06:00-03:00"), BORBORA);
    expect(r).toMatchObject({ esperando: true, noPainel: true, quemFalouPorUltimo: "ia" });
    if (r.esperando) expect(r.desde.toISOString()).toBe(d("2026-10-28T11:26-03:00").toISOString());
  });

  it("EQ8: a pessoa respondeu ao lead do anúncio e a vez é do lead — fora", () => {
    const falas = [fala("inbound", "external_device", "2026-10-27T10:22-03:00"), fala("outbound", "external_device", "2026-10-28T09:49-03:00")];
    expect(avaliarEspera(nada, falas, d("2026-11-06T06:00-03:00"), BORBORA)).toEqual({ esperando: false });
  });

  it("CL3: o feriado de 20/11 não conta — fora em 24/11, dentro em 25/11", () => {
    const f = { ...nada, ficha: { motivo: "lead_pediu_pessoa" as const, desde: d("2026-11-19T15:00-03:00") } };
    const falas = [fala("inbound", "external_device", "2026-11-19T15:00-03:00"), fala("outbound", "ai", "2026-11-19T15:01-03:00")];
    expect(avaliarEspera(f, falas, d("2026-11-24T06:00-03:00"), CLINICA)).toMatchObject({ esperando: true, noPainel: false });
    expect(avaliarEspera(f, falas, d("2026-11-25T06:00-03:00"), CLINICA)).toMatchObject({ esperando: true, noPainel: true });
  });
});

describe("Esperando a equipe — bordas", () => {
  it("o 'desde' é o mais antigo entre as fontes abertas", () => {
    const f: FontesDaEspera = {
      ficha: { motivo: "lead_pediu_pessoa", desde: d("2026-11-03T10:00-03:00") },
      passagem: null,
      casoAberto: { desde: d("2026-11-02T10:00-03:00") },
      etapaSoHumano: { desde: d("2026-11-04T10:00-03:00") },
    };
    const r = avaliarEspera(f, [], d("2026-11-06T06:00-03:00"), BORBORA);
    expect(r).toMatchObject({ esperando: true, motivo: "caso_humano_aberto" });
  });

  it("resposta automática do WhatsApp Business e envio que falhou não fecham a espera", () => {
    const f = { ...nada, etapaSoHumano: { desde: d("2026-11-02T10:00-03:00") } };
    const falas = [
      fala("outbound", "external_device", "2026-11-02T10:00:30-03:00", { automatica: true }),
      fala("outbound", "user", "2026-11-03T10:00-03:00", { status: "failed" }),
    ];
    expect(avaliarEspera(f, falas, d("2026-11-06T06:00-03:00"), BORBORA)).toMatchObject({ esperando: true });
  });

  it("lead esperando há uma semana continua no painel — e Finados (02/11) não conta", () => {
    const f = { ...nada, ficha: { motivo: "equipe_prometeu_retorno" as const, desde: d("2026-11-02T09:00-03:00") } };
    const r = avaliarEspera(f, [], d("2026-11-09T09:00-03:00"), BORBORA);
    expect(r).toMatchObject({ esperando: true, noPainel: true });
    // 03 a 06/11 = 4 jornadas de 9 h, mais 1 h na segunda 09/11 = 37 h.
    if (r.esperando) expect(r.diasUteis).toBeCloseTo(37 / 9, 2);
  });
});

describe("Mensagem automática do celular: decide o TEXTO, não a mensagem (números da Bórbora)", () => {
  const SAUDACAO = "Olá! Sou do escritório Bórbora Advogados Associados. Como posso te chamar?";
  // A contagem que o banco devolve (fn_textos_automaticos_do_celular): 43 conversas,
  // 95% no prazo; "Ok" em 30 conversas, 39% no prazo.
  const automaticos = textosAutomaticos([
    { texto: SAUDACAO.toLowerCase(), conversas: 43, vezes: 60, no_prazo: 57 },
    { texto: "ok", conversas: 30, vezes: 41, no_prazo: 16 },
  ]);

  it("a saudação que saiu ATRASADA (502 s) continua automática — e o lead fica no painel", () => {
    const falas = marcarRespostasAutomaticas(
      [
        { ...fala("inbound", "external_device", "2026-11-02T20:00:00-03:00"), body: "quero falar com alguém" },
        { ...fala("outbound", "external_device", "2026-11-02T20:08:22-03:00"), body: SAUDACAO },
      ],
      automaticos,
    );
    expect(falas[1]!.automatica).toBe(true);
    const f = { ...nada, ficha: { motivo: "lead_pediu_pessoa" as const, desde: d("2026-11-02T20:00-03:00") } };
    const r = avaliarEspera(f, falas, d("2026-11-06T06:00-03:00"), BORBORA);
    expect(r).toMatchObject({ esperando: true, noPainel: true, quemFalouPorUltimo: "automacao" });
  });

  it("\"Ok\" de pessoa, mesmo na hora, fecha a espera", () => {
    const falas = marcarRespostasAutomaticas(
      [
        { ...fala("inbound", "external_device", "2026-11-03T10:00:00-03:00"), body: "oi" },
        { ...fala("outbound", "external_device", "2026-11-03T10:00:20-03:00"), body: "Ok" },
      ],
      automaticos,
    );
    expect(falas[1]!.automatica).toBeUndefined();
    const f = { ...nada, ficha: { motivo: "lead_pediu_pessoa" as const, desde: d("2026-11-03T10:00-03:00") } };
    expect(avaliarEspera(f, falas, d("2026-11-06T06:00-03:00"), BORBORA)).toEqual({ esperando: false });
  });

  it("\"[Unsupported message]\" nunca conta como pessoa", () => {
    const falas = marcarRespostasAutomaticas(
      [{ ...fala("outbound", "external_device", "2026-11-03T10:30:00-03:00"), body: "[Unsupported message]" }],
      new Set(),
    );
    const f = { ...nada, ficha: { motivo: "lead_pediu_pessoa" as const, desde: d("2026-11-03T10:00-03:00") } };
    expect(avaliarEspera(f, falas, d("2026-11-06T06:00-03:00"), BORBORA)).toMatchObject({ esperando: true, noPainel: true });
  });
});
