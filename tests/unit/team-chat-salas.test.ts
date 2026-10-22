import { describe, expect, it } from "vitest";

import {
  outroParticipante,
  participantesDaSala,
  podeEntrar,
  SALA_GERAL,
  salaDireta,
  salaValida,
} from "@/lib/team-chat/salas";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("chat da equipe — salas", () => {
  it("a conversa de A com B e a de B com A são a mesma sala", () => {
    expect(salaDireta(A, B)).toBe(salaDireta(B, A));
    expect(salaDireta(A, B)).toBe(`dm:${A}:${B}`);
  });

  it("só os dois entram na sala direta; todos entram na geral", () => {
    const sala = salaDireta(A, B);
    expect(podeEntrar(sala, A)).toBe(true);
    expect(podeEntrar(sala, B)).toBe(true);
    expect(podeEntrar(sala, C)).toBe(false);
    expect(podeEntrar(SALA_GERAL, C)).toBe(true);
  });

  it("recusa sala fora de ordem, consigo mesmo ou malformada", () => {
    expect(salaValida(`dm:${B}:${A}`)).toBe(false);
    expect(salaValida(`dm:${A}:${A}`)).toBe(false);
    expect(salaValida("dm:x:y")).toBe(false);
    expect(salaValida("diretoria")).toBe(false);
    expect(participantesDaSala(SALA_GERAL)).toBeNull();
  });

  it("diz quem é o outro participante", () => {
    expect(outroParticipante(salaDireta(A, B), A)).toBe(B);
    expect(outroParticipante(salaDireta(A, B), C)).toBeNull();
  });
});
