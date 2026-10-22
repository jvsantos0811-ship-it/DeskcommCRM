import { describe, expect, it } from "vitest";

import {
  ANTECEDENCIA_MAXIMA_MS,
  motivoParaRecusarAgendamento,
  notaDeFalha,
  podeCancelar,
  TEXTO_MAXIMO,
} from "@/lib/inbox/mensagens-agendadas";

const agora = new Date("2026-10-22T12:00:00.000Z");
const daqui = (ms: number) => new Date(agora.getTime() + ms);

describe("mensagem agendada — o que a tela e a rota aceitam", () => {
  it("aceita texto e horário dentro da janela", () => {
    expect(motivoParaRecusarAgendamento("Oi, segue o link", daqui(60 * 60 * 1000), agora)).toBeNull();
  });

  it("recusa texto vazio ou só espaços", () => {
    expect(motivoParaRecusarAgendamento("   ", daqui(60 * 60 * 1000), agora)).toMatch(/Escreva/);
  });

  it("recusa texto acima do teto do WhatsApp", () => {
    expect(motivoParaRecusarAgendamento("a".repeat(TEXTO_MAXIMO + 1), daqui(3_600_000), agora)).toMatch(
      /4096/,
    );
  });

  it("recusa horário no passado ou a menos de 1 minuto", () => {
    expect(motivoParaRecusarAgendamento("oi", daqui(-1000), agora)).toMatch(/1 minuto/);
    expect(motivoParaRecusarAgendamento("oi", daqui(30_000), agora)).toMatch(/1 minuto/);
  });

  it("recusa além de 60 dias", () => {
    expect(motivoParaRecusarAgendamento("oi", daqui(ANTECEDENCIA_MAXIMA_MS + 1), agora)).toMatch(/60 dias/);
  });

  it("recusa data inválida", () => {
    expect(motivoParaRecusarAgendamento("oi", new Date("não é data"), agora)).toMatch(/inválida/);
  });
});

describe("mensagem agendada — estados", () => {
  it("só a que ainda está na fila pode ser cancelada", () => {
    expect(podeCancelar("scheduled")).toBe(true);
    for (const s of ["sending", "sent", "failed", "cancelled"] as const) expect(podeCancelar(s)).toBe(false);
  });

  it("a nota de falha traz o motivo e um trecho curto do texto", () => {
    const nota = notaDeFalha("x".repeat(500), "contato bloqueado.");
    expect(nota).toContain("NÃO foi enviada: contato bloqueado.");
    expect(nota.length).toBeLessThan(250);
  });
});
