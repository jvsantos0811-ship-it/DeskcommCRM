import { describe, expect, it, vi } from 'vitest';

import {
  aplicarBlocoNaDescricao,
  atualizarResumoDoCard,
  ehDadoDeDocumento,
  FIM_DO_BLOCO,
  lerLinhasDoModelo,
  montarBloco,
  normalizarPerguntasDoResumo,
  quandoDoResumo,
  rotuloDeDocumento,
  sanearLinhaDoResumo,
  TETO_DO_BLOCO,
} from './resumo-do-card';

/**
 * PC-026 (item 2): o bloco "Resumo da IA" na descrição do card — só as
 * respostas às perguntas do agente, o texto da equipe intacto, nada de
 * documento nem de diagnóstico, e no máximo UMA chamada de IA por momento.
 */

const PERGUNTAS = ['Já teve o bebê', 'Data do parto', 'Carteira na data do parto', 'Pagou o INSS', 'Pediu no INSS'];

describe('a descrição: o bloco é trocado inteiro, o resto é da equipe', () => {
  const bloco1 = montarBloco(['Já teve o bebê: sim'], '10/11 14:32');
  const bloco2 = montarBloco(['Já teve o bebê: sim', 'Data do parto: março de 2026'], '10/11 15:00');

  it('descrição vazia: só o bloco', () => {
    expect(aplicarBlocoNaDescricao(null, bloco1)).toBe(bloco1);
  });

  it('⭐ descrição da equipe sem bloco: o bloco entra no começo e o texto fica idêntico', () => {
    const equipe = 'Cliente prefere ligação à tarde.\nIndicação da Dra. Paula.';
    const nova = aplicarBlocoNaDescricao(equipe, bloco1);
    expect(nova.startsWith(bloco1)).toBe(true);
    expect(nova.endsWith(equipe)).toBe(true);
  });

  it('⭐ com bloco: troca SÓ o bloco, e o texto da equipe (antes e depois) não muda', () => {
    const equipe = 'Cliente prefere ligação à tarde.';
    const primeira = aplicarBlocoNaDescricao(equipe, bloco1);
    const segunda = aplicarBlocoNaDescricao(primeira, bloco2);
    expect(segunda).toBe(`${bloco2}\n\n${equipe}`);
    expect(segunda.match(/=== Resumo da IA/g)).toHaveLength(1);
    expect(segunda.match(new RegExp(FIM_DO_BLOCO, 'g'))).toHaveLength(1);
  });

  it('o bloco nunca passa de 600 caracteres: corta linhas, nunca o rodapé', () => {
    const linhas = Array.from({ length: 20 }, (_, i) => `Pergunta número ${i}: resposta bem comprida do cliente aqui`);
    const b = montarBloco(linhas, '10/11 14:32');
    expect(b.length).toBeLessThanOrEqual(TETO_DO_BLOCO);
    expect(b.endsWith(FIM_DO_BLOCO)).toBe(true);
    expect(b.startsWith('=== Resumo da IA · atualizado em 10/11 14:32 ===')).toBe(true);
  });

  it('a hora sai no fuso da organização', () => {
    expect(quandoDoResumo(new Date('2026-11-10T17:32:00Z'), 'America/Sao_Paulo')).toBe('10/11 14:32');
  });
});

describe('a linha: LGPD antes de tudo', () => {
  it('⭐ CPF, RG, endereço, CEP e data de nascimento nunca entram — nem pela pergunta, nem pela resposta', () => {
    expect(sanearLinhaDoResumo('CPF', '529.982.247-25')).toBeNull();
    expect(sanearLinhaDoResumo('Endereço', 'Rua das Flores, 10')).toBeNull();
    expect(sanearLinhaDoResumo('Data de nascimento', '01/02/1990')).toBeNull();
    expect(sanearLinhaDoResumo('Documento', 'meu cpf é 52998224725')).toBeNull();
    expect(sanearLinhaDoResumo('Onde mora', 'CEP 30140-071')).toBeNull();
  });

  it('⭐ saúde vira só sim/não/informado: nada de doença, CID ou remédio', () => {
    expect(sanearLinhaDoResumo('Tem laudo', 'sim, de depressão, CID F32')).toBe('Tem laudo: sim');
    const linha = sanearLinhaDoResumo('Afastamento', 'afastada por hérnia de disco, toma dipirona');
    expect(linha).toBe('Afastamento: informado');
  });

  it('telefone e nome de etiqueta saem; resposta longa vira 60 caracteres', () => {
    const l = sanearLinhaDoResumo('Pediu no INSS', 'pediu em maio, ligar 31 99876-1234 lead-quente', ['lead-quente']);
    expect(l).not.toMatch(/9876|lead-quente/);
    const longa = sanearLinhaDoResumo('Data do parto', 'x'.repeat(200))!;
    expect(longa.length).toBeLessThanOrEqual('Data do parto: '.length + 60);
  });
});

describe('o que o modelo devolve', () => {
  it('só perguntas da lista, na ordem da lista, sem acento ou caixa importando', () => {
    const texto = JSON.stringify({
      linhas: [
        { pergunta: 'data do parto', resposta: 'março de 2026' },
        { pergunta: 'Pergunta que não está na lista', resposta: 'inventada' },
        { pergunta: 'JA TEVE O BEBE', resposta: 'sim' },
        { pergunta: 'Pagou o INSS', resposta: '' },
      ],
    });
    expect(lerLinhasDoModelo(texto, PERGUNTAS)).toEqual([
      { pergunta: 'Já teve o bebê', resposta: 'sim' },
      { pergunta: 'Data do parto', resposta: 'março de 2026' },
    ]);
  });

  it('lista do agente: limpa, sem repetida, até 15', () => {
    expect(normalizarPerguntasDoResumo([' Já teve o bebê ', 'já teve o bebê', '', 3, 'Data do parto'])).toEqual([
      'Já teve o bebê',
      'Data do parto',
    ]);
    expect(normalizarPerguntasDoResumo(Array.from({ length: 30 }, (_, i) => `P${i}`))).toHaveLength(15);
  });
});

/**
 * PC-038: o filtro largo demais apagava fato que qualifica. Nome de benefício
 * não é saúde, a data do parto não é documento, saúde tem três valores
 * honestos (e guarda a data), e o rótulo sem o parêntese final ainda casa.
 * Textos inventados; nenhum dado de lead real.
 */
describe('PC-038 — nome de benefício do INSS não é dado de saúde', () => {
  it('⭐ "Benefício negado: auxílio-doença" fica com o nome do benefício', () => {
    expect(sanearLinhaDoResumo('Benefício negado', 'auxílio-doença')).toBe('Benefício negado: auxílio-doença');
  });

  it('a lista fechada: auxílio por incapacidade, aposentadoria por invalidez, BPC da pessoa com deficiência', () => {
    expect(sanearLinhaDoResumo('Benefício que busca', 'auxílio por incapacidade temporária')).toBe(
      'Benefício que busca: auxílio por incapacidade temporária',
    );
    expect(sanearLinhaDoResumo('Benefício que busca', 'aposentadoria por invalidez')).toBe(
      'Benefício que busca: aposentadoria por invalidez',
    );
    expect(sanearLinhaDoResumo('Recebe benefício hoje', 'Aposentadoria por incapacidade permanente')).toBe(
      'Recebe benefício hoje: Aposentadoria por incapacidade permanente',
    );
    expect(sanearLinhaDoResumo('Assunto (benefício ou área)', 'BPC da pessoa com deficiência')).toBe(
      'Assunto (benefício ou área): BPC da pessoa com deficiência',
    );
    expect(sanearLinhaDoResumo('Auxílio do INSS antes', 'sim, auxilio doenca em 2022')).toBe(
      'Auxílio do INSS antes: sim, auxilio doenca em 2022',
    );
  });

  it('⭐ diagnóstico, CID e remédio ao lado do nome do benefício continuam saindo', () => {
    expect(sanearLinhaDoResumo('Benefício negado', 'auxílio-doença por depressão')).toBe('Benefício negado: informado');
    expect(sanearLinhaDoResumo('Benefício que busca', 'auxílio-doença, CID M54')).toBe('Benefício que busca: informado');
    expect(sanearLinhaDoResumo('Benefício negado', 'aposentadoria por invalidez, tomo sertralina')).toBe(
      'Benefício negado: informado',
    );
    // Outra doença que não é nome de benefício segue sendo saúde.
    expect(sanearLinhaDoResumo('Benefício negado', 'por causa da doença')).toBe('Benefício negado: informado');
  });
});

describe('PC-038 — data de nascimento: da pessoa sai, do bebê fica', () => {
  const AGORA = new Date('2026-11-12T15:00:00Z');

  it('⭐ "Data do parto ou adoção: nasceu em 10/03/2026" mantém a data', () => {
    expect(sanearLinhaDoResumo('Data do parto ou adoção', 'nasceu em 10/03/2026', [], AGORA)).toBe(
      'Data do parto ou adoção: nasceu em 10/03/2026',
    );
  });

  it('rótulo de parto, bebê, filho ou adoção mantém "já nasceu" e a data', () => {
    expect(sanearLinhaDoResumo('Grávida ou já teve o bebê', 'já nasceu', [], AGORA)).toBe('Grávida ou já teve o bebê: já nasceu');
    expect(sanearLinhaDoResumo('Outro filho em 5 anos', 'sim, nasceu em 2023', [], AGORA)).toBe(
      'Outro filho em 5 anos: sim, nasceu em 2023',
    );
    expect(sanearLinhaDoResumo('Data de nascimento do bebê', '02/09/2026', [], AGORA)).toBe(
      'Data de nascimento do bebê: 02/09/2026',
    );
  });

  it('⭐ "Data de nascimento: 10/03/1990" continua fora; CPF, RG, CEP e endereço também', () => {
    expect(sanearLinhaDoResumo('Data de nascimento', '10/03/1990', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('CPF', '529.982.247-25', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('RG', 'MG-12.345.678', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Documento', 'meu RG é 12.345.678-9', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Onde mora', 'CEP 30140-071', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Endereço', 'Rua das Acácias, 45', [], AGORA)).toBeNull();
    // Nem o rótulo de parto deixa passar documento.
    expect(sanearLinhaDoResumo('Data do parto ou adoção', 'nasceu dia 10/03, meu cpf 529.982.247-25', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Data do parto ou adoção', 'nasceu dia 10/03, moro na rua B', [], AGORA)).toBeNull();
  });

  it('⭐ "nasci em 12/03/1960" (1ª pessoa) sai em qualquer rótulo — e idade respondida com data antiga também', () => {
    expect(sanearLinhaDoResumo('Idade de quem pede (anos)', 'nasci em 12/03/1960', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Data do parto ou adoção', 'eu nasci em 1990, o bebê em março', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Idade de quem pede (anos)', '12/03/1960', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Idade de quem pede (anos)', '64 anos', [], AGORA)).toBe('Idade de quem pede (anos): 64 anos');
  });

  it('fora do rótulo de parto: "nasceu" com ano de até hoje − 14 é a pessoa (sai); com ano recente é o bebê (fica)', () => {
    expect(sanearLinhaDoResumo('Quem fala', 'a filha, a mãe nasceu em 15/04/1955', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Idoso ou deficiência', 'idoso, nascido em março de 1950', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Quem fala', 'a mãe; o bebê nasceu em 10/03/2026', [], AGORA)).toBe(
      'Quem fala: a mãe; o bebê nasceu em 10/03/2026',
    );
    // O corte é hoje − 14: 2012 sai, 2013 fica (com "agora" em 2026).
    expect(ehDadoDeDocumento('Situação', 'nasceu em 2012', AGORA)).toBe(true);
    expect(ehDadoDeDocumento('Situação', 'nasceu em 2013', AGORA)).toBe(false);
  });

  it('data antiga sem fala de nascimento ou idade fica ("Data do acidente: 15/06/2009")', () => {
    expect(sanearLinhaDoResumo('Data do acidente', '15/06/2009', [], AGORA)).toBe('Data do acidente: 15/06/2009');
    expect(sanearLinhaDoResumo('Última contribuição', 'março de 2008', [], AGORA)).toBe('Última contribuição: março de 2008');
  });

  it('o tema (registro e campo do funil) segue a mesma regra antes de ir ao modelo', () => {
    expect(rotuloDeDocumento('data de nascimento')).toBe(true);
    expect(rotuloDeDocumento('data_nascimento Data de nascimento')).toBe(true);
    expect(rotuloDeDocumento('nascimento do bebê')).toBe(false);
    expect(rotuloDeDocumento('data_nascimento_bebe Data de nascimento do bebê')).toBe(false);
    expect(rotuloDeDocumento('ano em que nasci')).toBe(true);
    expect(rotuloDeDocumento('cpf do bebê')).toBe(true);
  });
});

describe('PC-038 — saúde em três valores honestos, com a data quando há', () => {
  it('⭐ "Prazo ou data marcada: perícia dia 20/11" → "sim · 20/11"', () => {
    expect(sanearLinhaDoResumo('Prazo ou data marcada', 'perícia dia 20/11')).toBe('Prazo ou data marcada: sim · 20/11');
  });

  it('a data sai sem o nome de doença em volta', () => {
    expect(sanearLinhaDoResumo('Tem laudo', 'laudo de março')).toBe('Tem laudo: informado · março');
    expect(sanearLinhaDoResumo('Prazo ou data marcada', 'perícia por causa da hérnia dia 20/11/2026')).toBe(
      'Prazo ou data marcada: sim · 20/11/2026',
    );
    expect(sanearLinhaDoResumo('Afastado mais de 60 dias', 'sim, afastada desde 10 de agosto, fratura no braço')).toBe(
      'Afastado mais de 60 dias: sim · 10 de agosto',
    );
  });

  it('⭐ "não consigo…" afirma a limitação; "não sei" é dúvida; "não tenho" é não', () => {
    expect(sanearLinhaDoResumo('Sequela (sim/não)', 'não consigo pegar peso')).toBe('Sequela (sim/não): sim');
    expect(sanearLinhaDoResumo('Tem laudo', 'não sei')).toBe('Tem laudo: não sabe');
    expect(sanearLinhaDoResumo('Tem laudo', 'não tenho')).toBe('Tem laudo: não');
  });

  it('mais formas: "não posso", "acho que", "nunca", "não lembro"', () => {
    expect(sanearLinhaDoResumo('Sequela (sim/não)', 'não posso mais trabalhar em pé')).toBe('Sequela (sim/não): sim');
    expect(sanearLinhaDoResumo('Tem laudo', 'acho que sim')).toBe('Tem laudo: não sabe');
    expect(sanearLinhaDoResumo('Tem laudo', 'acho que não')).toBe('Tem laudo: não sabe');
    expect(sanearLinhaDoResumo('Afastado mais de 60 dias', 'nunca')).toBe('Afastado mais de 60 dias: não');
    expect(sanearLinhaDoResumo('Tem laudo', 'não lembro')).toBe('Tem laudo: não sabe');
    expect(sanearLinhaDoResumo('Sequela (sim/não)', 'não, fiquei bem')).toBe('Sequela (sim/não): não');
  });

  it('⭐ "fratura", "depressão", CID e remédio continuam virando sim/não/informado', () => {
    expect(sanearLinhaDoResumo('Acidente (sim/não)', 'sim, fratura na perna')).toBe('Acidente (sim/não): sim');
    expect(sanearLinhaDoResumo('Tem laudo', 'sim, de depressão, CID F32')).toBe('Tem laudo: sim');
    expect(sanearLinhaDoResumo('Gastos com saúde', 'dipirona e insulina todo mês')).toBe('Gastos com saúde: informado');
    expect(sanearLinhaDoResumo('Deficiência ou doença há 2 anos', 'não, a fratura foi esse ano')).toBe(
      'Deficiência ou doença há 2 anos: não',
    );
    for (const l of [
      sanearLinhaDoResumo('Já teve alta', 'ainda não, tomo fluoxetina 20mg'),
      sanearLinhaDoResumo('O que aconteceu', 'fratura exposta, CID S82'),
    ]) {
      expect(l).not.toMatch(/fratura|fluoxetina|20mg|S82|CID/i);
    }
  });
});

describe('PC-038 — o rótulo sem o parêntese final ainda casa', () => {
  it('⭐ {"pergunta": "Sequela"} casa com "Sequela (sim/não)"', () => {
    const texto = JSON.stringify({ linhas: [{ pergunta: 'Sequela', resposta: 'sim' }] });
    expect(lerLinhasDoModelo(texto, ['Sequela (sim/não)'])).toEqual([{ pergunta: 'Sequela (sim/não)', resposta: 'sim' }]);
  });

  it('vale nos dois sentidos e com parêntese diferente', () => {
    const texto = JSON.stringify({
      linhas: [
        { pergunta: 'Idade de quem pede', resposta: '64 anos' },
        { pergunta: 'Assunto (área)', resposta: 'BPC' },
      ],
    });
    expect(lerLinhasDoModelo(texto, ['Assunto (benefício ou área)', 'Idade de quem pede (anos)'])).toEqual([
      { pergunta: 'Assunto (benefício ou área)', resposta: 'BPC' },
      { pergunta: 'Idade de quem pede (anos)', resposta: '64 anos' },
    ]);
  });

  it('⭐ se casar com dois rótulos, não casa nenhum', () => {
    const texto = JSON.stringify({ linhas: [{ pergunta: 'Sequela', resposta: 'sim' }] });
    expect(lerLinhasDoModelo(texto, ['Sequela (sim/não)', 'Sequela (desde quando)'])).toEqual([]);
  });

  it('o rótulo idêntico vence o curto', () => {
    const texto = JSON.stringify({
      linhas: [
        { pergunta: 'Sequela', resposta: 'resposta do curto' },
        { pergunta: 'Sequela (sim/não)', resposta: 'resposta do idêntico' },
      ],
    });
    expect(lerLinhasDoModelo(texto, ['Sequela (sim/não)'])).toEqual([
      { pergunta: 'Sequela (sim/não)', resposta: 'resposta do idêntico' },
    ]);
  });
});

/**
 * PC-038, revisão independente: a primeira versão abria brecha de LGPD (nome
 * do benefício levando um diagnóstico que a lista do código não conhece) e
 * dava "sim" onde a resposta não disse sim. Textos inventados.
 */
describe('PC-038 (revisão) — o nome do benefício só passa sozinho', () => {
  it('⭐ LINHA VERMELHA: doença fora da lista ao lado do benefício continua saúde ("informado")', () => {
    expect(sanearLinhaDoResumo('Benefício negado', 'auxílio-doença por fibromialgia')).toBe('Benefício negado: informado');
    expect(
      sanearLinhaDoResumo('Benefício que busca', 'auxílio por incapacidade temporária por causa do lúpus'),
    ).toBe('Benefício que busca: informado');
    expect(sanearLinhaDoResumo('Recebe benefício hoje', 'aposentadoria por invalidez, tenho Parkinson')).toBe(
      'Recebe benefício hoje: informado',
    );
  });

  it('⭐ "auxílio-doença" sozinho e "auxílio-doença, negado em março" passam', () => {
    expect(sanearLinhaDoResumo('Benefício negado', 'auxílio-doença')).toBe('Benefício negado: auxílio-doença');
    expect(sanearLinhaDoResumo('Benefício negado', 'auxílio-doença, negado em março')).toBe(
      'Benefício negado: auxílio-doença, negado em março',
    );
    expect(sanearLinhaDoResumo('Benefício negado', 'auxílio-doença indeferido em 10/2025, em análise')).toBe(
      'Benefício negado: auxílio-doença indeferido em 10/2025, em análise',
    );
    expect(sanearLinhaDoResumo('Benefício negado', 'sim, auxílio-doença cortado em 2024')).toBe(
      'Benefício negado: sim, auxílio-doença cortado em 2024',
    );
  });
});

describe('PC-038 (revisão) — "não consigo" só é "sim" em rótulo de limitação', () => {
  it('⭐ "Tem laudo: não consegui o laudo" → "não"', () => {
    expect(sanearLinhaDoResumo('Tem laudo', 'não consegui o laudo')).toBe('Tem laudo: não');
    // Frase de limitação que não responde o rótulo não vira "não" pela primeira palavra.
    expect(sanearLinhaDoResumo('Tem laudo', 'não consigo marcar o médico')).toBe('Tem laudo: informado');
  });

  it('rótulo de limitação afirma; rótulo de capacidade afirmada não inverte', () => {
    expect(sanearLinhaDoResumo('Sequela (sim/não)', 'não consigo pegar peso')).toBe('Sequela (sim/não): sim');
    expect(sanearLinhaDoResumo('Dificuldade no trabalho', 'não posso ficar em pé, por causa da coluna')).toBe(
      'Dificuldade no trabalho: sim',
    );
    expect(sanearLinhaDoResumo('Não consegue trabalhar (sim/não)', 'não consigo, a coluna travou')).toBe(
      'Não consegue trabalhar (sim/não): sim',
    );
    expect(sanearLinhaDoResumo('Consegue trabalhar (sim/não)', 'não consigo, a coluna travou')).toBe(
      'Consegue trabalhar (sim/não): não',
    );
    // Passado de uma vez ("não consegui…") não afirma nem nega: informado, nunca um "não" falso.
    expect(sanearLinhaDoResumo('Sequela (sim/não)', 'não consegui fazer o exame')).toBe('Sequela (sim/não): informado');
    expect(sanearLinhaDoResumo('Sequela (sim/não)', 'não consegui voltar a trabalhar')).toBe(
      'Sequela (sim/não): informado',
    );
  });

  it('⭐ (2ª revisão) limitação fora do rótulo não vira "não" falso', () => {
    expect(sanearLinhaDoResumo('Afastado mais de 60 dias', 'não consigo trabalhar desde março')).toBe(
      'Afastado mais de 60 dias: informado · março',
    );
    expect(sanearLinhaDoResumo('Deficiência ou doença há 2 anos', 'não consigo andar faz 5 anos')).toBe(
      'Deficiência ou doença há 2 anos: informado',
    );
    expect(sanearLinhaDoResumo('Afastado mais de 60 dias', 'não, voltei a trabalhar')).toBe('Afastado mais de 60 dias: não');
  });

  it('⭐ "nunca mais consegui pegar peso": em rótulo de limitação é "sim"; fora dele, "informado"', () => {
    expect(sanearLinhaDoResumo('Sequela (sim/não)', 'nunca mais consegui pegar peso')).toBe('Sequela (sim/não): sim');
    expect(sanearLinhaDoResumo('Afastado mais de 60 dias', 'nunca mais consegui trabalhar')).toBe(
      'Afastado mais de 60 dias: informado',
    );
    expect(sanearLinhaDoResumo('Afastado mais de 60 dias', 'nunca')).toBe('Afastado mais de 60 dias: não');
  });
});

describe('PC-038 (revisão) — data sozinha não é "sim"', () => {
  it('⭐ "Tem laudo: ainda não, consulta dia 20/11" → "não"', () => {
    expect(sanearLinhaDoResumo('Tem laudo', 'ainda não, consulta dia 20/11')).toBe('Tem laudo: não');
  });

  it('⭐ "Sequela: fiquei bem… dia 10" → "informado · dia 10"', () => {
    expect(sanearLinhaDoResumo('Sequela (sim/não)', 'fiquei bem, voltei ao médico dia 10')).toBe(
      'Sequela (sim/não): informado · dia 10',
    );
  });

  it('"sim · data" só quando a resposta diz sim ou o rótulo pergunta data/prazo', () => {
    expect(sanearLinhaDoResumo('Tem laudo', 'sim, laudo de março')).toBe('Tem laudo: sim · março');
    expect(sanearLinhaDoResumo('Prazo ou data marcada', 'perícia dia 20/11')).toBe('Prazo ou data marcada: sim · 20/11');
    expect(sanearLinhaDoResumo('Data da perícia', 'a perícia é em 05/12')).toBe('Data da perícia: sim · 05/12');
    expect(sanearLinhaDoResumo('Quando foi a perícia', 'em agosto')).toBe('Quando foi a perícia: sim · agosto');
  });
});

describe('PC-038 (revisão) — rótulo de identidade ou idade: ano solto é nascimento', () => {
  const AGORA = new Date('2026-11-12T15:00:00Z');

  it('⭐ "sou de 1960", "é de 15/04/1955", "nasceu em 55" → a linha cai', () => {
    expect(sanearLinhaDoResumo('Idade de quem pede (anos)', 'sou de 1960', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Idoso ou deficiência', 'idoso, é de 15/04/1955', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Quem fala', 'a filha; a mãe nasceu em 55', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Titular do benefício', 'o pai, que é de 48', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Situação', 'a mãe nasceu em 55', [], AGORA)).toBeNull();
    // 2ª revisão: ano de dois dígitos depois de separador de data ou de "ano".
    expect(sanearLinhaDoResumo('Idade de quem pede (anos)', '66 anos, 04/58', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Idade de quem pede (anos)', '15.04.55', [], AGORA)).toBeNull();
    expect(sanearLinhaDoResumo('Quem fala', 'eu, ano 58', [], AGORA)).toBeNull();
    // O separador só vale em rótulo de identidade: data de saída perto de "nascer" fica.
    expect(sanearLinhaDoResumo('Saída do último emprego', 'saí antes do bebê nascer, em 05/09', [], AGORA)).toBe(
      'Saída do último emprego: saí antes do bebê nascer, em 05/09',
    );
  });

  it('⭐ "Quem fala: filha, pelo pai de 58 anos" continua passando', () => {
    expect(sanearLinhaDoResumo('Quem fala', 'filha, pelo pai de 58 anos', [], AGORA)).toBe('Quem fala: filha, pelo pai de 58 anos');
    expect(sanearLinhaDoResumo('Idoso ou deficiência', 'idoso, 70 anos', [], AGORA)).toBe('Idoso ou deficiência: idoso, 70 anos');
    expect(sanearLinhaDoResumo('Quem fala', 'a mãe, vai ao INSS em 05 de março', [], AGORA)).toBe(
      'Quem fala: a mãe, vai ao INSS em 05 de março',
    );
  });

  it('"Data do acidente", "Última contribuição" e "Quando negou" continuam com o ano', () => {
    expect(sanearLinhaDoResumo('Data do acidente', 'em 2009', [], AGORA)).toBe('Data do acidente: em 2009');
    expect(sanearLinhaDoResumo('Última contribuição', '2008', [], AGORA)).toBe('Última contribuição: 2008');
    expect(sanearLinhaDoResumo('Quando negou', 'em 2010', [], AGORA)).toBe('Quando negou: em 2010');
  });
});

// ─── O caminho inteiro, com um banco de mentira ──────────────────────────────

interface Estado {
  description: string | null;
  updates: number;
}

function bancoFalso(estado: Estado, registro: Array<{ tema: string; resposta: string | null }>) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('from crm_leads l')) {
        return {
          rows: [
            {
              id: 'lead-1',
              description: estado.description,
              custom_fields: { cpf: '52998224725', ja_teve_bebe: 'sim' },
              status_dos_campos: { cpf: 'CONFIRMADO', ja_teve_bebe: 'CONFIRMADO' },
              tags: [],
              settings: {
                fields: [
                  { key: 'cpf', label: 'CPF', type: 'text', com_status: true },
                  { key: 'ja_teve_bebe', label: 'Já teve o bebê', type: 'text', com_status: true },
                ],
              },
            },
          ],
        };
      }
      if (sql.includes('from registro_da_conversa')) {
        return {
          rows: registro.map((r, i) => ({
            id: `r${i}`,
            tipo: 'pergunta',
            tema: r.tema,
            chave: r.tema,
            status: r.resposta ? 'respondida' : 'pendente',
            pergunta: null,
            resposta: r.resposta,
            prazo: null,
            vezes: 1,
            agent_id: null,
            conversation_id: null,
            job_id: null,
            criado_em: new Date(),
            atualizado_em: new Date(),
            resolvido_em: null,
          })),
        };
      }
      if (sql.startsWith('update crm_leads') || sql.includes('update crm_leads set description')) {
        if (params?.[3] !== estado.description) return { rows: [] };
        estado.description = params?.[2] as string;
        estado.updates += 1;
        return { rows: [{ id: 'lead-1' }] };
      }
      return { rows: [] };
    }),
  };
}

describe('atualizarResumoDoCard', () => {
  it('⭐ sem perguntas no agente: nenhuma chamada de IA e nada escrito', async () => {
    const estado: Estado = { description: 'texto da equipe', updates: 0 };
    const chamarModelo = vi.fn(async () => '{}');
    const r = await atualizarResumoDoCard(bancoFalso(estado, []) as never, {
      organizationId: 'org',
      contactId: 'c',
      perguntas: [],
      fuso: 'America/Sao_Paulo',
      chamarModelo,
    });
    expect(r.status).toBe('sem_perguntas');
    expect(chamarModelo).not.toHaveBeenCalled();
    expect(estado.description).toBe('texto da equipe');
  });

  it('⭐ 5 perguntas, 3 respondidas → bloco com 3 linhas, UMA chamada, e o CPF nem chega ao modelo', async () => {
    const estado: Estado = { description: 'Cliente prefere ligação à tarde.', updates: 0 };
    const chamarModelo = vi.fn(async (_s: string, mensagem: string) => {
      expect(mensagem).not.toMatch(/52998224725|CPF/);
      return JSON.stringify({
        linhas: [
          { pergunta: 'Já teve o bebê', resposta: 'sim' },
          { pergunta: 'Data do parto', resposta: 'março de 2026' },
          { pergunta: 'Pediu no INSS', resposta: 'não pediu ainda' },
        ],
      });
    });
    const r = await atualizarResumoDoCard(
      bancoFalso(estado, [
        { tema: 'data do parto', resposta: 'foi em março de 2026' },
        { tema: 'pedido no INSS', resposta: 'ainda não pedi' },
        { tema: 'pagou INSS', resposta: null },
      ]) as never,
      {
        organizationId: 'org',
        contactId: 'c',
        perguntas: PERGUNTAS,
        fuso: 'America/Sao_Paulo',
        agora: new Date('2026-11-10T17:32:00Z'),
        chamarModelo,
      },
    );
    expect(r).toEqual({ status: 'atualizado', leadId: 'lead-1', linhas: 3 });
    expect(chamarModelo).toHaveBeenCalledTimes(1);
    expect(estado.description).toBe(
      [
        '=== Resumo da IA · atualizado em 10/11 14:32 ===',
        'Já teve o bebê: sim',
        'Data do parto: março de 2026',
        'Pediu no INSS: não pediu ainda',
        '=== fim do resumo ===',
        '',
        'Cliente prefere ligação à tarde.',
      ].join('\n'),
    );
  });

  it('sem nenhuma resposta para resumir: nenhuma chamada', async () => {
    const estado: Estado = { description: null, updates: 0 };
    const chamarModelo = vi.fn(async () => '{}');
    const banco = bancoFalso(estado, [{ tema: 'data do parto', resposta: null }]);
    // Sem campo confirmado útil (o único confirmado é documento).
    banco.query.mockImplementationOnce(async () => ({
      rows: [{ id: 'lead-1', description: null, custom_fields: {}, status_dos_campos: {}, tags: [], settings: {} }],
    }));
    const r = await atualizarResumoDoCard(banco as never, {
      organizationId: 'org',
      contactId: 'c',
      perguntas: PERGUNTAS,
      fuso: 'America/Sao_Paulo',
      chamarModelo,
    });
    expect(r.status).toBe('sem_respostas');
    expect(chamarModelo).not.toHaveBeenCalled();
  });
});
