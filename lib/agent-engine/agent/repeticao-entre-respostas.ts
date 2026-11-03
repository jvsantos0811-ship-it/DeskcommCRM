/**
 * TRAVA DE REPETIÇÃO ENTRE RESPOSTAS E NO FOLLOW-UP (PC-018, Pacote Conversa).
 *
 * ## O defeito
 *
 * A trava de duplicata (`near-dup.ts`) só compara dentro do MESMO turno (a
 * memória do turno e a janela desde a última mensagem do cliente). As
 * repetições medidas na Bórbora (29/10 a 03/11, pulsos do Gestor) estão ENTRE
 * turnos e na régua de follow-up: a mesma pergunta ("foi com você ou com alguém
 * da família?") em 5 toques seguidos; o pedido de licença de saúde 4 vezes;
 * "Ainda estou aguardando a equipe confirmar…" 3 vezes; "sem pressa nenhuma" 3
 * vezes numa conversa.
 *
 * ## A régua
 *
 * Antes de enviar (turno de resposta E follow-up escrito pela IA), a candidata
 * é comparada com as últimas mensagens da IA para aquele contato — padrão: 10
 * mensagens ou 72 h, o que vier primeiro; ajustável por organização:
 *
 *  a) MENSAGEM PARECIDA: Dice de bigramas (a régua do near-dup) com limiar
 *     próprio (padrão 0,8), com a mesma exceção de informação nova (número,
 *     hora, negação). Compara a candidata inteira e cada parágrafo dela com
 *     cada mensagem anterior;
 *  b) PERGUNTA REPETIDA: cada pergunta da candidata contra as perguntas já
 *     feitas, por embedding barato (limiar ajustável, padrão 0,85; sem chave de
 *     embedding, cai na régua de texto com limiar 0,6). Bloqueia se a pergunta
 *     anterior JÁ FOI RESPONDIDA (o cliente escreveu depois dela) ou se já foi
 *     feita 2 vezes sem resposta. Na régua de follow-up (o cliente calado), UMA
 *     vez sem resposta já basta: é o defeito medido — a mesma pergunta em 5
 *     toques seguidos.
 *
 * Exceções que passam: o cliente pediu para repetir ("pode repetir?", "não
 * entendi", "manda de novo" — inclusive a lista de dados do contrato); o texto
 * fixo do operador no fluxo nem passa por aqui (sai por `sendFixedOutbound`).
 *
 * Ao bloquear, o modelo recebe UM erro de ensino dizendo o que já foi
 * perguntado ou dito, e quando. Se a reescrita repetir de novo: no follow-up o
 * toque NÃO sai (fica registrado "toque pulado por repetição"); no turno de
 * resposta, sai a reescrita e fica registrado — o cliente nunca fica sem
 * resposta. Nenhuma chamada de modelo de conversa a mais quando não há
 * repetição.
 */
import { z } from 'zod';

import { mudaInformacao, normalizarParaComparacao, similaridadeDice } from './near-dup';
import { lerRegistro, perguntasRespondidas, type PerguntaRespondida } from './registro-da-conversa';
import type { Queryable } from '../queue/queue';

// ─── Ajustes por organização (`organizations.settings.conversa.repeticao`) ──

export const AJUSTES_PADRAO_DE_REPETICAO = {
  ligada: true,
  janelaMensagens: 10,
  janelaHoras: 72,
  limiarTexto: 0.8,
  limiarPergunta: 0.85,
} as const;

export interface AjustesDeRepeticao {
  ligada: boolean;
  janelaMensagens: number;
  janelaHoras: number;
  limiarTexto: number;
  limiarPergunta: number;
}

/** O que a tela grava (snake_case no jsonb). Faixas fechadas: valor fora vira o padrão. */
export const ajustesDeRepeticaoSchema = z.strictObject({
  ligada: z.boolean(),
  janela_mensagens: z.number().int().min(3).max(30),
  janela_horas: z.number().int().min(6).max(168),
  limiar_texto: z.number().min(0.6).max(0.95),
  limiar_pergunta: z.number().min(0.7).max(0.95),
});
export type AjustesDeRepeticaoGravados = z.infer<typeof ajustesDeRepeticaoSchema>;

/** Lê os ajustes do jsonb da organização. Ausente ou inválido = o padrão (LIGADA). Nunca lança. */
export function lerAjustesDeRepeticao(settings: unknown): AjustesDeRepeticao {
  const conversa = (settings as { conversa?: unknown } | null)?.conversa;
  const cru = (conversa as { repeticao?: unknown } | null)?.repeticao;
  const p = ajustesDeRepeticaoSchema.safeParse(cru);
  if (!p.success) return { ...AJUSTES_PADRAO_DE_REPETICAO };
  return {
    ligada: p.data.ligada,
    janelaMensagens: p.data.janela_mensagens,
    janelaHoras: p.data.janela_horas,
    limiarTexto: p.data.limiar_texto,
    limiarPergunta: p.data.limiar_pergunta,
  };
}

/** O formato gravado, a partir dos ajustes em uso (para a tela mostrar o padrão). */
export function ajustesParaGravar(a: AjustesDeRepeticao): AjustesDeRepeticaoGravados {
  return {
    ligada: a.ligada,
    janela_mensagens: a.janelaMensagens,
    janela_horas: a.janelaHoras,
    limiar_texto: a.limiarTexto,
    limiar_pergunta: a.limiarPergunta,
  };
}

// ─── Puros ──────────────────────────────────────────────────────────────────

/** As perguntas de um texto: cada trecho que termina em "?". */
export function perguntasDoTexto(texto: string): string[] {
  const out: string[] = [];
  const re = /[^.!?\n]*\?+/g;
  for (const m of texto.matchAll(re)) {
    const p = m[0].replace(/^[\s,;:—–-]+/, '').trim();
    if (p.replace(/[?\s]/g, '').length >= 4) out.push(p);
  }
  return out;
}

/**
 * O cliente pediu para repetir? ("pode repetir?", "não entendi", "manda de
 * novo", "qual era a lista?", "esqueci"). Puro e propositalmente largo: errar
 * para o lado de deixar repetir nunca deixa o cliente sem resposta.
 */
export function clientePediuParaRepetir(texto: string | null | undefined): boolean {
  if (!texto) return false;
  const t = normalizarParaComparacao(texto).normalize('NFD').replace(/[̀-ͯ]/g, '');
  return /\b(repet\w*|de novo|novamente|outra vez|nao entendi|nao vi|nao li|como assim|me manda|manda (a|o|os|as)? ?(lista|de novo)|qual era|quais eram|qual e mesmo|esqueci|pode falar|explica)\b/.test(
    t,
  );
}

/** Divide a candidata em partes comparáveis: o todo e cada parágrafo com corpo. */
function partesDaCandidata(candidata: string): string[] {
  const paragrafos = candidata
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 20);
  return [candidata, ...paragrafos.filter((p) => p !== candidata.trim())];
}

export interface MensagemDaIa {
  id: string;
  body: string;
  createdAt: Date;
  /** O cliente escreveu depois desta mensagem? (= a pergunta dela teve resposta) */
  respondida: boolean;
  /** A 1ª fala do cliente depois desta mensagem, para o erro de ensino. */
  respostaDoCliente: string | null;
}

export type Repeticao =
  | { tipo: 'mensagem'; anterior: MensagemDaIa }
  | {
      tipo: 'pergunta_respondida';
      pergunta: string;
      anterior: MensagemDaIa;
      /** PC-019: achada no registro da conversa (então `anterior.id` é o id do item). */
      fonte?: 'registro';
    }
  | { tipo: 'pergunta_duas_vezes'; pergunta: string; anterior: MensagemDaIa };

/**
 * PC-019: uma pergunta da candidata já foi respondida segundo o REGISTRO da
 * conversa — sem janela de tempo nem de mensagens: é o que sobrevive à
 * compactação e à troca de agente (a especialista não repete o que a recepção
 * já perguntou).
 */
export async function perguntaJaRespondidaNoRegistro(
  candidata: string,
  respondidas: readonly PerguntaRespondida[],
  mesmaPergunta: Comparador,
): Promise<Repeticao | null> {
  if (respondidas.length === 0) return null;
  for (const pergunta of perguntasDoTexto(candidata)) {
    for (const r of respondidas) {
      const casou =
        (await mesmaPergunta(pergunta, r.texto)) || (r.texto !== r.tema && (await mesmaPergunta(pergunta, r.tema)));
      if (casou) {
        return {
          tipo: 'pergunta_respondida',
          pergunta,
          fonte: 'registro',
          anterior: { id: r.id, body: r.texto, createdAt: r.quando, respondida: true, respostaDoCliente: r.resposta },
        };
      }
    }
  }
  return null;
}

/** (a) A candidata (ou um parágrafo dela) é quase igual a uma mensagem anterior. Puro. */
export function mensagemParecida(
  candidata: string,
  anteriores: readonly MensagemDaIa[],
  limiar: number,
): MensagemDaIa | null {
  for (const parte of partesDaCandidata(candidata)) {
    const c = normalizarParaComparacao(parte);
    if (c.length < 2) continue;
    for (const ant of anteriores) {
      const e = normalizarParaComparacao(ant.body);
      if (e.length < 2) continue;
      if (c === e) return ant;
      if (similaridadeDice(c, e) >= limiar && !mudaInformacao(c, e)) return ant;
    }
  }
  return null;
}

/** Duas perguntas têm o mesmo sentido? (cosseno dos vetores quando há, senão Dice). */
export type Comparador = (a: string, b: string) => Promise<boolean>;

/** Limiar da régua de texto quando não há embedding: a mesma pergunta escrita de outro jeito. */
export const LIMIAR_DE_PERGUNTA_SEM_EMBEDDING = 0.6;

/** Cosseno de dois vetores. Puro. */
export function cosseno(a: readonly number[], b: readonly number[]): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    ab += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return aa === 0 || bb === 0 ? 0 : ab / Math.sqrt(aa * bb);
}

/** Dice entre duas perguntas normalizadas — a régua sem embedding. Puro. */
export function diceDePerguntas(a: string, b: string): number {
  return similaridadeDice(normalizarParaComparacao(a), normalizarParaComparacao(b));
}

/**
 * (b) Uma pergunta da candidata repete uma pergunta já feita que foi
 * respondida, ou que já foi feita 2 vezes sem resposta.
 */
export async function perguntaRepetida(
  candidata: string,
  anteriores: readonly MensagemDaIa[],
  mesmaPergunta: Comparador,
  /** Quantas vezes sem resposta já barram (2 no turno de resposta, 1 no follow-up). */
  vezesSemResposta = 2,
): Promise<Repeticao | null> {
  const perguntas = perguntasDoTexto(candidata);
  if (perguntas.length === 0) return null;
  const comPergunta = anteriores
    .map((m) => ({ m, perguntas: perguntasDoTexto(m.body) }))
    .filter((x) => x.perguntas.length > 0);
  if (comPergunta.length === 0) return null;

  for (const pergunta of perguntas) {
    const iguais: MensagemDaIa[] = [];
    for (const { m, perguntas: ps } of comPergunta) {
      for (const p of ps) {
        if (await mesmaPergunta(pergunta, p)) {
          iguais.push(m);
          break;
        }
      }
    }
    // Mais recente primeiro (a ordem de `anteriores`).
    const respondida = iguais.find((m) => m.respondida);
    if (respondida) return { tipo: 'pergunta_respondida', pergunta, anterior: respondida };
    if (iguais.length >= vezesSemResposta) return { tipo: 'pergunta_duas_vezes', pergunta, anterior: iguais[0]! };
  }
  return null;
}

function horaCurta(d: Date, fuso: string): string {
  try {
    const p = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: fuso,
    }).formatToParts(d);
    return `${p.find((x) => x.type === 'hour')?.value ?? ''}h${p.find((x) => x.type === 'minute')?.value ?? ''}`;
  } catch {
    return '';
  }
}

function curto(texto: string, n: number): string {
  const t = texto.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

/** O erro de ensino: o que já foi perguntado ou dito, e quando. Puro. */
export function erroDeEnsinoDaRepeticao(r: Repeticao, fuso: string, followup: boolean): string {
  const hora = horaCurta(r.anterior.createdAt, fuso);
  if (r.tipo === 'pergunta_respondida') {
    const resposta = r.anterior.respostaDoCliente ? curto(r.anterior.respostaDoCliente, 80) : '';
    const comoRespondeu =
      resposta === 'não quis responder'
        ? ' e o cliente não quis responder'
        : resposta
          ? ` e o cliente respondeu ${JSON.stringify(resposta)}`
          : ' e o cliente já respondeu';
    return (
      `Você já perguntou ${JSON.stringify(curto(r.pergunta, 120))}${hora ? ` às ${hora}` : ''}` +
      comoRespondeu +
      '. NÃO pergunte de novo: use o que ele disse e siga para a próxima pergunta. A mensagem NÃO foi enviada.'
    );
  }
  if (r.tipo === 'pergunta_duas_vezes') {
    return (
      `Você já fez a pergunta ${JSON.stringify(curto(r.pergunta, 120))} ${followup ? '' : 'duas vezes '}sem resposta (a última${hora ? ` às ${hora}` : ''}). ` +
      (followup
        ? 'NÃO repita a pergunta nesta retomada: use outro ângulo ou não mande nada. A mensagem NÃO foi enviada.'
        : 'NÃO pergunte de novo: mude de assunto ou ofereça outro caminho. A mensagem NÃO foi enviada.')
    );
  }
  return (
    `Você já mandou uma mensagem quase igual a esta${hora ? ` às ${hora}` : ''}: ${JSON.stringify(curto(r.anterior.body, 120))}. ` +
    (followup
      ? 'Use outro ângulo nesta retomada, ou não mande nada. A mensagem NÃO foi enviada.'
      : 'Não repita: diga o que é novo ou siga para o próximo passo. A mensagem NÃO foi enviada.')
  );
}

// ─── Banco ──────────────────────────────────────────────────────────────────

/**
 * As últimas mensagens da IA para o contato (todas as conversas dele), mais
 * recente primeiro, na janela (N mensagens ou H horas, o que vier primeiro) —
 * fora as do turno em curso. Para cada uma, se o cliente escreveu depois e o
 * que ele disse primeiro. E a última fala do cliente (para a exceção).
 */
export async function historicoDaIaParaOContato(
  db: Queryable,
  args: {
    organizationId: string;
    contactId: string;
    ajustes: AjustesDeRepeticao;
    /** Começo do turno em curso: o que saiu dele não entra (a trava do turno cuida). */
    desde: Date;
  },
): Promise<{ mensagens: MensagemDaIa[]; ultimaDoCliente: string | null }> {
  const { rows } = await db.query<{
    id: string;
    body: string | null;
    created_at: Date;
    resposta: string | null;
    respondida: boolean;
  }>(
    `select m.id, m.body, m.created_at,
            r.body as resposta, (r.id is not null) as respondida
       from messages m
       left join lateral (
         select i.id, coalesce(i.body, i.media_derived_text) as body
           from messages i
          where i.organization_id = m.organization_id and i.contact_id = m.contact_id
            and i.direction = 'inbound' and i.created_at > m.created_at
          order by i.created_at asc limit 1
       ) r on true
      where m.organization_id = $1 and m.contact_id = $2
        and m.direction = 'outbound' and m.sent_via = 'ai'
        and m.status <> 'failed' and m.body is not null
        and m.created_at > now() - make_interval(hours => $3)
        and m.created_at < $4
      order by m.created_at desc
      limit $5`,
    [args.organizationId, args.contactId, args.ajustes.janelaHoras, args.desde, args.ajustes.janelaMensagens],
  );
  const { rows: ultima } = await db.query<{ body: string | null }>(
    `select coalesce(body, media_derived_text) as body from messages
      where organization_id = $1 and contact_id = $2 and direction = 'inbound'
      order by created_at desc limit 1`,
    [args.organizationId, args.contactId],
  );
  return {
    mensagens: rows.map((r) => ({
      id: r.id,
      body: r.body ?? '',
      createdAt: new Date(r.created_at),
      respondida: r.respondida === true,
      respostaDoCliente: r.resposta,
    })),
    ultimaDoCliente: ultima[0]?.body ?? null,
  };
}

/** Lê os ajustes da organização. Falha = o padrão (ligada). */
export async function ajustesDaOrganizacao(db: Queryable, organizationId: string): Promise<AjustesDeRepeticao> {
  try {
    const { rows } = await db.query<{ settings: unknown }>(
      'select settings from organizations where id = $1',
      [organizationId],
    );
    return lerAjustesDeRepeticao(rows[0]?.settings ?? null);
  } catch {
    return { ...AJUSTES_PADRAO_DE_REPETICAO };
  }
}

/** Conta a repetição barrada (ou liberada) na conversa — sem chamada de modelo. */
export async function contarRepeticaoNaConversa(
  db: Queryable,
  organizationId: string,
  conversationId: string,
  chave: 'repeticoes_barradas' | 'repeticoes_liberadas' | 'toques_pulados_por_repeticao',
): Promise<void> {
  await db.query(
    `update conversations
        set metadata = coalesce(metadata, '{}'::jsonb)
          || jsonb_build_object($3::text, coalesce((metadata->>$3)::int, 0) + 1)
      where organization_id = $1 and id = $2`,
    [organizationId, conversationId, chave],
  );
}

// ─── A conferência do turno ─────────────────────────────────────────────────

export interface ConferenciaDeRepeticao {
  /** Confere a candidata; devolve a repetição achada (ou null). */
  conferir(candidata: string, opts?: { followup?: boolean }): Promise<Repeticao | null>;
}

/**
 * Tira da candidata as perguntas repetidas — o que sai no turno de resposta
 * quando a reescrita repetiu de novo: o cliente recebe o resto, e a pergunta
 * já respondida não volta. Sobra pouco? Devolve `null` (sai a reescrita como
 * veio: o cliente nunca fica sem resposta). Puro.
 */
export function semAPerguntaRepetida(candidata: string, r: Repeticao): string | null {
  if (r.tipo === 'mensagem') return null;
  const sem = candidata.replace(r.pergunta, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return sem.length >= 10 && sem !== candidata.trim() ? sem : null;
}

/**
 * Monta a conferência de UM turno: lê ajustes e histórico uma vez (na primeira
 * candidata), guarda os vetores das perguntas já feitas. `embed` devolve o
 * vetor de um texto ou `null` (sem chave): aí a régua cai no Dice.
 */
export function criarConferenciaDeRepeticao(
  db: Queryable,
  args: { organizationId: string; contactId: string; desde: Date },
  embed: ((texto: string) => Promise<number[] | null>) | null,
): ConferenciaDeRepeticao {
  let carregado: Promise<{
    ajustes: AjustesDeRepeticao;
    mensagens: MensagemDaIa[];
    ultimaDoCliente: string | null;
    respondidas: PerguntaRespondida[];
  }> | null = null;
  const vetores = new Map<string, Promise<number[] | null>>();
  const vetor = (t: string) => {
    let v = vetores.get(t);
    if (!v) {
      v = embed ? embed(t).catch(() => null) : Promise.resolve(null);
      vetores.set(t, v);
    }
    return v;
  };
  return {
    async conferir(candidata, opts) {
      carregado ??= (async () => {
        const ajustes = await ajustesDaOrganizacao(db, args.organizationId);
        if (!ajustes.ligada) return { ajustes, mensagens: [], ultimaDoCliente: null, respondidas: [] };
        const h = await historicoDaIaParaOContato(db, { ...args, ajustes });
        // PC-019: o registro da conversa diz o que JÁ foi respondido, fora da janela.
        const respondidas = await lerRegistro(db, args.organizationId, args.contactId)
          .then(perguntasRespondidas)
          .catch(() => [] as PerguntaRespondida[]);
        return { ajustes, ...h, respondidas };
      })();
      const { ajustes, mensagens, ultimaDoCliente, respondidas } = await carregado;
      if (!ajustes.ligada || (mensagens.length === 0 && respondidas.length === 0)) return null;
      if (clientePediuParaRepetir(ultimaDoCliente)) return null;

      const parecida = mensagemParecida(candidata, mensagens, ajustes.limiarTexto);
      if (parecida) return { tipo: 'mensagem', anterior: parecida };

      const mesmaPergunta: Comparador = async (a, b) => {
        const [va, vb] = await Promise.all([vetor(a), vetor(b)]);
        if (va && vb) return cosseno(va, vb) >= ajustes.limiarPergunta;
        return diceDePerguntas(a, b) >= LIMIAR_DE_PERGUNTA_SEM_EMBEDDING;
      };
      const peloRegistro = await perguntaJaRespondidaNoRegistro(candidata, respondidas, mesmaPergunta);
      if (peloRegistro) return peloRegistro;
      return perguntaRepetida(candidata, mensagens, mesmaPergunta, opts?.followup === true ? 1 : 2);
    },
  };
}
