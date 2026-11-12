/**
 * PC-035 (medição) — o custo de cada RESPOSTA do agente, para medir antes e
 * depois de uma mudança (consulta do MCP de leitura da agência).
 *
 * Uma "resposta" é um turno do agente: a linha `agent_turn` de `llm_calls` e as
 * chamadas auxiliares do MESMO job (roteador, classificador, conferência de
 * promessa, fechamento). A conta junta por `job_id` e devolve só números —
 * nenhum texto de conversa passa por aqui.
 *
 * Função pura: recebe as linhas, devolve o resumo.
 */
import { costCents } from '@/lib/agent-engine/edge/llm/pricing';

import { gravacaoDaChamadaPorValidade, lerPassadas } from './passadas';

/** As colunas de `llm_calls` que a conta lê. */
export interface LinhaDeChamada {
  id: string;
  job_id: string | null;
  agent_id: string | null;
  purpose: string;
  model: string;
  status: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_cents: number | string | null;
  latency_ms: number | null;
  passadas: unknown;
  created_at: string;
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const arred = (v: number, casas = 4): number => {
  const f = 10 ** casas;
  return Math.round(v * f) / f;
};
const media = (soma: number, n: number): number => (n === 0 ? 0 : arred(soma / n));

interface Somas {
  chamadas: number;
  custo_cents: number;
  entrada: number;
  cache_lido: number;
  cache_gravado: number;
  saida: number;
}
const zero = (): Somas => ({ chamadas: 0, custo_cents: 0, entrada: 0, cache_lido: 0, cache_gravado: 0, saida: 0 });
function somar(s: Somas, l: LinhaDeChamada): void {
  s.chamadas += 1;
  s.custo_cents += num(l.cost_cents);
  s.entrada += num(l.input_tokens);
  s.cache_lido += num(l.cache_read_tokens);
  s.cache_gravado += num(l.cache_write_tokens);
  s.saida += num(l.output_tokens);
}

export interface ResumoDoCustoPorResposta {
  /** Quantos turnos do agente (linhas `agent_turn` com sucesso) há na janela. */
  respostas: number;
  /** Centavos de DÓLAR, como em `llm_calls.cost_cents`. Média por resposta, com as auxiliares do mesmo turno. */
  custo_por_resposta_cents: number;
  /** Só a chamada do agente (o laço), média por resposta. */
  laco_do_agente: {
    custo_cents: number;
    passadas: number | null;
    entrada: number;
    cache_lido: number;
    cache_gravado: number;
    cache_gravado_5m: number | null;
    cache_gravado_1h: number | null;
    saida: number;
    latencia_ms: number;
    texto_descartado_chars: number | null;
    /** O custo do laço se TODA a gravação de cache fosse cobrada a 1 hora (a conta de antes do PC-035). */
    custo_com_gravacao_a_1h_cents: number | null;
    /** O custo do laço pela validade que o provedor cobrou (5 min a 1,25×, 1 h a 2×). Nulo sem o detalhe por passada. */
    custo_pela_tarifa_real_cents: number | null;
  };
  /** Quantas respostas tiveram 1, 2, 3… passadas (só as que têm o detalhe gravado). */
  respostas_por_numero_de_passadas: Record<string, number>;
  /** Respostas com o detalhe por passada gravado (as de antes da versão que o grava ficam de fora das médias por passada). */
  respostas_com_detalhe: number;
  /** Média, por posição da passada, do que cada uma consumiu. */
  por_passada: Array<{
    n: number;
    respostas: number;
    entrada: number;
    cache_lido: number;
    cache_gravado: number;
    saida: number;
  }>;
  /** Em quantas respostas cada ferramenta foi pedida, e em que passada em média. */
  ferramentas: Array<{ ferramenta: string; respostas: number; passada_media: number }>;
  /** O gasto da janela por tipo de chamada (todas as chamadas da organização, com ou sem turno). */
  por_tipo_de_chamada: Array<{ tipo: string } & Somas>;
  /** Chamadas com erro na janela (não entram nas médias). */
  chamadas_com_erro: number;
}

/** Os turnos de teste do agente não são resposta a cliente. */
const TURNO_DO_AGENTE = 'agent_turn';

export function resumirCustoPorResposta(linhas: readonly LinhaDeChamada[]): ResumoDoCustoPorResposta {
  const ok = linhas.filter((l) => (l.status ?? 'ok') === 'ok');
  const porTipo = new Map<string, Somas>();
  for (const l of ok) {
    const s = porTipo.get(l.purpose) ?? zero();
    somar(s, l);
    porTipo.set(l.purpose, s);
  }

  const turnos = ok.filter((l) => l.purpose === TURNO_DO_AGENTE);
  const jobsComTurno = new Set(turnos.map((l) => l.job_id).filter((j): j is string => j !== null));
  // O custo da resposta inteira: o laço e as auxiliares do mesmo job.
  let custoDasRespostas = 0;
  for (const l of ok) {
    if (l.purpose === TURNO_DO_AGENTE || (l.job_id !== null && jobsComTurno.has(l.job_id))) {
      custoDasRespostas += num(l.cost_cents);
    }
  }

  const laco = zero();
  let latencia = 0;
  let comDetalhe = 0;
  let somaPassadas = 0;
  let somaDescartado = 0;
  let em5m = 0;
  let em1h = 0;
  let comDivisao = 0;
  let custoA1h = 0;
  let custoA1hValido = 0;
  let custoReal = 0;
  const porNumero: Record<string, number> = {};
  const porPosicao = new Map<number, { respostas: number } & Omit<Somas, 'chamadas' | 'custo_cents'>>();
  const porFerramenta = new Map<string, { respostas: number; somaDaPassada: number }>();

  for (const l of turnos) {
    somar(laco, l);
    latencia += num(l.latency_ms);
    const uso = {
      inputTokens: num(l.input_tokens),
      outputTokens: num(l.output_tokens),
      cacheReadTokens: num(l.cache_read_tokens),
      cacheWriteTokens: num(l.cache_write_tokens),
    };
    const a1h = costCents(l.model, uso, '1h', new Date(l.created_at));
    if (a1h !== null) {
      custoA1h += a1h;
      custoA1hValido += 1;
    }
    const passadas = lerPassadas(l.passadas);
    if (passadas.length === 0) continue;
    comDetalhe += 1;
    somaPassadas += passadas.length;
    porNumero[String(passadas.length)] = (porNumero[String(passadas.length)] ?? 0) + 1;
    const divisao = gravacaoDaChamadaPorValidade(passadas);
    if (divisao !== null) {
      comDivisao += 1;
      em5m += divisao.em5m;
      em1h += divisao.em1h;
      const real = costCents(
        l.model,
        { ...uso, cacheWrite5mTokens: divisao.em5m, cacheWrite1hTokens: divisao.em1h },
        '1h',
        new Date(l.created_at),
      );
      if (real !== null) custoReal += real;
    }
    const vistas = new Set<string>();
    for (const p of passadas) {
      somaDescartado += p.texto_descartado_chars;
      const pos = porPosicao.get(p.n) ?? { respostas: 0, entrada: 0, cache_lido: 0, cache_gravado: 0, saida: 0 };
      pos.respostas += 1;
      pos.entrada += p.entrada;
      pos.cache_lido += p.cache_lido;
      pos.cache_gravado += p.cache_gravado;
      pos.saida += p.saida;
      porPosicao.set(p.n, pos);
      for (const f of p.ferramentas) {
        if (vistas.has(f)) continue;
        vistas.add(f);
        const acc = porFerramenta.get(f) ?? { respostas: 0, somaDaPassada: 0 };
        acc.respostas += 1;
        acc.somaDaPassada += p.n;
        porFerramenta.set(f, acc);
      }
    }
  }

  const n = turnos.length;
  return {
    respostas: n,
    custo_por_resposta_cents: media(custoDasRespostas, n),
    laco_do_agente: {
      custo_cents: media(laco.custo_cents, n),
      passadas: comDetalhe === 0 ? null : arred(somaPassadas / comDetalhe, 2),
      entrada: Math.round(media(laco.entrada, n)),
      cache_lido: Math.round(media(laco.cache_lido, n)),
      cache_gravado: Math.round(media(laco.cache_gravado, n)),
      cache_gravado_5m: comDivisao === 0 ? null : Math.round(em5m / comDivisao),
      cache_gravado_1h: comDivisao === 0 ? null : Math.round(em1h / comDivisao),
      saida: Math.round(media(laco.saida, n)),
      latencia_ms: Math.round(media(latencia, n)),
      texto_descartado_chars: comDetalhe === 0 ? null : Math.round(somaDescartado / comDetalhe),
      custo_com_gravacao_a_1h_cents: custoA1hValido === 0 ? null : arred(custoA1h / custoA1hValido),
      custo_pela_tarifa_real_cents: comDivisao === 0 ? null : arred(custoReal / comDivisao),
    },
    respostas_por_numero_de_passadas: porNumero,
    respostas_com_detalhe: comDetalhe,
    por_passada: [...porPosicao.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([posicao, s]) => ({
        n: posicao,
        respostas: s.respostas,
        entrada: Math.round(s.entrada / s.respostas),
        cache_lido: Math.round(s.cache_lido / s.respostas),
        cache_gravado: Math.round(s.cache_gravado / s.respostas),
        saida: Math.round(s.saida / s.respostas),
      })),
    ferramentas: [...porFerramenta.entries()]
      .map(([ferramenta, s]) => ({ ferramenta, respostas: s.respostas, passada_media: arred(s.somaDaPassada / s.respostas, 2) }))
      .sort((a, b) => b.respostas - a.respostas || a.ferramenta.localeCompare(b.ferramenta)),
    por_tipo_de_chamada: [...porTipo.entries()]
      .map(([tipo, s]) => ({ tipo, ...s, custo_cents: arred(s.custo_cents) }))
      .sort((a, b) => b.custo_cents - a.custo_cents || a.tipo.localeCompare(b.tipo)),
    chamadas_com_erro: linhas.length - ok.length,
  };
}
