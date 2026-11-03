import { describe, expect, it } from 'vitest';

import {
  acharFrasesProibidas,
  erroDeEnsinoDasFrases,
  FRASES_PADRAO,
  frasesProibidasSchema,
  lerFrasesProibidas,
  removerMuletas,
} from './frases-proibidas';

describe('PC-022 — a lista em vigor', () => {
  it('organização sem lista gravada usa a padrão (advocacia)', () => {
    expect(lerFrasesProibidas({})).toEqual([...FRASES_PADRAO]);
    expect(lerFrasesProibidas(null)).toEqual([...FRASES_PADRAO]);
    expect(FRASES_PADRAO).toEqual(
      expect.arrayContaining(['sem pressa', 'Anotado', 'Perfeito', 'Ótimo', 'Certo, então', 'não paga nada']),
    );
  });

  it('a lista gravada pelo admin vale; repetidas (sem diferença de acento e caixa) saem', () => {
    const settings = { conversa: { frases_proibidas: { lista: ['Perfeito', 'perfeito!', 'Sem compromisso'] } } };
    expect(lerFrasesProibidas(settings)).toEqual(['Perfeito', 'Sem compromisso']);
    expect(frasesProibidasSchema.safeParse({ lista: ['x'] }).success).toBe(false);
  });
});

describe('PC-022 — a busca ignora maiúscula, acento e pontuação, por palavra inteira', () => {
  it('"sem pressa" pega "sem pressa nenhuma" (o follow-up medido)', () => {
    expect(acharFrasesProibidas('Oi, Maria! Sem pressa nenhuma, tá? Quando puder me conta.', FRASES_PADRAO)).toEqual([
      'sem pressa',
    ]);
  });

  it('acento, caixa e pontuação não escondem a frase', () => {
    expect(acharFrasesProibidas('OBRIGADA PELA INFORMACAO!!', FRASES_PADRAO)).toEqual(['Obrigada pela informação']);
    expect(acharFrasesProibidas('certo então: qual a data?', FRASES_PADRAO)).toEqual(['Certo, então']);
  });

  it('palavra inteira: "Entendi" não pega "entendimento"', () => {
    expect(acharFrasesProibidas('Pelo meu entendimento, o prazo é de 30 dias.', FRASES_PADRAO)).toEqual([]);
  });

  it('mensagem sem frase proibida: nada achado (nenhuma chamada de modelo a mais)', () => {
    expect(acharFrasesProibidas('Em que cidade você mora?', FRASES_PADRAO)).toEqual([]);
  });

  it('admin tira "Ótimo" da lista → passa a sair normalmente', () => {
    const semOtimo = FRASES_PADRAO.filter((f) => f !== 'Ótimo');
    expect(acharFrasesProibidas('Ótimo! Vamos seguir.', FRASES_PADRAO)).toEqual(['Ótimo']);
    expect(acharFrasesProibidas('Ótimo! Vamos seguir.', semOtimo)).toEqual([]);
  });
});

describe('PC-022 — a muleta isolada sai; o resto, só o modelo reescreve', () => {
  it('"Perfeito! Em que cidade você mora?" → "Em que cidade você mora?"', () => {
    expect(removerMuletas('Perfeito! Em que cidade você mora?', ['Perfeito'])).toBe('Em que cidade você mora?');
  });

  it('muleta abrindo a frase com vírgula sai e a próxima letra vira maiúscula', () => {
    expect(removerMuletas('Entendi, então o acidente foi no trabalho?', ['Entendi'])).toBe(
      'Então o acidente foi no trabalho?',
    );
    expect(removerMuletas('Certo, então: qual a data do acidente?', ['Certo, então'])).toBe('Qual a data do acidente?');
    expect(removerMuletas('Obrigado por contar. Anotado! Agora me diga a cidade.', ['Anotado'])).toBe(
      'Obrigado por contar. Agora me diga a cidade.',
    );
  });

  it('frase no meio do texto não é muleta: null (sai como está e fica contada)', () => {
    expect(removerMuletas('Isso é perfeito para o seu caso, Maria.', ['Perfeito'])).toBeNull();
    expect(removerMuletas('Perfeito para você, Maria.', ['Perfeito'])).toBeNull();
    expect(removerMuletas('Fique sem pressa nenhuma para responder.', ['sem pressa'])).toBeNull();
  });

  it('só a muleta e nada mais: null', () => {
    expect(removerMuletas('Perfeito!', ['Perfeito'])).toBeNull();
  });

  it('o erro de ensino diz o que tirar e que a mensagem não saiu', () => {
    const e = erroDeEnsinoDasFrases(['sem pressa']);
    expect(e).toContain('"sem pressa"');
    expect(e).toContain('NÃO foi enviada');
  });
});
