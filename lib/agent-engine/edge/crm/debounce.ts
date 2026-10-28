/**
 * Coalescência de rajada inbound — a janela que junta as mensagens de UM contato
 * em UM turno.
 *
 * Morava inline no `drain.ts`; saiu para cá com teste próprio (issue #1390)
 * porque o comportamento carrega duas leis que se cruzam — a janela de debounce
 * e a exclusão do job em HOLD — e as duas precisam de régua própria.
 *
 * Contrato:
 *   - mensagem que chega enquanto há job PENDING **do mesmo contato** com a
 *     janela ainda aberta (`run_after > now()`) viaja de carona nele: o turno lê
 *     o histórico completo e responde a todas as mensagens do lote;
 *   - mensagem que chega fora da janela abre janela nova;
 *   - `debounceMs = 0` desliga a coalescência: job imediato, zero consulta.
 *
 * ## Âncora ou deslizante (PC-002, Fase 1, item 2)
 *
 * Sem `deslizante`, a janela é ANCORADA no primeiro job: mensagens que chegam
 * dentro dela não empurram o `run_after` (o comportamento histórico, que
 * `debounce.medicao.test.ts` mede).
 *
 * Com `deslizante` (o que o drain usa), CADA mensagem nova do mesmo contato
 * reinicia o relógio: o `run_after` do job pendente vai para `agora + espera
 * desta mensagem`, nunca além de `criação do job + teto`. O defeito que isto
 * conserta foi medido em 27/10/2026: "Meu neto sofreu o acidente de moto" +
 * "e ficou machucado" — com a janela ancorada, a segunda mensagem caía fora da
 * janela da primeira, ganhava turno próprio, e a IA respondeu só a ela. O teto
 * garante que um cliente que escreve sem parar recebe resposta (nunca
 * silêncio); a espera por tipo dá à foto e ao documento o tempo de o cliente
 * escrever a legenda ou a pergunta que costuma vir depois deles. O áudio não
 * precisa de regra própria aqui: o drain só chega a esta decisão depois que a
 * transcrição terminou (`'adiar'` em drain.ts), então "fim da transcrição +
 * espera de texto" sai sozinho.
 */
import type pg from 'pg';

/**
 * Job pendente do contato cuja janela ainda não venceu — a carona desta
 * mensagem.
 *
 * ⚠️ `run_after > now()` sozinho casa com um job em HOLD (`enforceHolds`,
 * session-watchdog.ts), que usa `run_after = 'infinity'` como marcador, e
 * 'infinity' É maior que `now()`. Um job em hold por sessão MORTA (WhatsApp
 * reconectado, sessão antiga arquivada) nunca libera — a condição de liberação
 * exige a MESMA sessão antiga voltar a 'WORKING', o que não acontece nunca.
 * Sem esta exclusão, TODA mensagem nova do mesmo contato — inclusive na sessão
 * NOVA — coalescia nesse job morto para sempre: o cliente escrevia, o evento
 * saía "done" sem erro nenhum, e nenhum turno rodava. Medido em produção
 * (2026-09-14): 6 mensagens ao longo de 7h, zero resposta, zero job novo — só o
 * coalescing silencioso repetido no mesmo job com `held_run_after` no payload.
 */
const SQL_JOB_PARA_COALESCER = `select id from job_queue
 where organization_id = $1 and contact_id = $2
   and kind = 'inbound_turn' and status = 'pending' and run_after > now()
   and not (payload ? 'held_run_after')
 limit 1`;

/** O que fazer com a mensagem que acabou de chegar. */
export type DecisaoDeRajada =
  | { tipo: 'coalescido'; jobId: string }
  | { tipo: 'enfileirar'; runAfter: Date | undefined };

/** Job pendente do contato que pode receber a mensagem de carona. */
export async function buscarJobParaCoalescer(
  pool: pg.Pool,
  alvo: { organizationId: string; contactId: string },
): Promise<string | undefined> {
  const { rows } = await pool.query<{ id: string }>(SQL_JOB_PARA_COALESCER, [
    alvo.organizationId,
    alvo.contactId,
  ]);
  return rows[0]?.id;
}

/**
 * Janela da rajada aberta por esta mensagem: `undefined` quando não há debounce
 * (o job nasce claimável agora).
 *
 * `agora` é injetável porque a janela é aritmética — o teste prende o número
 * sem depender do relógio.
 */
export function janelaDeRajada(debounceMs: number, agora: number = Date.now()): Date | undefined {
  return debounceMs > 0 ? new Date(agora + debounceMs) : undefined;
}

/**
 * Teto da janela de rajada configurável por agente (#1856): não deixar ninguém
 * travar o atendimento sem querer. Vale também como default de tela/UX.
 */
export const TETO_DEBOUNCE_MS = 60_000;

/**
 * Janela de rajada EFETIVA de um agente.
 *
 * `null`/`undefined` (campo vazio na versão) = o `INBOUND_DEBOUNCE_MS` da
 * instalação — regressão zero para quem nunca mexeu no campo. O valor
 * configurado é CLAMPADO em [0, TETO_DEBOUNCE_MS]: 0 desliga a coalescência e
 * valores acima do teto (dado sujo que entrou por fora da validação) caem para
 * 60s em vez de travar o atendimento.
 */
export function debounceEfetivo(
  configurado: number | null | undefined,
  padraoInstalacao: number,
): number {
  if (configurado === null || configurado === undefined) return padraoInstalacao;
  return Math.min(Math.max(0, configurado), TETO_DEBOUNCE_MS);
}

/** Tipos de mensagem que pedem a espera longa (foto, vídeo, documento). */
const TIPOS_DE_ESPERA_LONGA = new Set(['image', 'video', 'document', 'sticker']);

/** Espera deslizante por tipo de mensagem (PC-002, Fase 1, item 2). */
export interface EsperaDeslizante {
  /** Teto desde a 1ª mensagem do lote (criação do job). Padrão 30 s. */
  tetoMs: number;
  /** Espera de foto, vídeo e documento. Padrão 20 s. */
  esperaMidiaMs: number;
  /** Tipo da mensagem que acabou de chegar (`messages.type`). */
  tipo: string | null;
}

/**
 * Quanto ESTA mensagem pede de espera: o valor de texto do agente, ou o de
 * mídia quando ela é foto/vídeo/documento (o maior dos dois — um agente que
 * configurou texto acima do de mídia não ganha resposta MAIS rápida por causa
 * de uma foto). Nunca passa do teto: esperar além dele seria silêncio.
 */
export function esperaDaMensagem(debounceMs: number, d: EsperaDeslizante): number {
  const base =
    d.tipo !== null && TIPOS_DE_ESPERA_LONGA.has(d.tipo)
      ? Math.max(debounceMs, d.esperaMidiaMs)
      : debounceMs;
  return d.tetoMs > 0 ? Math.min(base, d.tetoMs) : base;
}

/**
 * Empurra o relógio do job pendente do contato: `run_after` vai para
 * `now() + espera`, limitado a `created_at + teto`, e NUNCA volta para trás
 * (`greatest`) — uma mensagem de texto depois de uma foto não encurta a espera
 * que a foto pediu.
 *
 * UM statement: a re-checagem de `status = 'pending' and run_after > now()` no
 * próprio UPDATE é o que impede empurrar um job que o worker acabou de
 * claimar entre a busca e a escrita (o row lock serializa com o claim). Sem
 * linha devolvida, a mensagem abre janela nova — o turno em andamento a
 * descarta como obsoleta e o novo responde às duas.
 */
const SQL_DESLIZAR = `update job_queue j
    set run_after = greatest(
          j.run_after,
          least(now() + ($3 * interval '1 millisecond'),
                j.created_at + ($4 * interval '1 millisecond')))
  where j.id = (
          select id from job_queue
           where organization_id = $1 and contact_id = $2
             and kind = 'inbound_turn' and status = 'pending' and run_after > now()
             and not (payload ? 'held_run_after')
           order by created_at
           limit 1)
    and j.status = 'pending' and j.run_after > now()
  returning j.id`;

/** Decide entre carona em job existente e janela nova. */
export async function decidirRajada(
  pool: pg.Pool,
  alvo: { organizationId: string; contactId: string },
  debounceMs: number,
  agora: number = Date.now(),
  deslizante?: EsperaDeslizante,
): Promise<DecisaoDeRajada> {
  if (debounceMs > 0 && deslizante !== undefined) {
    const espera = esperaDaMensagem(debounceMs, deslizante);
    const teto = deslizante.tetoMs > 0 ? deslizante.tetoMs : espera;
    const { rows } = await pool.query<{ id: string }>(SQL_DESLIZAR, [
      alvo.organizationId,
      alvo.contactId,
      espera,
      teto,
    ]);
    const jobId = rows[0]?.id;
    if (jobId !== undefined) return { tipo: 'coalescido', jobId };
    return { tipo: 'enfileirar', runAfter: janelaDeRajada(espera, agora) };
  }
  if (debounceMs > 0) {
    const jobId = await buscarJobParaCoalescer(pool, alvo);
    if (jobId !== undefined) return { tipo: 'coalescido', jobId };
  }
  return { tipo: 'enfileirar', runAfter: janelaDeRajada(debounceMs, agora) };
}
