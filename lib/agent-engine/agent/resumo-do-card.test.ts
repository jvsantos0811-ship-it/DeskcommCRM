import { describe, expect, it, vi } from 'vitest';

import {
  aplicarBlocoNaDescricao,
  atualizarResumoDoCard,
  FIM_DO_BLOCO,
  lerLinhasDoModelo,
  montarBloco,
  normalizarPerguntasDoResumo,
  quandoDoResumo,
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
