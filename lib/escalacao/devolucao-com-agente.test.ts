import { describe, expect, it } from "vitest";

import { validarDevolucao } from "./devolucao-com-agente";

/** PC-014 — "Devolver para a IA" num número com roteador pede o agente e uma linha. */
const comRoteador = {
  roteadorId: "r1",
  agentes: [
    { id: "a1", nome: "Raquel", intencao: "auxilio" },
    { id: "a2", nome: "Recepção", intencao: null },
  ],
};

describe("validarDevolucao", () => {
  it("sem roteador: o clique de sempre, nada é exigido", () => {
    expect(validarDevolucao({ roteadorId: null, agentes: [] }, {})).toEqual({ ok: true, agente: null, nota: null });
  });

  it("com roteador: sem agente, recusa", () => {
    expect(validarDevolucao(comRoteador, { nota: "fiz isso" })).toEqual({ ok: false, erro: "agente_obrigatorio" });
  });

  it("com roteador: agente de fora do roteador, recusa", () => {
    expect(validarDevolucao(comRoteador, { agenteId: "x", nota: "fiz isso" })).toEqual({
      ok: false,
      erro: "agente_fora_do_roteador",
    });
  });

  it("com roteador: sem a linha do que foi feito, recusa", () => {
    expect(validarDevolucao(comRoteador, { agenteId: "a1", nota: "  " })).toEqual({ ok: false, erro: "nota_obrigatoria" });
  });

  it("com roteador: agente e linha, passa (a linha é cortada em 200)", () => {
    const r = validarDevolucao(comRoteador, { agenteId: "a1", nota: "x".repeat(300) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agente?.nome).toBe("Raquel");
      expect(r.nota).toHaveLength(200);
    }
  });
});
