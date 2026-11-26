import { describe, expect, it } from "vitest";

import {
  agendaDoCompromisso,
  montarRevezamento,
  motivoDoDescarte,
  unirHorariosDasAgendas,
  type LinhaDaAgendaDoDono,
} from "./revezamento";

/**
 * PC-054 — as regras PURAS do revezamento entre agendas. A coleta e a marcação
 * com o banco de mentira estão em `tests/unit/agenda-revezamento-na-marcacao.test.ts`.
 */

const MARIA = "aaaaaaaa-0000-4000-8000-0000000000a1";
const JESSICA = "aaaaaaaa-0000-4000-8000-0000000000a2";
const PESSOAL = "aaaaaaaa-0000-4000-8000-0000000000a3";
const CONEXAO = "cccccccc-0000-4000-8000-00000000000c";

function linha(id: string, extra: Partial<LinhaDaAgendaDoDono> = {}): LinhaDaAgendaDoDono {
  return {
    agenda_id: id,
    connection_id: CONEXAO,
    external_calendar_id: `${id}@grupo`,
    nome: id === MARIA ? "Maria Vitória" : id === JESSICA ? "Jessica" : null,
    na_lista: true,
    destino: false,
    disponivel: true,
    aceita_escrita: true,
    conta_conflito: true,
    ...extra,
  };
}

describe("montarRevezamento", () => {
  it("lista vazia = sem revezamento", () => {
    expect(montarRevezamento([], [linha(MARIA)], null)).toBeNull();
  });

  it("sem histórico, a vez é da primeira da lista", () => {
    const rev = montarRevezamento([MARIA, JESSICA], [linha(MARIA), linha(JESSICA)], null);
    expect(rev?.agendas.map((a) => a.id)).toEqual([MARIA, JESSICA]);
    expect(rev?.agendas[0]?.nome).toBe("Maria Vitória");
  });

  it("depois da primeira, a vez é da segunda", () => {
    const rev = montarRevezamento([MARIA, JESSICA], [linha(MARIA), linha(JESSICA)], MARIA);
    expect(rev?.agendas.map((a) => a.id)).toEqual([JESSICA, MARIA]);
  });

  it("agenda que sumiu da conta, ficou indisponível, sem escrita ou sem conflito sai da vez, com o motivo", () => {
    const rev = montarRevezamento(
      [MARIA, JESSICA, PESSOAL, "dddddddd-0000-4000-8000-00000000000d"],
      [linha(MARIA), linha(JESSICA, { conta_conflito: false }), linha(PESSOAL, { aceita_escrita: false })],
      null,
    );
    expect(rev?.agendas.map((a) => a.id)).toEqual([MARIA]);
    expect(rev?.descartadas).toEqual([
      { id: JESSICA, motivo: "nao_conta_conflito" },
      { id: PESSOAL, motivo: "sem_escrita" },
      { id: "dddddddd-0000-4000-8000-00000000000d", motivo: "fora_da_conta" },
    ]);
  });

  it("nenhuma utilizável = sem revezamento (vale a regra de sempre)", () => {
    expect(montarRevezamento([MARIA], [linha(MARIA, { disponivel: false })], null)).toBeNull();
  });

  it("o destino só vale quando há UM", () => {
    const comUm = montarRevezamento(
      [MARIA, JESSICA],
      [linha(MARIA, { destino: true }), linha(JESSICA)],
      null,
    );
    expect(comUm?.destino?.id).toBe(MARIA);
    const comDois = montarRevezamento(
      [MARIA, JESSICA],
      [linha(MARIA, { destino: true }), linha(JESSICA, { destino: true })],
      null,
    );
    expect(comDois?.destino).toBeNull();
  });

  it("linha que só veio por ser destino (fora da lista) não entra na vez", () => {
    const rev = montarRevezamento([JESSICA, MARIA], [linha(JESSICA), linha(PESSOAL, { na_lista: false, destino: true })], null);
    expect(rev?.agendas.map((a) => a.id)).toEqual([JESSICA]);
    expect(rev?.destino?.id).toBe(PESSOAL);
  });
});

describe("motivoDoDescarte", () => {
  it("na ordem: fora da conta, indisponível, sem escrita, sem conflito", () => {
    expect(motivoDoDescarte(undefined)).toBe("fora_da_conta");
    expect(motivoDoDescarte({ disponivel: false, aceita_escrita: false, conta_conflito: false })).toBe("indisponivel");
    expect(motivoDoDescarte({ disponivel: true, aceita_escrita: false, conta_conflito: false })).toBe("sem_escrita");
    expect(motivoDoDescarte({ disponivel: true, aceita_escrita: true, conta_conflito: false })).toBe("nao_conta_conflito");
    expect(motivoDoDescarte({ disponivel: true, aceita_escrita: true, conta_conflito: true })).toBeNull();
  });
});

describe("agendaDoCompromisso", () => {
  const rev = montarRevezamento([MARIA, JESSICA], [linha(MARIA, { destino: true }), linha(JESSICA)], null)!;

  it("já foi ao Google: a agenda onde o evento está", () => {
    expect(
      agendaDoCompromisso({ google_connection_id: CONEXAO, google_calendar_id: `${JESSICA}@grupo`, target_calendar_id: MARIA }, rev),
    ).toBe(JESSICA);
  });

  it("no Google, numa agenda que não é do revezamento nem o destino: não ocupa nenhuma", () => {
    expect(agendaDoCompromisso({ google_connection_id: CONEXAO, google_calendar_id: "outra@grupo" }, rev)).toBeNull();
  });

  it("ainda não foi, com agenda escolhida: a escolhida", () => {
    expect(agendaDoCompromisso({ target_calendar_id: JESSICA }, rev)).toBe(JESSICA);
  });

  it("ainda não foi, sem agenda escolhida: o destino", () => {
    expect(agendaDoCompromisso({}, rev)).toBe(MARIA);
  });

  it("sem destino e sem escolha: ocupa TODAS (o erro barato)", () => {
    expect(agendaDoCompromisso({}, { ...rev, destino: null })).toBe("todas");
  });
});

describe("unirHorariosDasAgendas", () => {
  const h = (iso: string) => ({ inicio: new Date(iso), fim: new Date(new Date(iso).getTime() + 3_600_000) });

  it("um horário de duas agendas fica com a da vez; a união sai em ordem de início", () => {
    const r = unirHorariosDasAgendas([
      { agendaId: MARIA, slots: [h("2026-10-07T14:00:00Z")] },
      { agendaId: JESSICA, slots: [h("2026-10-07T13:00:00Z"), h("2026-10-07T14:00:00Z")] },
    ]);
    expect(r.map((s) => [s.inicio.toISOString(), s.agendaId])).toEqual([
      ["2026-10-07T13:00:00.000Z", JESSICA],
      ["2026-10-07T14:00:00.000Z", MARIA],
    ]);
  });
});
