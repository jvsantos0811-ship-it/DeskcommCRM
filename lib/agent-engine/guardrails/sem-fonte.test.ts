import { describe, expect, it, vi } from 'vitest';

import {
  afirmacoesParaConferir,
  erroDeEnsinoSemFonte,
  lerEstadoSemFonte,
  montarPergunta,
  semAsFrasesVetadas,
  vetosDaResposta,
} from './sem-fonte';
import { criarConferenciaSemFonte } from './sem-fonte-conferencia';
import type { Queryable } from '../queue/queue';

/** Um banco de mentira: material da base, falas do cliente e o estado da organização. */
function banco(o: { material?: string[]; falas?: string[]; estado?: string } = {}): Queryable {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('from organizations'))
        return { rows: [{ settings: o.estado ? { conversa: { sem_fonte: { estado: o.estado } } } : {} }] };
      if (sql.includes('from ai_chunks')) return { rows: (o.material ?? []).map((content) => ({ content })) };
      if (sql.includes('from messages')) return { rows: (o.falas ?? []).map((texto) => ({ texto })) };
      if (sql.includes('from lead_notes')) return { rows: [] };
      return { rows: [] };
    }),
  } as unknown as Queryable;
}

/**
 * Um "modelo" que lê a pergunta de verdade: contradiz quando a frase traz um
 * número que a fonte não traz, mas a fonte traz outro; sem_base quando a fonte
 * não fala do assunto. É o suficiente para provar o encanamento — o juízo do
 * modelo real é medido no número de teste.
 */
function modeloQueLe() {
  return vi.fn(async (_sistema: string, pergunta: string) => {
    const [frasesBloco, fonte = ''] = pergunta.split(/\n\n(?:MATERIAL DO ESCRITÓRIO|FALAS DO CLIENTE)/);
    const frases = [...frasesBloco!.matchAll(/^(\d+)\. \[[^\]]+\] (.*)$/gm)];
    return JSON.stringify({
      frases: frases.map(([, i, frase]) => {
        const numFrase = frase!.match(/\d{2,4}/)?.[0];
        const numFonte = fonte.match(/\d{2,4}/)?.[0];
        if (!numFonte) return { i: Number(i), veredito: 'sem_base', correcao: null };
        if (numFrase && numFrase !== numFonte) return { i: Number(i), veredito: 'contradiz', correcao: numFonte };
        return { i: Number(i), veredito: 'sustentada', correcao: null };
      }),
    });
  });
}

describe('PC-020 — o que precisa de fonte (sem rede)', () => {
  it('regra, fala do cliente, e o que não afirma nada', () => {
    expect(afirmacoesParaConferir('O prazo do recurso é de 60 dias.')).toEqual([
      { i: 0, frase: 'O prazo do recurso é de 60 dias.', tipo: 'regra' },
    ]);
    expect(afirmacoesParaConferir('Como você comentou, o acidente foi em 2021.')).toEqual([
      { i: 0, frase: 'Como você comentou, o acidente foi em 2021.', tipo: 'cliente' },
    ]);
    expect(afirmacoesParaConferir('Qual a data do acidente?')).toEqual([]);
    expect(afirmacoesParaConferir('Oi, Maria! Tudo bem com você?')).toEqual([]);
  });

  it('estado padrão é decidindo; observando e desligada são opção', () => {
    expect(lerEstadoSemFonte({})).toBe('decidindo');
    expect(lerEstadoSemFonte({ conversa: { sem_fonte: { estado: 'observando' } } })).toBe('observando');
    expect(lerEstadoSemFonte({ conversa: { sem_fonte: { estado: 'qualquer' } } })).toBe('decidindo');
  });

  it('a pergunta leva as frases numeradas e só a fonte de cada tipo', () => {
    const p = montarPergunta([{ i: 0, frase: 'O prazo é de 60 dias.', tipo: 'regra' }], {
      material: ['O prazo do recurso é de 30 dias.'],
      falasDoCliente: ['nada'],
      notas: [],
    });
    expect(p).toContain('0. [regra] O prazo é de 60 dias.');
    expect(p).toContain('MATERIAL DO ESCRITÓRIO:');
    expect(p).not.toContain('FALAS DO CLIENTE');
  });

  it('resposta ilegível do modelo = null (fail-open, nenhum veto)', () => {
    expect(vetosDaResposta('não sei', [{ i: 0, frase: 'x', tipo: 'regra' }])).toBeNull();
  });
});

describe('PC-020 — os critérios do pedido', () => {
  it('"o prazo do recurso é de 60 dias" com a base dizendo 30 → veto, e o erro de ensino diz 30', async () => {
    const chamar = modeloQueLe();
    const c = criarConferenciaSemFonte({
      db: banco({ material: ['O prazo do recurso administrativo no INSS é de 30 dias.'] }),
      organizationId: 'org',
      contactId: 'contato',
      fontes: [],
      lerMaterialDoTurno: () => [],
      chamarModelo: chamar,
    });
    const r = await c.conferir('O prazo do recurso é de 60 dias.');
    expect(chamar).toHaveBeenCalledTimes(1);
    expect(r.vetos).toEqual([{ frase: 'O prazo do recurso é de 60 dias.', tipo: 'regra', veredito: 'contradiz', correcao: '30' }]);
    expect(erroDeEnsinoSemFonte(r.vetos)).toContain('"30"');
    expect(erroDeEnsinoSemFonte(r.vetos)).toContain('NÃO foi enviada');
  });

  it('regra que não está na base → veto: tire ou diga que confirma com a equipe', async () => {
    const c = criarConferenciaSemFonte({
      db: banco({ material: [] }),
      organizationId: 'org',
      contactId: 'contato',
      fontes: [],
      lerMaterialDoTurno: () => [],
      chamarModelo: modeloQueLe(),
    });
    const r = await c.conferir('Para o auxílio-acidente a carência é de 12 contribuições.');
    expect(r.vetos[0]).toMatchObject({ tipo: 'regra', veredito: 'sem_base' });
    expect(erroDeEnsinoSemFonte(r.vetos)).toContain('vai confirmar com a equipe');
  });

  it('"como você comentou, o acidente foi em 2021" e o cliente disse 2022 → veto', async () => {
    const c = criarConferenciaSemFonte({
      db: banco({ falas: ['oi', 'o acidente foi em março de 2022'] }),
      organizationId: 'org',
      contactId: 'contato',
      fontes: [],
      lerMaterialDoTurno: () => [],
      chamarModelo: modeloQueLe(),
    });
    const r = await c.conferir('Como você comentou, o acidente foi em 2021.');
    expect(r.vetos).toEqual([
      expect.objectContaining({ tipo: 'cliente', veredito: 'contradiz', correcao: '2022' }),
    ]);
    expect(erroDeEnsinoSemFonte(r.vetos)).toContain('o cliente NÃO disse isso');
  });

  it('mensagem só com pergunta → nenhuma chamada de conferência', async () => {
    const chamar = modeloQueLe();
    const db = banco();
    const c = criarConferenciaSemFonte({ db, organizationId: 'org', contactId: 'c', fontes: [], lerMaterialDoTurno: () => [], chamarModelo: chamar });
    const r = await c.conferir('Em que cidade você mora? E quando foi o acidente?');
    expect(chamar).not.toHaveBeenCalled();
    expect(r).toMatchObject({ chamou: false, vetos: [] });
  });

  it('desligada: nenhuma chamada; observando: acha mas o estado diz que não veta', async () => {
    const chamar = modeloQueLe();
    const off = criarConferenciaSemFonte({ db: banco({ estado: 'desligada' }), organizationId: 'o', contactId: 'c', fontes: [], lerMaterialDoTurno: () => [], chamarModelo: chamar });
    expect((await off.conferir('O prazo do recurso é de 60 dias.')).chamou).toBe(false);
    expect(chamar).not.toHaveBeenCalled();
    const obs = criarConferenciaSemFonte({ db: banco({ estado: 'observando', material: ['prazo de 30 dias'] }), organizationId: 'o', contactId: 'c', fontes: [], lerMaterialDoTurno: () => [], chamarModelo: chamar });
    const r = await obs.conferir('O prazo do recurso é de 60 dias.');
    expect(r.estado).toBe('observando');
    expect(r.vetos).toHaveLength(1);
  });

  it('o mesmo texto não paga duas chamadas no turno; modelo que falha não veta (fail-open)', async () => {
    const chamar = modeloQueLe();
    const c = criarConferenciaSemFonte({ db: banco({ material: ['prazo de 30 dias'] }), organizationId: 'o', contactId: 'c', fontes: [], lerMaterialDoTurno: () => [], chamarModelo: chamar });
    await c.conferir('O prazo do recurso é de 60 dias.');
    await c.conferir('O prazo do recurso é de 60 dias.');
    expect(chamar).toHaveBeenCalledTimes(1);
    const quebrado = criarConferenciaSemFonte({
      db: banco({ material: ['x'] }), organizationId: 'o', contactId: 'c', fontes: [], lerMaterialDoTurno: () => [],
      chamarModelo: async () => { throw new Error('429'); },
    });
    expect(await quebrado.conferir('O prazo do recurso é de 60 dias.')).toMatchObject({ falhou: true, vetos: [] });
  });

  it('na 3ª reescrita sem fonte, saem só as frases vetadas', () => {
    expect(
      semAsFrasesVetadas('O prazo do recurso é de 60 dias. Vou pedir seus documentos agora.', [
        { frase: 'O prazo do recurso é de 60 dias.', tipo: 'regra', veredito: 'contradiz', correcao: '30' },
      ]),
    ).toBe('Vou pedir seus documentos agora.');
  });
});
