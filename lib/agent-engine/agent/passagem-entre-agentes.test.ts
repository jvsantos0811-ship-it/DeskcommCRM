import { describe, expect, it } from 'vitest';

import {
  ATRASO_MAX_MS,
  ATRASO_MIN_MS,
  ESPERA_MAX_MS,
  TETO_DO_CARTAO,
  aberturaDoTurnoDaPassagem,
  blocoDeChegada,
  definicaoDaFerramentaDePassagem,
  destinosDaPassagem,
  esperaAntesDeFalar,
  formatarCartaoEntreAgentes,
  passagemNoTeste,
  qualificacaoDoNegocio,
  sanearTextoDoCartao,
  turnoDaPassagemTemOQueFazer,
  validarPayloadDaPassagem,
  type UltimaPassagem,
} from './passagem-entre-agentes';
import type { LoadedRouter } from './router-config';

/**
 * PC-014 — a passagem entre agentes do roteador, nas partes puras: quem pode
 * passar para quem, o cartão no formato fixo (sem telefone, sem CID, sem nome
 * de etiqueta, até 600 caracteres), o bloco de chegada, o ritmo do turno do
 * destino e o Testar sem efeito. O caminho com banco (nota, conversa grudada,
 * registro, turno do destino, laço, humano, destino sem versão, LGPD) está em
 * `tests/invariants/passagem-entre-agentes.test.ts`.
 */

const RECEPCAO = 'agent-recepcao';
const RAQUEL = 'agent-raquel';
const NEGADO = 'agent-negado';

function roteador(over: Partial<LoadedRouter> = {}): LoadedRouter {
  return {
    id: 'router-1',
    name: 'Bórbora',
    classifierModel: null,
    classifierProvider: null,
    sticky: true,
    minConfidence: 0.6,
    fallbackAgentId: RECEPCAO,
    members: [
      { agentId: RAQUEL, intentName: 'auxilio', intentDescription: 'auxílio-acidente', examples: [] },
      { agentId: NEGADO, intentName: 'beneficio_negado', intentDescription: 'benefício negado', examples: [] },
    ],
    ...over,
  };
}

const nomes = new Map([
  [RECEPCAO, 'Beatriz · Recepção'],
  [RAQUEL, 'Raquel'],
  [NEGADO, 'Especialista negado'],
]);

describe('destinosDaPassagem — a ferramenta só aparece onde faz sentido', () => {
  it('sem roteador ativo: não aparece', () => {
    expect(destinosDaPassagem(null, RAQUEL, nomes)).toBeNull();
  });

  it('agente fora do roteador (nem membro, nem reserva): não aparece', () => {
    expect(destinosDaPassagem(roteador(), 'agent-de-fora', nomes)).toBeNull();
  });

  it('membro: vê os outros membros, nunca a própria intenção', () => {
    const d = destinosDaPassagem(roteador(), RAQUEL, nomes)!;
    expect(d.map((x) => x.intencao)).toEqual(['beneficio_negado']);
    expect(d[0]!.agente).toBe('Especialista negado');
  });

  it('a reserva (Recepção) pode passar para todos os membros', () => {
    const d = destinosDaPassagem(roteador(), RECEPCAO, nomes)!;
    expect(d.map((x) => x.agentId)).toEqual([RAQUEL, NEGADO]);
  });

  it('roteador só com o próprio agente: não há para quem passar', () => {
    const so = roteador({ fallbackAgentId: null, members: [roteador().members[0]!] });
    expect(destinosDaPassagem(so, RAQUEL, nomes)).toBeNull();
  });
});

describe('o cartão de passagem — formato fixo, até 600 caracteres', () => {
  it('sempre as mesmas oito linhas, na mesma ordem; vazio vira "não informado"', () => {
    const c = formatarCartaoEntreAgentes({ nome_confirmado: 'Maria Souza' }, 'Categoria: CONFIRMADO');
    expect(c.split('\n').map((l) => l.split(':')[0])).toEqual([
      'Nome confirmado',
      'Quem fala',
      'Benefício e situação',
      'Qualificação',
      'Urgência',
      'O que falta',
      'Próximo passo',
      'Jeito do cliente',
    ]);
    expect(c).toContain('Nome confirmado: Maria Souza');
    expect(c).toContain('Qualificação: Categoria: CONFIRMADO');
    expect(c).toContain('Quem fala: não informado');
  });

  it('sem telefone, sem CID e sem nome de etiqueta', () => {
    const c = formatarCartaoEntreAgentes(
      {
        nome_confirmado: 'João (31) 99876-5432',
        beneficio_e_situacao: 'auxílio-acidente, CID M54.5, lead-antigo, negado em 2025',
        jeito_do_lead: 'manda áudio; contato +55 31 98765-4321',
      },
      '',
      ['lead-antigo', 'ja-cliente'],
    );
    expect(c).not.toMatch(/99876|98765|5432|4321/);
    expect(c).not.toMatch(/M54/);
    expect(c).not.toContain('lead-antigo');
    expect(c).toContain('negado em 2025');
  });

  it('nunca passa de 600 caracteres, mesmo com tudo comprido', () => {
    const longo = 'x'.repeat(160);
    const c = formatarCartaoEntreAgentes(
      {
        nome_confirmado: longo.slice(0, 80),
        quem_fala: longo.slice(0, 80),
        beneficio_e_situacao: longo,
        urgencia: longo.slice(0, 120),
        o_que_falta: longo,
        proximo_passo: longo.slice(0, 140),
        jeito_do_lead: longo.slice(0, 120),
      },
      `Campo A: CONFIRMADO; ${'Campo B: PENDENTE; '.repeat(30)}`,
    );
    expect(c.length).toBeLessThanOrEqual(TETO_DO_CARTAO);
    // o formato fica: todas as linhas continuam lá
    expect(c.split('\n')).toHaveLength(8);
  });

  it('a qualificação vem do negócio: só rótulo e status, nunca o dado', () => {
    const q = qualificacaoDoNegocio({
      settings: {
        fields: [
          { key: 'categoria', label: 'Categoria', type: 'text', com_status: true },
          { key: 'diagnostico', label: 'Laudo', type: 'text', com_status: true },
          { key: 'obs', label: 'Observação', type: 'text' },
        ],
      },
      status_dos_campos: { categoria: 'CONFIRMADO' },
    });
    expect(q).toBe('Categoria: CONFIRMADO; Laudo: PENDENTE');
    expect(qualificacaoDoNegocio(null)).toBe('');
  });

  it('o saneamento não toca no resto do texto', () => {
    expect(sanearTextoDoCartao('negado em 2025, recurso em março')).toBe('negado em 2025, recurso em março');
  });
});

describe('o payload do modelo — erro de regra vira ensino', () => {
  const destinos = destinosDaPassagem(roteador(), RECEPCAO, nomes)!;

  it('intenção fora da lista: ensina quais existem', () => {
    const r = validarPayloadDaPassagem({ intencao: 'inventada', motivo: 'x', cartao: {} }, destinos);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('auxilio');
  });

  it('campo a mais no cartão: recusa com a lista de campos', () => {
    const r = validarPayloadDaPassagem({ intencao: 'auxilio', motivo: 'x', cartao: { telefone: '31' } }, destinos);
    expect(r.ok).toBe(false);
  });

  it('motivo acima de 200 caracteres: recusa', () => {
    const r = validarPayloadDaPassagem({ intencao: 'auxilio', motivo: 'x'.repeat(201), cartao: {} }, destinos);
    expect(r.ok).toBe(false);
  });

  it('a definição que o modelo vê lista os destinos e proíbe telefone e diagnóstico', () => {
    const def = definicaoDaFerramentaDePassagem(destinos);
    expect(def.description).toContain('auxilio: Raquel');
    expect(def.description).toContain('NUNCA ponha telefone, diagnóstico');
  });
});

describe('o Testar — a ferramenta aparece e diz para quem passaria, sem efeito', () => {
  it('devolve "passaria para <agente>"', () => {
    const destinos = destinosDaPassagem(roteador(), RECEPCAO, nomes)!;
    const r = passagemNoTeste({ intencao: 'auxilio', motivo: 'confirmou o benefício', cartao: {} }, destinos);
    expect(r).toMatchObject({ ok: true, status: 'teste', para: 'Raquel' });
    if (r.ok) expect(r.message).toContain('passaria para Raquel');
  });
});

describe('o bloco de chegada — o que o destino lê', () => {
  const passagem: UltimaPassagem = {
    id: 'p1',
    deAgente: 'Beatriz · Recepção',
    paraAgenteId: RAQUEL,
    origem: 'ferramenta',
    motivo: 'confirmou o benefício',
    cartao: 'Nome confirmado: Maria',
    createdAt: new Date('2026-11-03T13:02:00Z'),
  };

  it('para o destino: quem passou, a hora no fuso e o cartão', () => {
    const b = blocoDeChegada(passagem, RAQUEL, 'America/Sao_Paulo');
    expect(b).toContain('(10h02)');
    expect(b).toContain('Beatriz · Recepção passou a conversa para você');
    expect(b).toContain('Nome confirmado: Maria');
  });

  it('para outro agente, ou passagem pela regra do roteador: nada', () => {
    expect(blocoDeChegada(passagem, NEGADO, 'America/Sao_Paulo')).toBe('');
    expect(blocoDeChegada({ ...passagem, origem: 'roteador' }, RAQUEL, 'America/Sao_Paulo')).toBe('');
    expect(blocoDeChegada(null, RAQUEL, 'America/Sao_Paulo')).toBe('');
  });

  it('devolução da equipe: a linha que a pessoa escreveu', () => {
    const b = blocoDeChegada(
      { ...passagem, origem: 'equipe', deAgente: null, cartao: 'confirmei os documentos' },
      RAQUEL,
      'America/Sao_Paulo',
    );
    expect(b).toContain('A equipe devolveu a conversa para você');
    expect(b).toContain('confirmei os documentos');
  });
});

describe('o turno do destino — fala primeiro, no ritmo', () => {
  it('espera 5 a 10 s depois do último envio; nunca mais que 15 s', () => {
    const agora = new Date('2026-11-03T13:00:10Z');
    const ultimo = new Date('2026-11-03T13:00:08Z');
    const min = esperaAntesDeFalar(ultimo, agora, 0);
    const max = esperaAntesDeFalar(ultimo, agora, 0.999);
    expect(min).toBe(ATRASO_MIN_MS - 2_000);
    expect(max).toBeLessThanOrEqual(ATRASO_MAX_MS - 2_000);
    expect(esperaAntesDeFalar(new Date(agora.getTime() + 60_000), agora, 0.5)).toBeLessThanOrEqual(ESPERA_MAX_MS);
    expect(esperaAntesDeFalar(new Date('2026-11-03T12:59:00Z'), agora, 0.5)).toBe(0);
    expect(esperaAntesDeFalar(null, agora, 0.5)).toBe(0);
  });

  it('só fala se a conversa segue com ele e ele ainda não respondeu', () => {
    const base = {
      id: 'p1',
      paraAgenteId: RAQUEL,
      intencao: 'auxilio',
      deAgente: 'Beatriz',
      destinoRespondeuEm: null,
      ativoDaConversa: RAQUEL,
      clienteEscreveuDepois: false,
    };
    expect(turnoDaPassagemTemOQueFazer(base)).toBe(true);
    expect(turnoDaPassagemTemOQueFazer({ ...base, ativoDaConversa: null })).toBe(false);
    expect(turnoDaPassagemTemOQueFazer({ ...base, destinoRespondeuEm: new Date() })).toBe(false);
    expect(turnoDaPassagemTemOQueFazer(null)).toBe(false);
  });

  it('a abertura diz que o cliente não escreveu nada novo e manda usar send_message', () => {
    const a = aberturaDoTurnoDaPassagem('Beatriz', ['## Checkpoint']);
    expect(a).toContain('Beatriz passou o atendimento para você');
    expect(a).toContain('O cliente NÃO escreveu nada novo');
    expect(a).toContain('send_message');
  });
});
