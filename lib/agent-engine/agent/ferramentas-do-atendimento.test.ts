import { describe, expect, it, vi } from 'vitest';

import type { AcoesDoAtendimento } from '@/lib/channels/types';

import { FERRAMENTA_ACAO, FERRAMENTA_ANOTAR, registrarFerramentasDoAtendimento } from './ferramentas-do-atendimento';
import type { ToolSet } from '../edge/llm/run-model-call';

/** Ferramentas da IA quando a conversa mora dentro de outra plataforma (PC-047). */
function acoesFalsas(over: Partial<AcoesDoAtendimento> = {}): AcoesDoAtendimento {
  return {
    rotulo: 'Plataforma',
    acoes: [],
    anotar: vi.fn(async () => {}),
    executar: vi.fn(async () => {}),
    ...over,
  };
}

type Executavel = { execute: (raw: unknown, opts: never) => Promise<Record<string, unknown>> };
const log = { warn: vi.fn() };

describe('ferramentas do atendimento', () => {
  it('sem ação liberada, só a anotação entra', () => {
    const tools: ToolSet = {};
    registrarFerramentasDoAtendimento(tools, acoesFalsas(), log);
    expect(Object.keys(tools)).toEqual([FERRAMENTA_ANOTAR]);
  });

  it('com ações liberadas, a IA escolhe só entre as chaves da tela', async () => {
    const executar = vi.fn(async () => {});
    const tools: ToolSet = {};
    registrarFerramentasDoAtendimento(
      tools,
      acoesFalsas({ acoes: [{ chave: 'etiquetar', nome: 'Etiquetar', quandoUsar: 'teste' }], executar }),
      log,
    );
    const acao = tools[FERRAMENTA_ACAO] as unknown as Executavel;
    expect(await acao.execute({ acao: 'etiquetar' }, {} as never)).toEqual({ ok: true, status: 'executada', acao: 'etiquetar' });
    expect(executar).toHaveBeenCalledWith('etiquetar');

    const fora = await acao.execute({ acao: 'dlg_livre' }, {} as never);
    expect(fora.ok).toBe(false);
    expect(executar).toHaveBeenCalledTimes(1);
  });

  it('a plataforma recusar vira erro de ENSINO, nunca exceção que derrube o turno', async () => {
    const tools: ToolSet = {};
    registrarFerramentasDoAtendimento(
      tools,
      acoesFalsas({
        anotar: vi.fn(async () => {
          throw new Error('chatguru_400: recusado');
        }),
      }),
      log,
    );
    const anotar = tools[FERRAMENTA_ANOTAR] as unknown as Executavel;
    const r = await anotar.execute({ texto: 'resumo do caso para a equipe' }, {} as never);
    expect(r).toEqual({
      ok: false,
      error: { code: 'nao_anotado', message: 'a anotação não foi gravada agora; siga o atendimento sem ela.' },
    });
    expect(log.warn).toHaveBeenCalled();
  });

  it('anotação vazia é recusada com instrução', async () => {
    const anotarSpy = vi.fn(async () => {});
    const tools: ToolSet = {};
    registrarFerramentasDoAtendimento(tools, acoesFalsas({ anotar: anotarSpy }), log);
    const anotar = tools[FERRAMENTA_ANOTAR] as unknown as Executavel;
    const r = await anotar.execute({ texto: '' }, {} as never);
    expect(r.ok).toBe(false);
    expect(anotarSpy).not.toHaveBeenCalled();
  });
});
