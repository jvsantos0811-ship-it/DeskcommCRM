/**
 * Ferramentas da IA para quando a conversa mora DENTRO de outra plataforma de
 * atendimento (PC-047): anotar para a equipe e executar uma ação que o operador
 * liberou na tela (etiquetar, mover de funil, mandar um modelo).
 *
 * O turno só as oferece quando o canal da conversa sabe fazer isso
 * (`acoesDoAtendimento` no adapter) — este arquivo não sabe, nem pergunta, qual
 * plataforma é: recebe as ações já amarradas ao chat e as transforma em
 * ferramentas do modelo.
 *
 * ─── O que a IA NÃO pode ────────────────────────────────────────────────────
 *
 *  - escolher um diálogo pelo id: só uma das chaves que a tela gravou;
 *  - escrever em campo da plataforma: o campo que liga/desliga a IA no chat é
 *    tocado pela PASSAGEM para a equipe, nunca por escolha do modelo (uma IA que
 *    se religa sozinha num chat da equipe seria duas vozes no mesmo atendimento);
 *  - falar com o cliente por aqui: anotação é interna (a equipe vê, o cliente não).
 *
 * As duas são MUTANTES (ficam fora de `READ_ONLY_TOOLS`) e devolvem erro de
 * ENSINO ao modelo quando a plataforma recusa, nunca exceção que derrube o turno.
 * Cada ação roda no máximo UMA vez por turno.
 */
import { z } from 'zod';

import type { AcoesDoAtendimento } from '@/lib/channels/types';

import { tool, type ToolSet } from '../edge/llm/run-model-call';
import type { Logger } from '../obs/logger';

export const FERRAMENTA_ANOTAR = 'anotar_para_a_equipe';
export const FERRAMENTA_ACAO = 'executar_acao_do_atendimento';

function erroDeEnsino(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message } };
}

function motivoCurto(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 160);
}

/** Acrescenta as ferramentas ao conjunto do turno. Não remove nem renomeia nada. */
export function registrarFerramentasDoAtendimento(
  rawTools: ToolSet,
  acoes: AcoesDoAtendimento,
  log: Pick<Logger, 'warn'>,
): void {
  rawTools[FERRAMENTA_ANOTAR] = tool({
    description:
      `Deixa uma ANOTAÇÃO INTERNA no chat deste cliente no ${acoes.rotulo} do escritório: ` +
      'a equipe vê, o cliente NÃO vê. Use para registrar o que a equipe precisa saber ' +
      '(o caso em poucas linhas, o que já foi combinado, o que falta). Nunca use para ' +
      'falar com o cliente, e escreva só o necessário sobre saúde.',
    inputSchema: z.object({
      texto: z.string().describe('a anotação, curta e objetiva (até ~800 caracteres)'),
    }),
    execute: async (raw): Promise<Record<string, unknown>> => {
      const parsed = z.object({ texto: z.string().trim().min(3).max(2_000) }).safeParse(raw);
      if (!parsed.success) {
        return erroDeEnsino('invalid_input', 'mande `texto` com a anotação (entre 3 e 2000 caracteres).');
      }
      try {
        await acoes.anotar(parsed.data.texto);
        return { ok: true, status: 'anotado' };
      } catch (err) {
        log.warn('anotação na plataforma do canal falhou — o turno segue', { error: motivoCurto(err) });
        return erroDeEnsino('nao_anotado', 'a anotação não foi gravada agora; siga o atendimento sem ela.');
      }
    },
  });

  if (acoes.acoes.length === 0) return;

  const chaves = acoes.acoes.map((a) => a.chave) as [string, ...string[]];
  // Uma execução por ação por turno: o modelo repetir a chamada não pode mandar
  // o mesmo modelo da Meta (ou mover o card) duas vezes.
  const executadas = new Set<string>();
  const lista = acoes.acoes.map((a) => `- ${a.chave}: ${a.nome}. Quando usar: ${a.quandoUsar}`).join('\n');
  rawTools[FERRAMENTA_ACAO] = tool({
    description:
      `Executa no ${acoes.rotulo} do escritório UMA das ações que a equipe liberou. ` +
      'Use só quando a situação for exatamente a descrita em "quando usar"; na dúvida, não use. ' +
      `Ações liberadas:\n${lista}`,
    inputSchema: z.object({
      acao: z.enum(chaves).describe('a chave da ação liberada'),
    }),
    execute: async (raw): Promise<Record<string, unknown>> => {
      const parsed = z.object({ acao: z.enum(chaves) }).safeParse(raw);
      if (!parsed.success) {
        return erroDeEnsino('invalid_input', `mande \`acao\` com uma destas chaves: ${chaves.join(', ')}.`);
      }
      if (executadas.has(parsed.data.acao)) {
        return { ok: true, status: 'ja_executada_neste_turno', acao: parsed.data.acao };
      }
      try {
        await acoes.executar(parsed.data.acao);
        executadas.add(parsed.data.acao);
        return { ok: true, status: 'executada', acao: parsed.data.acao };
      } catch (err) {
        log.warn('ação na plataforma do canal falhou — o turno segue', { error: motivoCurto(err) });
        return erroDeEnsino('acao_nao_executada', 'a ação não foi executada agora; não diga ao cliente que foi.');
      }
    },
  });
}
