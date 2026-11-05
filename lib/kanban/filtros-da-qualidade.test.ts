/**
 * OS FILTROS DA QUALIDADE NO FUNIL (v3 §3): `?nivel=`, `?temp=`, `?servico=` e
 * `?situacao=` — ida e volta pela URL, o que filtram, e a convivência com os
 * filtros que já existiam (`?lead=` mora fora deles e continua com o quadro).
 */
import { describe, expect, it } from "vitest";

import type { QualidadeDoLead } from "@/lib/dados/qualidade";
import { applyFilters, filtersFromParams, filtersToParams, filtroLigado, interesseCasa } from "@/lib/kanban/filters";
import type { Lead } from "@/lib/types/leads";

function q(extra: Partial<QualidadeDoLead>): QualidadeDoLead {
  return { nota: 50, nivel: "B", estado: "aberto", parcelas: [], temperatura: "frio", situacoes: [], interesse: null, ...extra };
}

function lead(id: string, qualidade?: QualidadeDoLead, extra: Partial<Lead> = {}): Lead {
  return {
    id,
    title: id,
    description: null,
    status: "open",
    tags: [],
    owner_user_id: null,
    owner_agent_id: null,
    value_cents: null,
    currency: "BRL",
    expected_close_date: null,
    lost_reason: null,
    ...(qualidade ? { qualidade } : {}),
    ...extra,
  } as unknown as Lead;
}

const LEADS = [
  lead("a", q({ nota: 86, nivel: "A", temperatura: "quente", situacoes: ["esperando_fechamento"], interesse: "Auxílio-acidente" })),
  lead("b", q({ nota: 50, nivel: "B", temperatura: "morno", situacoes: ["esperando_fechamento", "parado"], interesse: "BPC/LOAS" })),
  lead("c", q({ nota: 30, nivel: "C", temperatura: "frio", situacoes: ["sem_resposta"], interesse: null })),
  lead("ganho", q({ nota: 100, nivel: null, estado: "ganho", temperatura: null }), { status: "won" }),
  lead("sem-nota"),
];
const ids = (ls: Lead[]) => ls.map((l) => l.id);
const sp = (s: string) => new URLSearchParams(s);

describe("a URL dos filtros da qualidade", () => {
  it("lê os quatro parâmetros, e o nível aceita minúscula", () => {
    expect(filtersFromParams(sp("nivel=a&temp=Quente&servico=BPC%2FLOAS&situacao=parado"))).toMatchObject({
      nivel: "A",
      temperatura: "quente",
      servico: "BPC/LOAS",
      situacao: "parado",
    });
  });
  it("valor fora da lista vira sem filtro, e não erro", () => {
    const f = filtersFromParams(sp("nivel=Z&temp=gelado&situacao=perdido&servico=%20%20"));
    expect(f.nivel).toBeUndefined();
    expect(f.temperatura).toBeUndefined();
    expect(f.situacao).toBeUndefined();
    expect(f.servico).toBeUndefined();
    expect(filtroLigado(f)).toBe(false);
  });
  it("ida e volta: o link do painel sobrevive a um F5", () => {
    const qs = "nivel=A&temp=quente&servico=Aux%C3%ADlio-acidente&situacao=esperando_fechamento";
    const f = filtersFromParams(sp(qs));
    expect(filtersFromParams(sp(filtersToParams(f)))).toEqual(f);
    expect(filtersToParams(f)).toBe("nivel=A&temp=quente&servico=Aux%C3%ADlio-acidente&situacao=esperando_fechamento");
  });
  it("junto dos filtros antigos, sem um apagar o outro", () => {
    const f = filtersFromParams(sp("owner=unassigned&tag=vip&nivel=B"));
    expect(f).toMatchObject({ owner: "unassigned", tag: ["vip"], nivel: "B" });
    expect(filtersToParams(f)).toBe("owner=unassigned&tag=vip&nivel=B");
  });
  it("qualquer um deles liga o filtro (a barra do quadro fica aberta)", () => {
    for (const qs of ["nivel=D", "temp=frio", "servico=X", "situacao=sem_resposta"]) {
      expect(filtroLigado(filtersFromParams(sp(qs)))).toBe(true);
    }
  });
});

describe("o que cada filtro deixa no quadro", () => {
  it("?nivel= mostra só o nível; ganho e lead sem nota ficam fora", () => {
    expect(ids(applyFilters(LEADS, { nivel: "A" }))).toEqual(["a"]);
    expect(ids(applyFilters(LEADS, { nivel: "C" }))).toEqual(["c"]);
    expect(ids(applyFilters(LEADS, { nivel: "D" }))).toEqual([]);
  });
  it("?temp=", () => {
    expect(ids(applyFilters(LEADS, { temperatura: "morno" }))).toEqual(["b"]);
    expect(ids(applyFilters(LEADS, { temperatura: "frio" }))).toEqual(["c"]);
  });
  it("?servico= pela régua do nome do tipo de lead", () => {
    expect(ids(applyFilters(LEADS, { servico: "bpc loas" }))).toEqual(["b"]);
    expect(ids(applyFilters(LEADS, { servico: "AUXILIO ACIDENTE" }))).toEqual(["a"]);
    expect(ids(applyFilters(LEADS, { servico: "Implante" }))).toEqual([]);
    expect(interesseCasa(null, "x")).toBe(false);
    expect(interesseCasa("BPC/LOAS", "///")).toBe(false);
  });
  it("?situacao= aceita o lead que tem a situação entre outras", () => {
    expect(ids(applyFilters(LEADS, { situacao: "esperando_fechamento" }))).toEqual(["a", "b"]);
    expect(ids(applyFilters(LEADS, { situacao: "parado" }))).toEqual(["b"]);
    expect(ids(applyFilters(LEADS, { situacao: "sem_resposta" }))).toEqual(["c"]);
  });
  it("os filtros se somam (E)", () => {
    expect(ids(applyFilters(LEADS, { situacao: "esperando_fechamento", temperatura: "quente" }))).toEqual(["a"]);
    expect(ids(applyFilters(LEADS, { nivel: "A", servico: "BPC/LOAS" }))).toEqual([]);
  });
  it("sem filtro da qualidade, todo card continua no quadro (com ou sem nota)", () => {
    expect(ids(applyFilters(LEADS, {}))).toEqual(["a", "b", "c", "ganho", "sem-nota"]);
  });
});
