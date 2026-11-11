import { describe, expect, it } from "vitest";

import {
  acoesDoCompromisso,
  hojeNoFuso,
  horariosParaOferecer,
  janelaDeHorarios,
  separarCompromissos,
  type CompromissoListado,
} from "./compromissos-do-negocio";

const agora = new Date("2026-11-10T15:00:00.000Z"); // 12:00 em Brasília
const c = (id: string, inicio: string, situacao: string, extra: Partial<CompromissoListado> = {}): CompromissoListado => ({
  id,
  titulo: id,
  iniciaEm: inicio,
  terminaEm: new Date(Date.parse(inicio) + 30 * 60_000).toISOString(),
  situacao,
  donoId: "dono",
  ...extra,
});

describe("compromissos no pop-up do negócio (PC-027)", () => {
  it("próximos em ordem; o último que passou; desmarcado não é próximo; bloco do Google fora", () => {
    const r = separarCompromissos(
      [
        c("depois", "2026-11-20T13:00:00.000Z", "pending"),
        c("antes", "2026-11-12T13:00:00.000Z", "confirmed"),
        c("ontem", "2026-11-09T13:00:00.000Z", "completed"),
        c("semana-passada", "2026-11-03T13:00:00.000Z", "no_show"),
        c("desmarcado", "2026-11-15T13:00:00.000Z", "cancelled"),
        c("google", "2026-11-11T13:00:00.000Z", "confirmed", { origem: "google_sync" }),
      ],
      agora,
    );
    expect(r.proximos.map((x) => x.id)).toEqual(["antes", "depois"]);
    expect(r.ultimo?.id).toBe("desmarcado");
  });

  it("as ações seguem as regras da Agenda", () => {
    expect(acoesDoCompromisso(c("a", "2026-11-12T13:00:00.000Z", "pending"), agora)).toEqual(["confirmar", "remarcar", "desmarcar"]);
    expect(acoesDoCompromisso(c("b", "2026-11-12T13:00:00.000Z", "confirmed"), agora)).toEqual(["remarcar", "desmarcar"]);
    expect(acoesDoCompromisso(c("c", "2026-11-10T14:00:00.000Z", "confirmed"), agora)).toEqual(["compareceu", "faltou"]);
    expect(acoesDoCompromisso(c("d", "2026-11-09T14:00:00.000Z", "completed"), agora)).toEqual([]);
    expect(acoesDoCompromisso(c("e", "2026-11-12T14:00:00.000Z", "cancelled"), agora)).toEqual([]);
  });

  it("dia e janela no fuso da organização", () => {
    expect(hojeNoFuso(new Date("2026-11-11T02:30:00.000Z"), "America/Sao_Paulo")).toBe("2026-11-10");
    expect(janelaDeHorarios("2026-11-28", "America/Sao_Paulo", 7)).toEqual({
      de: "2026-11-28T03:00:00.000Z",
      ate: "2026-12-05T03:00:00.000Z",
    });
  });

  it("horários do dia; sem nenhum no dia, os próximos livres", () => {
    const slots = [
      { inicio: "2026-11-12T12:00:00.000Z", fim: "x" },
      { inicio: "2026-11-12T12:30:00.000Z", fim: "x" },
      { inicio: "2026-11-13T12:00:00.000Z", fim: "x" },
    ];
    expect(horariosParaOferecer(slots, "2026-11-12", "America/Sao_Paulo")).toEqual({
      doDia: ["2026-11-12T12:00:00.000Z", "2026-11-12T12:30:00.000Z"],
      proximos: [],
    });
    expect(horariosParaOferecer(slots, "2026-11-11", "America/Sao_Paulo")).toEqual({
      doDia: [],
      proximos: slots.map((s) => s.inicio),
    });
  });
});
