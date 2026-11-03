import { describe, expect, it } from 'vitest';

import {
  chaveDoTema,
  ehDeSaude,
  lerRegistroDoFechamento,
  mesclarRegistro,
  perguntasRespondidas,
  promessaDaEquipe,
  REGISTRO_INSTRUCTION,
  renderRegistro,
  sanearItem,
  sanearTexto,
  statusEfetivo,
  TETO_DO_BLOCO,
  type ItemDoRegistro,
} from './registro-da-conversa';
import { CHECKPOINT_INSTRUCTION, checkpointContentSchema } from './abertura/checkpoint';
import { diceDePerguntas, perguntaJaRespondidaNoRegistro } from './repeticao-entre-respostas';

const FUSO = 'America/Sao_Paulo';
// 03/11/2026 10h02 em São Paulo (UTC-3).
const AS_10H02 = new Date('2026-11-03T13:02:00Z');
const ctx = (agora: Date) => ({ agora, agentId: 'agente-recepcao', conversationId: 'conv-1', jobId: 'job-1' });

/** Mescla e "grava" (dá id aos novos), como o banco faria. */
function aplicar(atuais: ItemDoRegistro[], ...args: Parameters<typeof mesclarRegistro> extends [unknown, ...infer R] ? R : never) {
  const mudados = mesclarRegistro(atuais, ...args);
  const porChave = new Map(atuais.map((i) => [`${i.tipo}:${i.chave}`, i]));
  let n = atuais.length;
  for (const m of mudados) porChave.set(`${m.tipo}:${m.chave}`, { ...m, id: m.id ?? `item-${++n}` });
  return [...porChave.values()];
}

describe('PC-019 — o fechamento pede e aceita o registro', () => {
  it('a instrução do fechamento pede o campo "registro", sem chamada nova de modelo', () => {
    expect(CHECKPOINT_INSTRUCTION).toContain(REGISTRO_INSTRUCTION);
    expect(CHECKPOINT_INSTRUCTION).toContain('"registro"');
    expect(CHECKPOINT_INSTRUCTION).toContain('Sem texto fora do JSON.');
  });

  it('o campo "registro" atravessa o parse do checkpoint (não é descartado)', () => {
    const c = checkpointContentSchema.parse({
      rolling_summary: 'x',
      registro: { perguntas: [{ tema: 'cidade', pergunta: 'Em que cidade você mora?' }] },
    });
    expect(lerRegistroDoFechamento(c.registro)?.perguntas).toEqual([
      { tema: 'cidade', pergunta: 'Em que cidade você mora?' },
    ]);
  });

  it('nomes traduzidos voltam ao português; formato inválido = null (o turno segue)', () => {
    const r = lerRegistroDoFechamento({ preguntas: [{ tema: 'ciudad', pregunta: '¿En qué ciudad vives?' }] });
    expect(r?.perguntas[0]).toEqual({ tema: 'ciudad', pergunta: '¿En qué ciudad vives?' });
    expect(lerRegistroDoFechamento({ perguntas: 'não é lista' })).toBeNull();
    expect(lerRegistroDoFechamento(undefined)).toBeNull();
  });
});

describe('PC-019 — saúde só como tema: nenhum diagnóstico, CID ou remédio', () => {
  it('CID, telefone e diagnóstico saem do texto', () => {
    const t = sanearTexto('CID M54.5, hérnia de disco, ligar (31) 99876-5432 e tomar dipirona 500mg');
    expect(t).not.toMatch(/M54|CID|hérnia|99876|dipirona|500mg/i);
  });

  it('tema com diagnóstico vira "saúde"; resposta de saúde vira só sim/não/informado', () => {
    expect(sanearItem({ tema: 'fratura na perna', pergunta: null, resposta: 'quebrou a tíbia' })).toMatchObject({
      tema: 'saúde',
      resposta: 'informado',
    });
    expect(sanearItem({ tema: 'licença de saúde', pergunta: null, resposta: 'Sim, pode usar' })).toMatchObject({
      tema: 'licença de saúde',
      resposta: 'sim',
    });
    expect(sanearItem({ tema: 'afastamento', pergunta: null, resposta: 'afastado com laudo de depressão' })).toMatchObject({
      tema: 'afastamento',
      resposta: 'informado',
    });
    expect(sanearItem({ tema: 'cidade', pergunta: null, resposta: 'Belo Horizonte' }).resposta).toBe('Belo Horizonte');
  });

  it('o registro mesclado nunca guarda diagnóstico nem CID', () => {
    const itens = mesclarRegistro(
      [],
      {
        perguntas: [{ tema: 'diagnóstico', pergunta: 'Qual o CID do seu laudo?' }],
        respostas: [{ tema: 'diagnóstico', resposta: 'CID S82.2 fratura exposta, tomo tramadol 50mg', recusou: false }],
        licencas: [],
        promessas_cumpridas: [],
      },
      [],
      ctx(AS_10H02),
    );
    const tudo = JSON.stringify(itens);
    expect(tudo).not.toMatch(/S82|CID|fratura|50mg/i);
    expect(ehDeSaude('qualquer coisa')).toBe(false);
  });
});

describe('PC-019 — a mescla do turno com o registro', () => {
  it('pergunta nova fica sem resposta; a resposta do turno seguinte a fecha', () => {
    let reg = aplicar([], { perguntas: [{ tema: 'data do acidente', pergunta: 'Quando foi o acidente?' }], respostas: [], licencas: [], promessas_cumpridas: [] }, [], ctx(AS_10H02));
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatchObject({ tipo: 'pergunta', status: 'sem_resposta', vezes: 1, chave: 'data do acidente' });

    reg = aplicar(reg, { perguntas: [], respostas: [{ tema: 'Data do acidente', resposta: 'março de 2022', recusou: false }], licencas: [], promessas_cumpridas: [] }, [], ctx(new Date(AS_10H02.getTime() + 60_000)));
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatchObject({ status: 'respondida', resposta: 'março de 2022' });
  });

  it('a mesma pergunta feita de novo soma vezes (tema parecido casa com o item)', () => {
    let reg = aplicar([], { perguntas: [{ tema: 'quem sofreu o acidente', pergunta: 'Foi com você?' }], respostas: [], licencas: [], promessas_cumpridas: [] }, [], ctx(AS_10H02));
    reg = aplicar(reg, { perguntas: [{ tema: 'quem sofreu o acidente?', pergunta: 'Foi com você ou alguém da família?' }], respostas: [], licencas: [], promessas_cumpridas: [] }, [], ctx(AS_10H02));
    expect(reg).toHaveLength(1);
    expect(reg[0]!.vezes).toBe(2);
  });

  it('licença dada fica registrada com a hora', () => {
    const reg = aplicar([], { perguntas: [], respostas: [], licencas: [{ tema: 'dados de saúde', concedida: true }], promessas_cumpridas: [] }, [], ctx(AS_10H02));
    expect(reg[0]).toMatchObject({ tipo: 'licenca', status: 'concedida', resolvidoEm: AS_10H02 });
  });

  it('promessa da declaração vira pendente; repetida não duplica; cumprida pela IA fecha', () => {
    const prazo = '2026-11-04T11:00:00.000Z';
    let reg = aplicar([], null, [{ o_que: 'a equipe fala com você a partir das 8h de amanhã', prazo }], ctx(AS_10H02));
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatchObject({ tipo: 'promessa', status: 'pendente', prazo: new Date(prazo) });
    reg = aplicar(reg, null, [{ o_que: 'a equipe fala com você a partir das 8h de amanhã', prazo: null }], ctx(AS_10H02));
    expect(reg).toHaveLength(1);
    expect(reg[0]!.prazo).toEqual(new Date(prazo));
    reg = aplicar(reg, { perguntas: [], respostas: [], licencas: [], promessas_cumpridas: ['a equipe fala com você a partir das 8h'] }, [], ctx(AS_10H02));
    expect(reg[0]!.status).toBe('cumprida');
  });

  it('chave ignora acento, caixa e pontuação', () => {
    expect(chaveDoTema('  Licença de Saúde? ')).toBe('licenca de saude');
  });
});

describe('PC-019 — promessa pendente, cumprida ou vencida (na leitura)', () => {
  const prazo = new Date('2026-11-04T11:00:00Z'); // 04/11 08h00 em SP
  const promessa: ItemDoRegistro = {
    id: 'p1',
    tipo: 'promessa',
    tema: 'a equipe fala com você a partir das 8h de amanhã',
    chave: 'x',
    status: 'pendente',
    pergunta: null,
    resposta: null,
    prazo,
    vezes: 1,
    agentId: null,
    conversationId: null,
    jobId: null,
    criadoEm: AS_10H02,
    atualizadoEm: AS_10H02,
    resolvidoEm: null,
  };

  it('antes do prazo: pendente; depois do prazo sem a equipe falar: vencida', () => {
    expect(statusEfetivo(promessa, new Date('2026-11-04T10:00:00Z'), null)).toBe('pendente');
    expect(statusEfetivo(promessa, new Date('2026-11-04T12:00:00Z'), null)).toBe('vencida');
  });

  it('a equipe falou com o cliente depois da promessa (que era da equipe): cumprida', () => {
    expect(statusEfetivo(promessa, new Date('2026-11-04T12:00:00Z'), new Date('2026-11-04T11:30:00Z'))).toBe('cumprida');
    expect(promessaDaEquipe('vou te mandar a lista de documentos')).toBe(false);
  });
});

describe('PC-019 — o bloco do turno (≤ 600 caracteres)', () => {
  it('mostra "dados de saúde: sim (10h02)" e as quatro seções', () => {
    let reg = aplicar(
      [],
      {
        perguntas: [{ tema: 'licença de saúde', pergunta: 'Posso usar seus dados de saúde?' }],
        respostas: [],
        licencas: [],
        promessas_cumpridas: [],
      },
      [],
      ctx(new Date(AS_10H02.getTime() - 60_000)),
    );
    reg = aplicar(
      reg,
      {
        perguntas: [{ tema: 'data do acidente', pergunta: 'Quando foi o acidente?' }],
        respostas: [{ tema: 'licença de saúde', resposta: 'sim', recusou: false }],
        licencas: [{ tema: 'dados de saúde', concedida: true }],
        promessas_cumpridas: [],
      },
      [{ o_que: 'a equipe fala com você a partir das 8h de amanhã', prazo: '2026-11-04T11:00:00.000Z' }],
      ctx(AS_10H02),
    );
    const bloco = renderRegistro(reg, new Date(AS_10H02.getTime() + 5 * 60_000), FUSO, null);
    expect(bloco).toContain('dados de saúde: sim (10h02)');
    expect(bloco).toContain('JÁ PERGUNTADO E RESPONDIDO: licença de saúde → sim (10h02)');
    expect(bloco).toContain('SEM RESPOSTA: data do acidente');
    expect(bloco).toContain('PROMETIDO: a equipe fala com você a partir das 8h de amanhã (pendente até 04/11 08h00)');
    expect(bloco.length).toBeLessThanOrEqual(TETO_DO_BLOCO);
  });

  it('registro grande: corta os mais antigos com (+N) e nunca passa de 600', () => {
    const turno = {
      perguntas: [],
      respostas: ['cidade', 'profissão', 'empresa', 'carteira assinada', 'data do acidente', 'boletim de ocorrência', 'perícia do INSS', 'benefício negado', 'quem fala', 'estado civil', 'filhos', 'renda'].map((tema) => ({
        tema,
        resposta: 'uma resposta também comprida para encher o bloco do turno',
        recusou: false,
      })),
      licencas: [],
      promessas_cumpridas: [],
    };
    const reg = aplicar([], turno, [], ctx(AS_10H02));
    const bloco = renderRegistro(reg, AS_10H02, FUSO, null);
    expect(bloco.length).toBeLessThanOrEqual(TETO_DO_BLOCO);
    expect(bloco).toMatch(/\(\+\d+\)/);
  });

  it('registro vazio: sem bloco', () => {
    expect(renderRegistro([], AS_10H02, FUSO, null)).toBe('');
  });
});

describe('PC-019 + PC-018 — a trava de repetição consulta o registro', () => {
  const dice = async (a: string, b: string) => diceDePerguntas(a, b) >= 0.6;

  it('pergunta já respondida no registro (fora de qualquer janela) é barrada', async () => {
    const reg = aplicar(
      [],
      {
        perguntas: [{ tema: 'licença de saúde', pergunta: 'Posso usar seus dados de saúde para analisar o caso?' }],
        respostas: [{ tema: 'licença de saúde', resposta: 'sim', recusou: false }],
        licencas: [],
        promessas_cumpridas: [],
      },
      [],
      ctx(AS_10H02),
    );
    const r = await perguntaJaRespondidaNoRegistro(
      'Antes de seguir: posso usar seus dados de saúde para analisar o caso?',
      perguntasRespondidas(reg),
      dice,
    );
    expect(r).toMatchObject({ tipo: 'pergunta_respondida', fonte: 'registro' });
    expect(r?.anterior.respostaDoCliente).toBe('sim');
  });

  it('pergunta nova passa', async () => {
    const reg = aplicar([], { perguntas: [], respostas: [{ tema: 'cidade', resposta: 'Contagem', recusou: false }], licencas: [], promessas_cumpridas: [] }, [], ctx(AS_10H02));
    expect(await perguntaJaRespondidaNoRegistro('Qual o seu nome completo?', perguntasRespondidas(reg), dice)).toBeNull();
  });
});
