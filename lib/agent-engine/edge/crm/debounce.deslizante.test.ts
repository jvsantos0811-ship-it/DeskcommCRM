/**
 * Espera deslizante (PC-002, Fase 1, item 2) — os critérios F1-a, F1-c e F1-d
 * medidos no `decidirRajada` de verdade, com uma fila falsa que faz o papel do
 * banco: o UPDATE que desliza o `run_after` é reproduzido com a mesma
 * aritmética do SQL (`greatest(run_after, least(agora + espera, criado + teto))`).
 *
 * Determinístico: relógio fixo, nada de timer real.
 */
import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { decidirRajada, esperaDaMensagem, type EsperaDeslizante } from './debounce';

const alvo = { organizationId: 'org1', contactId: 'contato1' };
const T0 = 1_700_000_000_000;
const TEXTO = 5_000;
const padrao = (tipo: string | null = 'text'): EsperaDeslizante => ({
  tetoMs: 30_000,
  esperaMidiaMs: 20_000,
  tipo,
});

interface Job {
  id: string;
  status: 'pending' | 'running';
  criadoEm: number;
  runAfter: number;
  mensagens: number;
}

/** Fila falsa: responde ao UPDATE deslizante como o Postgres responderia. */
function filaFalsa(relogio: { agora: number }) {
  const fila: Job[] = [];
  const pool = {
    query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      if (!sql.includes('update job_queue')) throw new Error(`consulta inesperada: ${sql}`);
      const [, contato, espera, teto] = params as [string, string, number, number];
      if (contato !== alvo.contactId) throw new Error('contato errado');
      const job = fila.find((j) => j.status === 'pending' && j.runAfter > relogio.agora);
      if (job === undefined) return { rows: [] };
      job.runAfter = Math.max(job.runAfter, Math.min(relogio.agora + espera, job.criadoEm + teto));
      return { rows: [{ id: job.id }] };
    }),
  } as unknown as pg.Pool;
  return { fila, pool };
}

/**
 * Roda uma sequência de mensagens (instante relativo a T0 + tipo) e devolve os
 * turnos: quando cada job ficou claimável e quantas mensagens levou. Um job só é
 * claimado quando `run_after <= agora`, e o "worker" olha a cada 100 ms.
 */
async function simular(mensagens: { em: number; tipo?: string }[]) {
  const relogio = { agora: T0 };
  const { fila, pool } = filaFalsa(relogio);
  const turnos: { claimadoEm: number; mensagens: number }[] = [];
  const fim = T0 + Math.max(...mensagens.map((m) => m.em)) + 60_000;
  let proximo = 1;
  for (let t = T0; t <= fim; t += 100) {
    relogio.agora = t;
    for (const m of mensagens.filter((x) => T0 + x.em === t)) {
      const d = await decidirRajada(pool, alvo, TEXTO, t, padrao(m.tipo ?? 'text'));
      if (d.tipo === 'coalescido') {
        fila.find((j) => j.id === d.jobId)!.mensagens += 1;
      } else {
        fila.push({
          id: `job-${proximo++}`,
          status: 'pending',
          criadoEm: t,
          runAfter: d.runAfter!.getTime(),
          mensagens: 1,
        });
      }
    }
    for (const j of fila) {
      if (j.status === 'pending' && j.runAfter <= t) {
        j.status = 'running';
        turnos.push({ claimadoEm: t - T0, mensagens: j.mensagens });
      }
    }
  }
  return turnos;
}

describe('espera deslizante (PC-002)', () => {
  it('F1-a — "Meu neto sofreu o acidente de moto" e, 3 s depois, "e ficou machucado": um turno com as duas', async () => {
    const turnos = await simular([{ em: 0 }, { em: 3_000 }]);
    expect(turnos).toEqual([{ claimadoEm: 8_000, mensagens: 2 }]);
  });

  it('F1-c — 3 mensagens com 4 s entre elas: uma resposta só, 5 s depois da última', async () => {
    const turnos = await simular([{ em: 0 }, { em: 4_000 }, { em: 8_000 }]);
    expect(turnos).toEqual([{ claimadoEm: 13_000, mensagens: 3 }]);
  });

  it('F1-d — lead escrevendo sem parar por 40 s: a resposta sai no teto de 30 s', async () => {
    const mensagens = Array.from({ length: 21 }, (_, i) => ({ em: i * 2_000 }));
    const turnos = await simular(mensagens);
    // O 1º turno é claimado no teto (30 s desde a 1ª mensagem) com tudo o que
    // chegou até ali; o que veio depois abre o lote seguinte.
    expect(turnos[0]).toEqual({ claimadoEm: 30_000, mensagens: 15 });
    expect(turnos.reduce((s, t) => s + t.mensagens, 0)).toBe(21);
  });

  it('foto espera 20 s pela pergunta que costuma vir depois dela', async () => {
    const turnos = await simular([{ em: 0, tipo: 'image' }]);
    expect(turnos).toEqual([{ claimadoEm: 20_000, mensagens: 1 }]);
  });

  it('texto depois da foto não encurta a espera que a foto pediu', async () => {
    const turnos = await simular([{ em: 0, tipo: 'image' }, { em: 2_000 }]);
    expect(turnos).toEqual([{ claimadoEm: 20_000, mensagens: 2 }]);
  });

  it('documento no meio do lote estica até o teto, nunca além', async () => {
    const turnos = await simular([{ em: 0 }, { em: 4_000 }, { em: 8_000 }, { em: 12_000, tipo: 'document' }]);
    expect(turnos).toEqual([{ claimadoEm: 30_000, mensagens: 4 }]);
  });

  it('job já claimado (turno rodando) não recebe carona: a mensagem abre janela nova', async () => {
    const turnos = await simular([{ em: 0 }, { em: 6_000 }]);
    expect(turnos).toEqual([
      { claimadoEm: 5_000, mensagens: 1 },
      { claimadoEm: 11_000, mensagens: 1 },
    ]);
  });
});

describe('esperaDaMensagem', () => {
  it('texto usa a espera do agente; mídia usa a maior das duas; nada passa do teto', () => {
    expect(esperaDaMensagem(5_000, padrao('text'))).toBe(5_000);
    expect(esperaDaMensagem(5_000, padrao('audio'))).toBe(5_000);
    expect(esperaDaMensagem(5_000, padrao('image'))).toBe(20_000);
    expect(esperaDaMensagem(25_000, padrao('document'))).toBe(25_000);
    expect(esperaDaMensagem(45_000, padrao('text'))).toBe(30_000);
    expect(esperaDaMensagem(5_000, padrao(null))).toBe(5_000);
  });
});
