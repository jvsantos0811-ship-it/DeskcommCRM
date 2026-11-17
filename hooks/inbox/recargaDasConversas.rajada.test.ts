/**
 * Uma rajada que não acaba não pode virar uma recarga da lista a cada 150 ms.
 *
 * O defeito (PC-042): uma importação de histórico escreve em `conversations`
 * sem parar, e cada aba com o inbox aberto recarregava a lista a cada ~150 ms.
 * Numa instalação real: ~2.000 recargas a cada 5 min, banco esgotado, IA de
 * todas as organizações minutos sem responder.
 *
 * O que se mede aqui:
 *  - 200 eventos em 10 s viram no máximo 3 recargas dentro dos 10 s;
 *  - o ÚLTIMO evento sempre leva a uma recarga que sai depois dele;
 *  - evento isolado continua recarregando em 150 ms, como antes;
 *  - nenhum evento espera mais que ~5 s pela recarga.
 *
 * SABOTAGEM: tirar as fichas de `agendarRecargaDasConversas` (voltar a agendar
 * sempre em `JANELA_MS`) = o primeiro caso vermelho, com dezenas de recargas.
 * Tirar a trava do relógio (`Math.max(0, …)` e o realinhamento de `em`) = o
 * caso "relógio que volta" vermelho: a recarga ficava marcada para daqui a 1 h.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";

import { agendarRecargaDasConversas } from "./recargaDasConversas";

function clienteFalso() {
  const recargas: number[] = [];
  const qc = {
    isFetching: () => 0,
    invalidateQueries: vi.fn(async (f: { queryKey: unknown[] }) => {
      if (f.queryKey[0] === "conversations") recargas.push(Date.now());
    }),
  } as unknown as QueryClient;
  return { qc, recargas };
}

describe("recarga do inbox numa rajada contínua (PC-042)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("200 eventos em 10 s: no máximo 3 recargas, e a última vem depois do último evento", () => {
    const { qc, recargas } = clienteFalso();
    const inicio = Date.now();
    let ultimoEvento = inicio;
    for (let i = 0; i < 200; i++) {
      ultimoEvento = Date.now();
      agendarRecargaDasConversas(qc);
      vi.advanceTimersByTime(50);
    }
    const dentroDaJanela = recargas.filter((t) => t - inicio <= 10_000);
    expect(dentroDaJanela.length).toBeLessThanOrEqual(3);

    vi.advanceTimersByTime(10_000);
    expect(recargas.length).toBeGreaterThan(0);
    expect(recargas[recargas.length - 1]).toBeGreaterThan(ultimoEvento);
  });

  it("evento isolado recarrega em 150 ms, como antes", () => {
    const { qc, recargas } = clienteFalso();
    agendarRecargaDasConversas(qc);
    vi.advanceTimersByTime(149);
    expect(recargas.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(recargas.length).toBe(1);
  });

  it("uso normal (duas mensagens a 2 s uma da outra): as duas em 150 ms", () => {
    const { qc, recargas } = clienteFalso();
    const t0 = Date.now();
    agendarRecargaDasConversas(qc);
    vi.advanceTimersByTime(2_000);
    const t1 = Date.now();
    agendarRecargaDasConversas(qc);
    vi.advanceTimersByTime(1_000);
    expect(recargas).toEqual([t0 + 150, t1 + 150]);
  });

  it("relógio do computador que volta 1 h não segura a recarga", () => {
    const { qc, recargas } = clienteFalso();
    agendarRecargaDasConversas(qc);
    vi.advanceTimersByTime(200);
    agendarRecargaDasConversas(qc);
    vi.advanceTimersByTime(200);
    expect(recargas.length).toBe(2);
    vi.setSystemTime(Date.now() - 60 * 60_000);
    const ev = Date.now();
    agendarRecargaDasConversas(qc);
    vi.advanceTimersByTime(6_000);
    expect(recargas.length).toBe(3);
    expect(recargas[2]! - ev).toBeLessThanOrEqual(5_000 + 150);
  });

  it("nenhum evento da rajada espera mais que ~5 s pela recarga", () => {
    const { qc, recargas } = clienteFalso();
    const eventos: number[] = [];
    for (let i = 0; i < 300; i++) {
      eventos.push(Date.now());
      agendarRecargaDasConversas(qc);
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(10_000);
    for (const ev of eventos) {
      const proxima = recargas.find((r) => r > ev);
      expect(proxima, `evento em ${ev - eventos[0]!} ms sem recarga depois`).toBeDefined();
      expect(proxima! - ev).toBeLessThanOrEqual(5_000 + 150);
    }
  });
});
