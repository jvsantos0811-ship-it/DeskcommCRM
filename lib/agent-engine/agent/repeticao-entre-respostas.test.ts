import { describe, expect, it } from 'vitest';

import {
  AJUSTES_PADRAO_DE_REPETICAO,
  clientePediuParaRepetir,
  cosseno,
  diceDePerguntas,
  erroDeEnsinoDaRepeticao,
  lerAjustesDeRepeticao,
  mensagemParecida,
  perguntaRepetida,
  perguntasDoTexto,
  semAPerguntaRepetida,
  LIMIAR_DE_PERGUNTA_SEM_EMBEDDING,
  type MensagemDaIa,
} from './repeticao-entre-respostas';

/**
 * PC-018 — a trava de repetição ENTRE turnos e no follow-up, nas partes puras.
 * O caminho com banco (histórico do contato, janela, exceção de "repete") está
 * em `tests/invariants/repeticao-entre-respostas.test.ts`.
 */

const msg = (body: string, over: Partial<MensagemDaIa> = {}): MensagemDaIa => ({
  id: Math.random().toString(36).slice(2),
  body,
  createdAt: new Date('2026-11-03T13:02:00Z'),
  respondida: false,
  respostaDoCliente: null,
  ...over,
});

const porTexto = async (a: string, b: string) => diceDePerguntas(a, b) >= LIMIAR_DE_PERGUNTA_SEM_EMBEDDING;

describe('ajustes da organização', () => {
  it('ausente ou inválido = ligada com o padrão (10 mensagens, 72 h, 0,8)', () => {
    expect(lerAjustesDeRepeticao(null)).toEqual(AJUSTES_PADRAO_DE_REPETICAO);
    expect(lerAjustesDeRepeticao({ conversa: { repeticao: { ligada: 'sim' } } })).toEqual(AJUSTES_PADRAO_DE_REPETICAO);
    expect(AJUSTES_PADRAO_DE_REPETICAO).toMatchObject({ ligada: true, janelaMensagens: 10, janelaHoras: 72, limiarTexto: 0.8 });
  });

  it('gravado e válido vale', () => {
    expect(
      lerAjustesDeRepeticao({
        conversa: {
          repeticao: { ligada: false, janela_mensagens: 5, janela_horas: 24, limiar_texto: 0.9, limiar_pergunta: 0.9 },
        },
      }),
    ).toEqual({ ligada: false, janelaMensagens: 5, janelaHoras: 24, limiarTexto: 0.9, limiarPergunta: 0.9 });
  });
});

describe('(a) mensagem parecida — Dice ≥ 0,8, com a exceção de informação nova', () => {
  const anteriores = [msg('Ainda estou aguardando a equipe confirmar o horário. Assim que tiver retorno, te aviso por aqui.')];

  it('"Ainda estou aguardando a equipe…" de novo: barrada', () => {
    expect(
      mensagemParecida('Ainda estou aguardando a equipe confirmar o horário. Assim que tiver retorno te aviso aqui.', anteriores, 0.8),
    ).not.toBeNull();
  });

  it('a frase repetida dentro de um parágrafo da candidata também é pega', () => {
    const c = 'Oi, Maria!\n\nAinda estou aguardando a equipe confirmar o horário. Assim que tiver retorno, te aviso por aqui.';
    expect(mensagemParecida(c, anteriores, 0.8)).not.toBeNull();
  });

  it('hora ou número diferente é informação nova: passa', () => {
    const a = [msg('Sua consulta está marcada para as 9h do dia 10.')];
    expect(mensagemParecida('Sua consulta está marcada para as 10h do dia 10.', a, 0.8)).toBeNull();
  });

  it('texto diferente passa', () => {
    expect(mensagemParecida('Me conta como foi o acidente, por favor.', anteriores, 0.8)).toBeNull();
  });
});

describe('(b) pergunta repetida', () => {
  it('as perguntas de um texto', () => {
    expect(perguntasDoTexto('Oi! Foi com você ou com alguém da família? E quando foi?')).toEqual([
      'Foi com você ou com alguém da família?',
      'E quando foi?',
    ]);
    expect(perguntasDoTexto('Entendi. Vou verificar.')).toEqual([]);
  });

  it('pergunta já RESPONDIDA: barrada, com a resposta do cliente no erro de ensino', async () => {
    const anteriores = [
      msg('Para seguir, posso usar dados de saúde seus? Você autoriza?', {
        respondida: true,
        respostaDoCliente: 'sim, pode',
      }),
    ];
    const r = await perguntaRepetida('Certo! Antes, você autoriza o uso dos seus dados de saúde?', anteriores, async () => true);
    expect(r?.tipo).toBe('pergunta_respondida');
    const ensino = erroDeEnsinoDaRepeticao(r!, 'America/Sao_Paulo', false);
    expect(ensino).toContain('às 10h02');
    expect(ensino).toContain('"sim, pode"');
    expect(ensino).toContain('siga para a próxima pergunta');
  });

  it('turno de resposta: 1 vez sem resposta ainda pode perguntar de novo; 2 vezes, não', async () => {
    const umaVez = [msg('Foi com você ou com alguém da família?')];
    expect(await perguntaRepetida('Foi com você ou com alguém da família?', umaVez, porTexto, 2)).toBeNull();
    const duasVezes = [...umaVez, msg('Foi com você ou com alguém da família?')];
    expect((await perguntaRepetida('Foi com você ou com alguém da família?', duasVezes, porTexto, 2))?.tipo).toBe(
      'pergunta_duas_vezes',
    );
  });

  it('régua de follow-up (cliente calado): a mesma pergunta não aparece 2 vezes', async () => {
    const umaVez = [msg('Foi com você ou com alguém da família?')];
    const r = await perguntaRepetida('Oi! Foi com você ou com alguém da família o acidente?', umaVez, porTexto, 1);
    expect(r?.tipo).toBe('pergunta_duas_vezes');
    expect(erroDeEnsinoDaRepeticao(r!, 'America/Sao_Paulo', true)).toContain('nesta retomada');
  });

  it('pergunta nova (sentido diferente): passa', async () => {
    const anteriores = [msg('Foi com você ou com alguém da família?', { respondida: true })];
    expect(await perguntaRepetida('Em que cidade você mora?', anteriores, porTexto)).toBeNull();
  });

  it('cosseno: vetores iguais = 1; ortogonais = 0', () => {
    expect(cosseno([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosseno([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosseno([0, 0], [1, 0])).toBe(0);
  });
});

describe('exceções e o que sai na segunda vez', () => {
  it('o cliente pediu para repetir: passa', () => {
    for (const t of ['não entendi, repete', 'Pode repetir?', 'manda de novo a lista', 'qual era a lista de documentos?', 'esqueci']) {
      expect(clientePediuParaRepetir(t), t).toBe(true);
    }
    for (const t of ['ok', 'sim, pode', 'foi comigo mesmo']) {
      expect(clientePediuParaRepetir(t), t).toBe(false);
    }
  });

  it('turno de resposta, reescrita que repetiu de novo: sai sem a pergunta repetida', () => {
    const r = { tipo: 'pergunta_respondida' as const, pergunta: 'Você autoriza o uso dos seus dados de saúde?', anterior: msg('x') };
    expect(semAPerguntaRepetida('Obrigada, Maria! Você autoriza o uso dos seus dados de saúde? Já vou te explicar o próximo passo.', r)).toBe(
      'Obrigada, Maria! Já vou te explicar o próximo passo.',
    );
    // Só a pergunta: sobra pouco — sai como veio (nunca sem resposta).
    expect(semAPerguntaRepetida('Você autoriza o uso dos seus dados de saúde?', r)).toBeNull();
  });
});
