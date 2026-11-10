import { describe, expect, it } from "vitest";

import type { Lead } from "@/lib/types/leads";
import { applyFilters } from "./filters";
import { digitosDaBuscaPorTelefone, telefoneCasaComBusca } from "./busca-por-telefone";

// Número fictício (faixa de celular de BH): o mesmo dos critérios do PC-024.
const CELULAR = "+5531998761234";

describe("busca do funil pelo telefone (PC-024 item 3)", () => {
  it.each([
    "+55 (31) 99876-1234",
    "31998761234",
    "3198761234",
    "1234",
    "5531998761234",
    "553198761234",
    "9876-1234",
    "99876.1234",
    " 31 99876 1234 ",
  ])("acha o card por %s", (termo) => {
    expect(telefoneCasaComBusca(CELULAR, termo)).toBe(true);
  });

  it("acha o cadastro antigo SEM o nono pela forma com o nono", () => {
    expect(telefoneCasaComBusca("+553198761234", "31 99876-1234")).toBe(true);
    expect(telefoneCasaComBusca("+553198761234", "1234")).toBe(true);
  });

  it.each(["4321", "31 99876-1235", "123", "Maria 1234", "", "abc"])("não acha por %s", (termo) => {
    expect(telefoneCasaComBusca(CELULAR, termo)).toBe(false);
  });

  it("um 9 grudado num FIXO não vira o fixo de outra pessoa", () => {
    // 31 3234-5678 é fixo; "31 93234-5678" não pode achá-lo pela variante.
    expect(telefoneCasaComBusca("+553132345678", "31932345678")).toBe(false);
    expect(telefoneCasaComBusca("+553132345678", "3132345678")).toBe(true);
  });

  it("sem telefone no card não há o que casar", () => {
    expect(telefoneCasaComBusca(null, "1234")).toBe(false);
    expect(telefoneCasaComBusca(undefined, "1234")).toBe(false);
  });

  it("só é busca por número com dígitos e pontuação de telefone, a partir de 4 dígitos", () => {
    expect(digitosDaBuscaPorTelefone("(31) 9876")).toBe("319876");
    expect(digitosDaBuscaPorTelefone("123")).toBeNull();
    expect(digitosDaBuscaPorTelefone("Ana 31")).toBeNull();
  });
});

describe("applyFilters: a busca soma o telefone ao título", () => {
  const base = {
    pipeline_id: "p",
    stage_id: "s",
    status: "open",
    tags: [],
    owner_user_id: null,
    owner_agent_id: null,
    description: null,
  } as unknown as Lead;
  const leads = [
    { ...base, id: "a", title: "Maria", contact_phone: CELULAR },
    { ...base, id: "b", title: "João", contact_phone: "+5531988887777" },
    { ...base, id: "c", title: "Cliente 1234", contact_phone: undefined },
  ] as Lead[];

  it.each(["+55 (31) 99876-1234", "31998761234", "3198761234"])("%s acha só o card do número", (q) => {
    expect(applyFilters(leads, { search: q }).map((l) => l.id)).toEqual(["a"]);
  });

  it("os últimos 4 dígitos acham pelo telefone E pelo título, como antes", () => {
    expect(applyFilters(leads, { search: "1234" }).map((l) => l.id)).toEqual(["a", "c"]);
  });

  it("busca por nome continua igual", () => {
    expect(applyFilters(leads, { search: "joão" }).map((l) => l.id)).toEqual(["b"]);
  });
});
