/**
 * PC-002, Fase 1, item 4 — erro de ferramenta não segura a resposta.
 *
 * Cada ferramenta tem UMA tentativa por turno: falhou (resultado `ok:false`,
 * exceção ou tempo esgotado), o erro é registrado e as próximas chamadas dela
 * no mesmo turno nem rodam — o modelo segue sem ela. Critério F1-g: com a
 * ferramenta forçada a falhar, o turno não fica preso nela.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ToolSet } from '../edge/llm/run-model-call';
import { wrapToolsWithBreaker, type ToolBreakerThresholds } from './tool-breaker';

const thresholds: ToolBreakerThresholds = {
  exactFailureWarn: 2,
  exactFailureBlock: 5,
  sameToolFailureWarn: 3,
  sameToolFailureHalt: 8,
  noProgressWarn: 3,
  noProgressBlock: 5,
};

function montar(
  execs: Record<string, (input: unknown) => unknown>,
  tempoMaximoMs = 50,
): { tools: Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>; falhas: string[]; warns: unknown[] } {
  const falhas: string[] = [];
  const warns: unknown[] = [];
  const log = { warn: (msg: string, f: unknown) => warns.push({ msg, f }), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const brutas: ToolSet = {};
  for (const [nome, fn] of Object.entries(execs)) {
    (brutas as Record<string, unknown>)[nome] = { execute: async (i: unknown) => fn(i) };
  }
  const tools = wrapToolsWithBreaker(brutas, {
    thresholds,
    readOnlyTools: [],
    log: log as never,
    umaTentativa: {
      exceto: ['send_message'],
      tempoMaximoMs,
      aoFalhar: (tool, motivo) => falhas.push(`${tool}:${motivo}`),
    },
  }) as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
  return { tools, falhas, warns };
}

describe('uma tentativa por ferramenta, por turno (PC-002)', () => {
  it('F1-g — ferramenta que lança: o turno recebe erro de ensino, NÃO uma exceção, e a 2ª chamada nem roda', async () => {
    const etiqueta = vi.fn(() => {
      throw new Error('crm_unavailable');
    });
    const { tools, falhas } = montar({ crm_manage_tags: etiqueta });

    const r1 = (await tools.crm_manage_tags!.execute({ add: ['x'] }, {})) as { ok: boolean; error: { code: string } };
    expect(r1.ok).toBe(false);
    expect(r1.error.code).toBe('ferramenta_falhou');

    const r2 = (await tools.crm_manage_tags!.execute({ add: ['y'] }, {})) as { ok: boolean; error: { code: string } };
    expect(r2.error.code).toBe('ferramenta_fora_neste_turno');
    expect(etiqueta).toHaveBeenCalledTimes(1);
    expect(falhas).toEqual(['crm_manage_tags:excecao']);
  });

  it('ferramenta que não responde: o teto corta, sem prender o turno', async () => {
    const pendurada = vi.fn(() => new Promise(() => {}));
    const { tools, falhas } = montar({ crm_manage_tags: pendurada }, 30);
    const inicio = Date.now();
    const r = (await tools.crm_manage_tags!.execute({}, {})) as { error: { code: string; message: string } };
    expect(Date.now() - inicio).toBeLessThan(1_000);
    expect(r.error.code).toBe('ferramenta_falhou');
    expect(r.error.message).toContain('não respondeu a tempo');
    expect(falhas).toEqual(['crm_manage_tags:tempo']);
  });

  it('resultado ok:false conta como a tentativa: devolvido ao modelo uma vez, depois fora', async () => {
    const recusa = vi.fn(() => ({ ok: false, error: { code: 'x', message: 'não deu' } }));
    const { tools, falhas } = montar({ crm_book_appointment: recusa });
    const r1 = (await tools.crm_book_appointment!.execute({}, {})) as { error: { code: string } };
    expect(r1.error.code).toBe('x');
    const r2 = (await tools.crm_book_appointment!.execute({}, {})) as { error: { code: string } };
    expect(r2.error.code).toBe('ferramenta_fora_neste_turno');
    expect(recusa).toHaveBeenCalledTimes(1);
    expect(falhas).toEqual(['crm_book_appointment:resultado']);
  });

  it('a falha de uma ferramenta não tira as outras do turno', async () => {
    const { tools } = montar({
      crm_manage_tags: () => {
        throw new Error('boom');
      },
      search_knowledge: () => ({ ok: true, hits: [] }),
    });
    await tools.crm_manage_tags!.execute({}, {});
    expect(await tools.search_knowledge!.execute({}, {})).toEqual({ ok: true, hits: [] });
  });

  it('as de envio ficam fora da regra: o erro de ensino pode ser corrigido no mesmo turno', async () => {
    const envio = vi
      .fn()
      .mockReturnValueOnce({ ok: false, error: { code: 'corpo_vazio', message: 'reescreva' } })
      .mockReturnValueOnce({ ok: true });
    const { tools } = montar({ send_message: envio });
    await tools.send_message!.execute({ body: ' ' }, {});
    expect(await tools.send_message!.execute({ body: 'oi' }, {})).toEqual({ ok: true });
    expect(envio).toHaveBeenCalledTimes(2);
  });

  it('erro de controle (job perdido) sobe intacto — não é falha de ferramenta', async () => {
    class JobPerdido extends Error {
      override readonly name = 'job_settled';
    }
    const { tools } = montar({
      crm_manage_tags: () => {
        throw new JobPerdido('lease perdida');
      },
    });
    await expect(tools.crm_manage_tags!.execute({}, {})).rejects.toThrow('lease perdida');
  });
});
