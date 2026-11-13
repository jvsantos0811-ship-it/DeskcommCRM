/**
 * O REGISTRO DA CONVERSA (PC-019, Pacote Conversa) — a memória de trabalho do
 * atendimento: o que a IA JÁ PERGUNTOU, o que o cliente RESPONDEU, as LICENÇAS
 * que ele deu e o que a IA PROMETEU.
 *
 * ## O defeito
 *
 * O turno já recebe checkpoint, resumo rolante, notas do lead, campos com
 * status e compromissos de agenda — e mesmo assim a IA pedia a licença de saúde
 * 4 vezes, prometia o retorno da equipe 3 vezes, repetia pergunta depois da
 * compactação, e a especialista que recebia da recepção perguntava tudo de novo.
 * Faltava uma lista ESTRUTURADA, do contato, que sobrevivesse à compactação e à
 * troca de agente.
 *
 * ## Como funciona
 *
 * 1. GRAVAÇÃO sem chamada nova de modelo: o campo `registro` viaja na chamada
 *    de fechamento que já roda (a mesma do checkpoint e da declaração). O que o
 *    modelo manda é o DELTA do turno (perguntas feitas, respostas, licenças,
 *    promessas cumpridas); as promessas novas vêm da declaração. O código mescla
 *    com o que já existe (`mesclarRegistro`, puro) e grava por item.
 * 2. LEITURA em todo turno (resposta, follow-up e resposta a caso), de qualquer
 *    agente da organização: um bloco de até 600 caracteres no sufixo por lead
 *    (`renderRegistro`) — JÁ PERGUNTADO E RESPONDIDO · SEM RESPOSTA · LICENÇAS ·
 *    PROMETIDO. É do CONTATO, não do agente: a especialista vê o que a recepção
 *    já perguntou.
 * 3. A trava de repetição (PC-018) usa o registro para saber se uma pergunta já
 *    foi respondida — mesmo fora da janela de mensagens que ela lê.
 * 4. O card do negócio mostra o registro para a equipe ("Conversa até aqui").
 *
 * ## Saúde
 *
 * Dado de saúde só como TEMA ("licença de saúde: sim"; "afastamento:
 * informado"), nunca diagnóstico, CID ou nome de remédio. A instrução pede, e o
 * código garante (`sanearItem`) antes de gravar. A resposta de saúde tem três
 * valores honestos — "sim", "não", "não sabe" — e guarda a data quando há uma
 * ("perícia dia 20/11" → "sim · 20/11"). Nome de benefício do INSS (lista
 * fechada em `NOMES_DE_BENEFICIO`) sozinho não é dado de saúde (PC-038).
 *
 * ## Promessas
 *
 * Pendente até a IA dizer que cumpriu, ou até a equipe falar com o cliente
 * (promessa que é da equipe). Passou do prazo sem isso → VENCIDA — calculada na
 * leitura (`statusEfetivo`), igual no bloco do turno e no card.
 */
import { z } from 'zod';

import { guardServiceEffect } from '@/lib/atendimento/fronteira-server';

import type { Queryable } from '../queue/queue';
import type { Promessa } from './declaracao';
import { normalizarParaComparacao, similaridadeDice } from './near-dup';

// ─── O que o fechamento devolve (o delta do turno) ──────────────────────────

const temaSchema = z.string().trim().min(1).max(200);

export const registroDoTurnoSchema = z.object({
  perguntas: z
    .array(z.object({ tema: temaSchema, pergunta: z.string().trim().max(400).default('') }))
    .max(12)
    .default([]),
  respostas: z
    .array(
      z.object({
        tema: temaSchema,
        resposta: z.string().trim().max(400).default(''),
        recusou: z.boolean().default(false),
      }),
    )
    .max(12)
    .default([]),
  licencas: z
    .array(z.object({ tema: temaSchema, concedida: z.boolean() }))
    .max(6)
    .default([]),
  promessas_cumpridas: z.array(z.string().trim().min(1).max(400)).max(6).default([]),
});
export type RegistroDoTurno = z.infer<typeof registroDoTurnoSchema>;

/**
 * Nomes que o modelo costuma TRADUZIR (medido no fechamento da declaração:
 * "intenciones" no lugar de `intencoes`). O registro é tolerante: traduz de
 * volta antes de validar, em vez de perder o turno.
 */
const APELIDOS: Record<string, string> = {
  preguntas: 'perguntas',
  respuestas: 'respostas',
  licencias: 'licencas',
  'licenças': 'licencas',
  promesas_cumplidas: 'promessas_cumpridas',
  pregunta: 'pergunta',
  respuesta: 'resposta',
  rechazo: 'recusou',
  'rechazó': 'recusou',
  concedida_: 'concedida',
};

function desapelidar(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(desapelidar);
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[APELIDOS[k] ?? k] = desapelidar(val);
  return out;
}

/** Lê o campo `registro` do fechamento. Ausente ou fora do formato = null (o turno segue). */
export function lerRegistroDoFechamento(bruto: unknown): RegistroDoTurno | null {
  if (bruto === undefined || bruto === null) return null;
  const p = registroDoTurnoSchema.safeParse(desapelidar(bruto));
  return p.success ? p.data : null;
}

/**
 * O pedaço da instrução de fechamento que pede o registro. Mora aqui, junto do
 * schema que o valida (a mesma regra de `declaracao.ts`: texto e parser mudam
 * JUNTOS).
 */
export const REGISTRO_INSTRUCTION =
  ' Inclua também o campo "registro", com o que aconteceu NESTE turno: ' +
  '{"perguntas": [{"tema": "…", "pergunta": "…"}], "respostas": [{"tema": "…", "resposta": "…", "recusou": false}], ' +
  '"licencas": [{"tema": "…", "concedida": true}], "promessas_cumpridas": ["…"]}. ' +
  'Em "perguntas", cada pergunta que você fez ao cliente neste turno, com um tema curto de 2 a 4 palavras ' +
  '(ex.: "data do acidente"); se ela já está na "Conversa até aqui", use o MESMO tema. ' +
  'Em "respostas", o que o cliente respondeu ou contou neste turno, resumido em até 80 caracteres, com o tema da pergunta ' +
  '("recusou": true quando ele não quis responder). Em "licencas", a autorização que ele deu ou negou (ex.: "dados de saúde"). ' +
  'Em "promessas_cumpridas", o texto das promessas anteriores que você cumpriu agora. ' +
  'Saúde só como tema e "sim"/"informado": nunca diagnóstico, CID ou nome de remédio. Listas vazias quando não houver.';

// ─── O item ──────────────────────────────────────────────────────────────────

export type TipoDoItem = 'pergunta' | 'licenca' | 'promessa';
export type StatusDoItem = 'sem_resposta' | 'respondida' | 'recusada' | 'concedida' | 'negada' | 'pendente' | 'cumprida';
export type StatusEfetivo = StatusDoItem | 'vencida';

export interface ItemDoRegistro {
  id: string | null;
  tipo: TipoDoItem;
  tema: string;
  chave: string;
  status: StatusDoItem;
  pergunta: string | null;
  resposta: string | null;
  prazo: Date | null;
  vezes: number;
  agentId: string | null;
  conversationId: string | null;
  jobId: string | null;
  criadoEm: Date;
  atualizadoEm: Date;
  resolvidoEm: Date | null;
}

// ─── Saneamento (saúde, CID, telefone) ──────────────────────────────────────

/** Termos que identificam diagnóstico, lesão ou remédio — nunca entram no registro. */
const DIAGNOSTICO = new RegExp(
  [
    'fratur', '\\bles(?:ão|ao|ões|oes)\\b', 'sequel', 'amput', 'cirurg', '\\boperad[oa]s?\\b', 'h[eé]rnia', '\\bavc\\b',
    'derrame', 'infart', 'c[aâ]ncer', 'tumor', 'diabet', 'hipertens', 'depress(?:ão|ao|ivo|iva)', 'ansiedade',
    'p[aâ]nico', 'esquizo', 'bipolar', 'autis', '\\btdah\\b', '\\bhiv\\b', '\\baids\\b', 'epilep', 'artros', 'artrit',
    'tendinit', 'bursit', 'lombalg', 'ci[aá]tic', '\\bcoluna\\b', 'ortoped', 'psiquiatr', '\\bcaps\\b', 'rem[eé]dio',
    'medicament', 'comprimido', '\\d+\\s?mg\\b', 'dipirona', 'ibuprofeno', 'paracetamol', 'rivotril', 'clonazepam',
    'fluoxetina', 'sertralina', 'insulina', 'quimioter', 'radioterap', 'hemodi[aá]lis', 'transplant', 'parapleg',
    'tetrapleg', 'cegueira', 'surdez', 'queimadura', 'traumatismo', 'luxa[cç](?:ão|ao)', 'entorse', 'ruptura',
    'rompiment', 'ligamento', 'menisco', '\\bquebr(?:ou|ei|ado|ada|aram)\\b', '\\bcid\\b',
  ].join('|'),
  'i',
);

/** Temas de saúde genéricos: o tema pode ficar, a resposta vira só sim/não/não sabe/informado. */
const SAUDE_GENERICA =
  /(sa[uú]de|m[eé]dic|afast|licen[cç]a|atestado|laudo|per[ií]cia|tratament|doen[cç]a|diagn|exame|internad|hospital|incapac|consent)/i;

/**
 * NOME DE BENEFÍCIO DO INSS NÃO É DADO DE SAÚDE (PC-038) — mas só quando vem
 * sozinho. Lista FECHADA: "auxílio-doença" casava com "doença" e "Benefício
 * negado: auxílio-doença" virava "informado", no card e no registro que a IA
 * relê. "Aposentadoria por incapacidade permanente" é o nome atual da
 * aposentadoria por invalidez (o mesmo benefício).
 *
 * O nome só deixa de ser saúde quando o RESTO do texto (sem o nome) tem apenas
 * sim/não, data, mês/ano, "negado/cortado/indeferido/em análise/pedido" e
 * conectivos. Qualquer outra palavra ("por fibromialgia", "por causa do
 * lúpus") → continua saúde: a lista de doenças do código não é completa, e o
 * nome do benefício não pode virar a porta de um diagnóstico que ela não
 * conhece (revisão do PC-038).
 */
const NOMES_DE_BENEFICIO = new RegExp(
  [
    'aux[ií]lio[\\s-]+doen[cç]a',
    'aux[ií]lio[\\s-]+por[\\s-]+incapacidade(?:[\\s-]+(?:tempor[aá]ria|permanente))?',
    'aposentadoria[\\s-]+por[\\s-]+incapacidade(?:[\\s-]+permanente)?',
    'aposentadoria[\\s-]+por[\\s-]+invalidez',
    '(?:bpc|loas)(?:[\\s/-]+loas)?[\\s-]+(?:(?:da|para|de)[\\s-]+pessoa[\\s-]+com[\\s-]+|por[\\s-]+|de[\\s-]+)?defici[eê]n(?:cia|te)',
  ].join('|'),
  'gi',
);

/** O que pode estar ao lado do nome do benefício sem que a frase vire saúde (sem acento). */
const PALAVRAS_AO_LADO_DO_BENEFICIO = new Set([
  'sim', 's', 'nao', 'n',
  'negado', 'negada', 'negados', 'negadas', 'cortado', 'cortada', 'cortados', 'cortadas',
  'indeferido', 'indeferida', 'indeferidos', 'indeferidas', 'analise', 'pedido', 'pedida', 'pedidos', 'pedidas',
  'e', 'ou', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'por', 'pelo', 'pela', 'para', 'pra',
  'o', 'a', 'os', 'as', 'um', 'uma', 'que', 'foi', 'ja', 'ainda', 'mas', 'desde', 'ate', 'ha',
  'dia', 'mes', 'ano', 'anos', 'meses',
  'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]);

function semAcento(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * O texto traz um nome de benefício da lista e, fora dele, só palavras neutras
 * (`true`) ou mais alguma coisa (`false`)? `null` quando não há nome de
 * benefício. Puro.
 */
function soNomeDeBeneficio(texto: string): boolean | null {
  const resto = texto.replace(NOMES_DE_BENEFICIO, ' ');
  if (resto === texto) return null;
  return semAcento(resto)
    .split(/[^a-z0-9]+/)
    .every((p) => p === '' || /^\d+$/.test(p) || PALAVRAS_AO_LADO_DO_BENEFICIO.has(p));
}

const CID_CODIGO = /\b(?:CID[\s:.-]*)?[A-TV-Z]\d{2}(?:\.\d{1,2})?\b/g;
const CID_PALAVRA = /\bcid\b[\s:.-]*\S*/gi;
const TELEFONE = /\+?\d[\d\s().-]{7,}\d/g;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

/** Tira CID, telefone e e-mail; troca termo de diagnóstico por "[saúde]". Puro. */
export function sanearTexto(texto: string): string {
  return texto
    .replace(CID_PALAVRA, '')
    .replace(CID_CODIGO, '')
    .replace(TELEFONE, '')
    .replace(EMAIL, '')
    .split(/(\s+)/)
    .map((pedaco) => (DIAGNOSTICO.test(pedaco) ? '[saúde]' : pedaco))
    .join('')
    .replace(/(\[saúde\]\s*){2,}/g, '[saúde] ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Saúde em TRÊS valores honestos (PC-038): "sim", "não", "não sabe". A
 * primeira palavra não basta, e o rótulo decide o sentido de "não consigo…".
 * A ordem importa: dúvida, recusa, limitação (só em rótulo de limitação),
 * "nunca mais…" fora dele, negação, sim.
 */
const NAO_SABE =
  /^(?:ainda )?(?:(?:nao|n) (?:sei|sabe|lembro|me lembro|tenho certeza|faco ideia)|sei la|nem sei|acho que|acho q|talvez)\b/;
/** "não posso falar" é recusa de responder, não limitação: nem sim, nem não. */
const RECUSA = /^(?:nao|n) (?:posso|pode|consigo|quero) (?:dizer|falar|informar|responder|contar|passar|explicar)\b/;
/**
 * Limitação que continua: "não consigo", "não posso", "não aguento", "não dá
 * mais", "não consegui mais…", "nunca mais consegui…". "Não consegui o laudo"
 * (passado, uma vez) não é limitação.
 */
const LIMITACAO =
  /^(?:nao|n) (?:consigo|consegue|conseguem|posso|pode|podem|aguento|aguenta)\b|^(?:nao|n) da mais\b|^(?:nao|n) (?:consegui|conseguiu|pude) mais\b|^nunca mais (?:consig|consegu|pud|poss|pod|aguent|trabalh|volt)/;
/** "nunca mais consegui…" fora de rótulo de limitação não é "não": é informado. */
const NUNCA_MAIS_CAPACIDADE = /^nunca mais (?:consig|consegu|pud|poss|pod|aguent|trabalh|volt)/;
const NAO = /^(?:ainda nao|nao|n|negativo|nem|prefiro nao|nunca|jamais|nenhum|nenhuma|nada)\b/;
const SIM = /^(?:sim|s|pode|claro|autorizo|ok|tudo bem|aceito|concordo|positivo)\b/;

/**
 * Rótulo que pergunta pela LIMITAÇÃO (sequela, dificuldade, limitação, "não
 * consegue trabalhar"): só ali "não consigo…" afirma ("sim"). Rótulo de
 * capacidade AFIRMADA ("Consegue trabalhar", "Ainda trabalha") fica de fora de
 * propósito: lá "não consigo" é "não", e tratá-lo como limitação inverteria.
 */
const ROTULO_DE_LIMITACAO =
  /\b(?:sequel|dificuldad|limitac|limitad)|\b(?:nao|sem) (?:consegue|conseguir|pode|poder|trabalha|trabalhar)\b/;
/**
 * Rótulo de capacidade AFIRMADA ("Consegue trabalhar", "Pode…", "Ainda
 * trabalha"): ali "não consigo…" responde a pergunta e é "não".
 */
const ROTULO_DE_CAPACIDADE = /^(?:consegue|pode|ainda trabalha|trabalha)\b/;
/** "não consegui/pude…" (uma vez, sem "mais"): em rótulo de limitação não diz sim nem não. */
const PASSADO_DE_LIMITACAO = /^(?:nao|n) (?:consegui|conseguiu|pude)\b/;
/** Rótulo que pergunta por data ou prazo: ali a data sozinha já é "sim · <data>". */
const ROTULO_DE_DATA = /^(?:data|quando)\b|\bprazo\b|\bdata marcada\b/;

/**
 * "sim" / "não" / "não sabe" quando a resposta diz isso; senão `null`.
 * "não sei", "acho que" → "não sabe"; "não", "não tenho", "ainda não",
 * "nunca" → "não". Em rótulo de limitação, "não consigo…"/"não posso…"/
 * "nunca mais consegui…" → "sim" (afirmam a limitação); fora dele, "nunca mais
 * consegui…" → `null` (informado). Frase de limitação que não responde o
 * rótulo ("Afastado mais de 60 dias: não consigo trabalhar desde março";
 * "Sequela: não consegui voltar a trabalhar") → `null` (informado), nunca um
 * "não" pela primeira palavra; só o rótulo de capacidade afirmada ("Consegue
 * trabalhar", "Ainda trabalha") lê "não consigo" como "não". Puro.
 */
export function simOuNao(resposta: string, rotulo = ''): 'sim' | 'não' | 'não sabe' | null {
  const t = semAcento(normalizarParaComparacao(resposta));
  const r = semAcento(rotulo);
  if (NAO_SABE.test(t)) return 'não sabe';
  if (RECUSA.test(t)) return null;
  if (ROTULO_DE_LIMITACAO.test(r) && LIMITACAO.test(t)) return 'sim';
  if (NUNCA_MAIS_CAPACIDADE.test(t)) return null;
  if (
    !ROTULO_DE_CAPACIDADE.test(r) &&
    (LIMITACAO.test(t) || (ROTULO_DE_LIMITACAO.test(r) && PASSADO_DE_LIMITACAO.test(t)))
  ) {
    return null;
  }
  if (NAO.test(t)) return 'não';
  if (SIM.test(t)) return 'sim';
  return null;
}

const MESES = 'janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
const DATA_NUMERICA = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g;
const DATA_POR_EXTENSO = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:\\d{1,2}\\s+de\\s+)?(?:${MESES})(?:\\s+de\\s+\\d{4}|\\/\\d{4})?(?![\\p{L}\\p{N}])`,
  'iu',
);
const DIA_N = /(?<![\p{L}\p{N}])dia\s+(\d{1,2})(?![\p{L}\p{N}/])/iu;

/**
 * A primeira data da resposta ("20/11", "20/11/2026", "março", "10 de março
 * de 2026", "dia 20"), ou `null`. Só a data — nunca o texto em volta, que pode
 * trazer nome de doença. Puro.
 */
export function dataNaResposta(resposta: string): string | null {
  for (const m of resposta.matchAll(DATA_NUMERICA)) {
    const dia = Number(m[1]);
    const mes = Number(m[2]);
    if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) return m[0];
  }
  const extenso = DATA_POR_EXTENSO.exec(resposta);
  if (extenso) return extenso[0].replace(/\s+/g, ' ').toLowerCase();
  const dia = DIA_N.exec(resposta);
  if (dia && Number(dia[1]) >= 1 && Number(dia[1]) <= 31) return `dia ${Number(dia[1])}`;
  return null;
}

/**
 * A resposta de saúde como pode ser gravada: "sim", "não", "não sabe",
 * "informado" e, quando ela traz uma data, só a data ao lado: "sim · <data>"
 * se a resposta disse sim ou o rótulo pergunta data/prazo ("Prazo ou data
 * marcada: perícia dia 20/11" → "sim · 20/11"); senão "informado · <data>".
 * Nunca diagnóstico, CID ou remédio. Idempotente: o valor gravado passa por
 * aqui de novo e sai igual. Puro.
 */
export function respostaDeSaude(resposta: string, rotulo = ''): string {
  const valor = simOuNao(resposta, rotulo);
  if (valor === 'não' || valor === 'não sabe') return valor;
  const data = dataNaResposta(resposta);
  if (data) return `${valor === 'sim' || ROTULO_DE_DATA.test(semAcento(rotulo)) ? 'sim' : 'informado'} · ${data}`;
  return valor ?? 'informado';
}

/**
 * O assunto é de saúde? (tema ou resposta). Nome de benefício da lista
 * fechada só deixa de contar quando vem sozinho (`soNomeDeBeneficio`).
 */
export function ehDeSaude(...textos: Array<string | null | undefined>): boolean {
  return textos.some((t) => {
    if (typeof t !== 'string') return false;
    const so = soNomeDeBeneficio(t);
    if (so !== null) return !so;
    return DIAGNOSTICO.test(t) || SAUDE_GENERICA.test(t);
  });
}

function cortar(texto: string, n: number): string {
  const t = texto.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

/**
 * O item como pode ser gravado: tema sem diagnóstico; resposta de saúde só
 * "sim"/"não"/"não sabe"/"informado", com a data ao lado quando houver
 * (`respostaDeSaude`, que lê o tema); nada de CID, telefone ou e-mail. Nome de
 * benefício sozinho ("auxílio-doença") não é saúde. Puro.
 */
export function sanearItem<T extends Pick<ItemDoRegistro, 'tema' | 'pergunta' | 'resposta'>>(item: T): T {
  const temaBruto = item.tema;
  const tema = DIAGNOSTICO.test(temaBruto) ? 'saúde' : cortar(sanearTexto(temaBruto) || 'assunto', 80);
  let resposta = item.resposta;
  if (resposta !== null) {
    if (ehDeSaude(temaBruto, resposta)) resposta = respostaDeSaude(resposta, temaBruto);
    else resposta = cortar(sanearTexto(resposta), 80) || null;
  }
  const pergunta = item.pergunta === null ? null : cortar(sanearTexto(item.pergunta), 240) || null;
  return { ...item, tema, resposta, pergunta };
}

// ─── A mescla (pura) ────────────────────────────────────────────────────────

/** A chave do item: o tema sem acento, caixa nem pontuação. Puro. */
export function chaveDoTema(tema: string): string {
  const c = tema
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 120);
  return c || 'assunto';
}

/** Limiar para casar o tema do turno com um item que já existe (mesmo tipo). */
const LIMIAR_TEMA = 0.8;
const LIMIAR_PROMESSA = 0.7;
const LIMIAR_PROMESSA_CUMPRIDA = 0.6;

function achar(itens: ItemDoRegistro[], tipo: TipoDoItem, texto: string, limiar: number): ItemDoRegistro | null {
  const chave = chaveDoTema(texto);
  const exato = itens.find((i) => i.tipo === tipo && i.chave === chave);
  if (exato) return exato;
  let melhor: ItemDoRegistro | null = null;
  let nota = 0;
  // Números diferentes = itens diferentes ("documento 1" × "documento 2").
  const numeros = (c: string) => (c.match(/\d+/g) ?? []).join(',');
  for (const i of itens) {
    if (i.tipo !== tipo) continue;
    if (numeros(i.chave) !== numeros(chave)) continue;
    const n = similaridadeDice(i.chave, chave);
    if (n >= limiar && n > nota) {
      melhor = i;
      nota = n;
    }
  }
  return melhor;
}

function prazoDe(prazo: string | null): Date | null {
  if (prazo === null) return null;
  const d = new Date(prazo);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface ContextoDaMescla {
  agora: Date;
  agentId: string | null;
  conversationId: string | null;
  jobId: string | null;
}

/**
 * Mescla o delta do turno com o registro que já existe. Devolve SÓ os itens
 * novos ou alterados, já saneados (o que o banco tem de gravar). Puro.
 *
 * Ordem: respostas antes de perguntas (a resposta fecha a pergunta anterior; a
 * pergunta que volta a ser feita não desfaz a resposta), depois licenças e
 * promessas.
 */
export function mesclarRegistro(
  atuais: readonly ItemDoRegistro[],
  turno: RegistroDoTurno | null,
  promessas: readonly Promessa[],
  ctx: ContextoDaMescla,
): ItemDoRegistro[] {
  const itens: ItemDoRegistro[] = atuais.map((i) => ({ ...i }));
  const mudados = new Set<ItemDoRegistro>();
  const novo = (tipo: TipoDoItem, tema: string, status: StatusDoItem): ItemDoRegistro => {
    const temaSaneado = sanearItem({ tema, pergunta: null, resposta: null }).tema;
    const i: ItemDoRegistro = {
      id: null,
      tipo,
      tema: temaSaneado,
      chave: chaveDoTema(temaSaneado),
      status,
      pergunta: null,
      resposta: null,
      prazo: null,
      vezes: 0,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      jobId: ctx.jobId,
      criadoEm: ctx.agora,
      atualizadoEm: ctx.agora,
      resolvidoEm: null,
    };
    // Um tema saneado pode colidir com outro ("saúde"): reaproveita o item.
    const ja = itens.find((x) => x.tipo === tipo && x.chave === i.chave);
    if (ja) return ja;
    itens.push(i);
    return i;
  };
  const tocar = (i: ItemDoRegistro): void => {
    i.atualizadoEm = ctx.agora;
    i.agentId = ctx.agentId ?? i.agentId;
    i.conversationId = ctx.conversationId ?? i.conversationId;
    i.jobId = ctx.jobId ?? i.jobId;
    mudados.add(i);
  };

  for (const r of turno?.respostas ?? []) {
    const i = achar(itens, 'pergunta', r.tema, LIMIAR_TEMA) ?? novo('pergunta', r.tema, 'respondida');
    i.status = r.recusou ? 'recusada' : 'respondida';
    i.resposta = r.recusou ? null : r.resposta || 'informado';
    i.resolvidoEm = ctx.agora;
    tocar(i);
  }
  for (const p of turno?.perguntas ?? []) {
    const i = achar(itens, 'pergunta', p.tema, LIMIAR_TEMA) ?? novo('pergunta', p.tema, 'sem_resposta');
    i.vezes += 1;
    if (p.pergunta) i.pergunta = p.pergunta;
    tocar(i);
  }
  for (const l of turno?.licencas ?? []) {
    const i = achar(itens, 'licenca', l.tema, LIMIAR_TEMA) ?? novo('licenca', l.tema, l.concedida ? 'concedida' : 'negada');
    i.status = l.concedida ? 'concedida' : 'negada';
    i.vezes = Math.max(1, i.vezes);
    i.resolvidoEm = ctx.agora;
    tocar(i);
  }
  for (const p of promessas) {
    const i = achar(itens, 'promessa', p.o_que, LIMIAR_PROMESSA) ?? novo('promessa', p.o_que, 'pendente');
    i.status = 'pendente';
    i.vezes += 1;
    i.prazo = prazoDe(p.prazo) ?? i.prazo;
    i.resolvidoEm = null;
    tocar(i);
  }
  for (const texto of turno?.promessas_cumpridas ?? []) {
    const i = achar(itens, 'promessa', texto, LIMIAR_PROMESSA_CUMPRIDA);
    if (!i || i.status !== 'pendente') continue;
    i.status = 'cumprida';
    i.resolvidoEm = ctx.agora;
    tocar(i);
  }
  return [...mudados].map((i) => sanearItem(i));
}

// ─── O status na leitura (vencida) ──────────────────────────────────────────

/** A promessa é de a EQUIPE falar com o cliente? (ela se cumpre quando a equipe fala) */
export function promessaDaEquipe(texto: string): boolean {
  const t = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /(equipe|advogad|doutor|\bdra?\b|escritorio|especialista|atendente|alguem|uma pessoa|colega|retorn|ligar|ligacao|entrar em contato|falar com voce|fala com voce)/.test(
    t,
  );
}

/**
 * O status que vale AGORA. Promessa pendente da equipe vira cumprida quando a
 * equipe falou com o cliente depois dela; pendente com prazo passado vira
 * VENCIDA. Puro.
 */
export function statusEfetivo(item: ItemDoRegistro, agora: Date, equipeFalouEm: Date | null): StatusEfetivo {
  if (item.tipo !== 'promessa' || item.status !== 'pendente') return item.status;
  if (equipeFalouEm !== null && equipeFalouEm > item.atualizadoEm && promessaDaEquipe(item.tema)) return 'cumprida';
  if (item.prazo !== null && item.prazo.getTime() < agora.getTime()) return 'vencida';
  return 'pendente';
}

// ─── O bloco do turno (≤ 600 caracteres) ────────────────────────────────────

export const TETO_DO_BLOCO = 600;

function partesDaHora(d: Date, fuso: string): { dia: string; hora: string } {
  try {
    const p = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: fuso,
    }).formatToParts(d);
    const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
    return { dia: `${v('day')}/${v('month')}`, hora: `${v('hour')}h${v('minute')}` };
  } catch {
    return { dia: '', hora: '' };
  }
}

/** "10h02" no mesmo dia; "03/11 10h02" em outro. Puro. */
export function quandoCurto(d: Date, agora: Date, fuso: string): string {
  const a = partesDaHora(d, fuso);
  const b = partesDaHora(agora, fuso);
  if (!a.hora) return '';
  return a.dia === b.dia ? a.hora : `${a.dia} ${a.hora}`;
}

interface Secao {
  titulo: string;
  linhas: string[];
  omitidas: number;
}

function montar(secoes: Secao[], rodape: string): string {
  const corpo = secoes
    .filter((s) => s.linhas.length > 0 || s.omitidas > 0)
    .map((s) => `${s.titulo}: ${s.linhas.join('; ')}${s.omitidas > 0 ? ` (+${s.omitidas})` : ''}`);
  if (corpo.length === 0) return '';
  return ['## Conversa até aqui (registro do sistema, vale para qualquer agente)', ...corpo, rodape].join('\n');
}

/**
 * O bloco do sufixo por lead: JÁ PERGUNTADO E RESPONDIDO · SEM RESPOSTA ·
 * LICENÇAS · PROMETIDO, no máximo 600 caracteres (os itens mais antigos saem
 * primeiro, com "(+N)"). Vazio quando não há nada. Puro.
 */
export function renderRegistro(
  itens: readonly ItemDoRegistro[],
  agora: Date,
  fuso: string,
  equipeFalouEm: Date | null,
): string {
  const recentes = [...itens].sort((a, b) => b.atualizadoEm.getTime() - a.atualizadoEm.getTime());
  const quando = (d: Date | null) => (d ? quandoCurto(d, agora, fuso) : '');
  const respondidas = recentes
    .filter((i) => i.tipo === 'pergunta' && (i.status === 'respondida' || i.status === 'recusada'))
    .map((i) => {
      const h = quando(i.resolvidoEm ?? i.atualizadoEm);
      const r = i.status === 'recusada' ? 'não quis responder' : cortar(i.resposta ?? 'informado', 60);
      return `${cortar(i.tema, 40)} → ${r}${h ? ` (${h})` : ''}`;
    });
  const semResposta = recentes
    .filter((i) => i.tipo === 'pergunta' && i.status === 'sem_resposta')
    .map((i) => `${cortar(i.tema, 40)}${i.vezes > 1 ? ` (${i.vezes}x)` : ''}`);
  const licencas = recentes
    .filter((i) => i.tipo === 'licenca')
    .map((i) => {
      const h = quando(i.resolvidoEm ?? i.atualizadoEm);
      return `${cortar(i.tema, 40)}: ${i.status === 'concedida' ? 'sim' : 'não'}${h ? ` (${h})` : ''}`;
    });
  const prometido = recentes
    .filter((i) => i.tipo === 'promessa')
    .map((i) => ({ i, s: statusEfetivo(i, agora, equipeFalouEm) }))
    .filter(({ s }) => s === 'pendente' || s === 'vencida')
    .map(({ i, s }) => {
      const prazo = i.prazo ? quando(i.prazo) : '';
      const situacao = s === 'vencida' ? `VENCIDA${prazo ? ` em ${prazo}` : ''}` : `pendente${prazo ? ` até ${prazo}` : ''}`;
      return `${cortar(i.tema, 90)} (${situacao})`;
    });

  const secoes: Secao[] = [
    { titulo: 'JÁ PERGUNTADO E RESPONDIDO', linhas: respondidas, omitidas: 0 },
    { titulo: 'SEM RESPOSTA', linhas: semResposta, omitidas: 0 },
    { titulo: 'LICENÇAS', linhas: licencas, omitidas: 0 },
    { titulo: 'PROMETIDO', linhas: prometido, omitidas: 0 },
  ];
  const rodape =
    'Não pergunte de novo o que já foi respondido nem peça licença já dada. Promessa vencida: não prometa de novo.';
  let texto = montar(secoes, rodape);
  // Corta pelo item mais antigo da seção mais longa até caber.
  while (texto.length > TETO_DO_BLOCO) {
    const maior = secoes.reduce((a, b) => (b.linhas.length > a.linhas.length ? b : a));
    if (maior.linhas.length === 0) break;
    maior.linhas.pop();
    maior.omitidas += 1;
    texto = montar(secoes, rodape);
  }
  if (texto.length > TETO_DO_BLOCO) texto = `${texto.slice(0, TETO_DO_BLOCO - 1)}…`;
  return texto;
}

// ─── Banco ──────────────────────────────────────────────────────────────────

export interface LinhaDoRegistro {
  id: string;
  tipo: TipoDoItem;
  tema: string;
  chave: string;
  status: StatusDoItem;
  pergunta: string | null;
  resposta: string | null;
  prazo: Date | string | null;
  vezes: number;
  agent_id: string | null;
  conversation_id: string | null;
  job_id: string | null;
  criado_em: Date | string;
  atualizado_em: Date | string;
  resolvido_em: Date | string | null;
}

const data = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));

export function itemDaLinha(r: LinhaDoRegistro): ItemDoRegistro {
  return {
    id: r.id,
    tipo: r.tipo,
    tema: r.tema,
    chave: r.chave,
    status: r.status,
    pergunta: r.pergunta,
    resposta: r.resposta,
    prazo: data(r.prazo),
    vezes: r.vezes,
    agentId: r.agent_id,
    conversationId: r.conversation_id,
    jobId: r.job_id,
    criadoEm: new Date(r.criado_em),
    atualizadoEm: new Date(r.atualizado_em),
    resolvidoEm: data(r.resolvido_em),
  };
}

/** O registro do contato, mais recente primeiro (teto de 200 itens). */
export async function lerRegistro(db: Queryable, organizationId: string, contactId: string): Promise<ItemDoRegistro[]> {
  const { rows } = await db.query<LinhaDoRegistro>(
    `select id, tipo, tema, chave, status, pergunta, resposta, prazo, vezes, agent_id,
            conversation_id, job_id, criado_em, atualizado_em, resolvido_em
       from registro_da_conversa
      where organization_id = $1 and contact_id = $2
      order by atualizado_em desc
      limit 200`,
    [organizationId, contactId],
  );
  return rows.map(itemDaLinha);
}

/** Quando a equipe (uma pessoa) falou com o cliente pela última vez. */
export async function equipeFalouPorUltimo(
  db: Queryable,
  organizationId: string,
  contactId: string,
): Promise<Date | null> {
  const { rows } = await db.query<{ quando: Date | string | null }>(
    `select max(created_at) as quando from messages
      where organization_id = $1 and contact_id = $2
        and direction = 'outbound' and sent_via in ('crm', 'user', 'external_device')
        and status <> 'failed'`,
    [organizationId, contactId],
  );
  return data(rows[0]?.quando ?? null);
}

/** Grava os itens mesclados (upsert pela chave do item). */
export async function gravarItens(
  db: Queryable,
  organizationId: string,
  contactId: string,
  itens: readonly ItemDoRegistro[],
): Promise<number> {
  if (itens.length === 0) return 0;
  await guardServiceEffect();
  let gravados = 0;
  for (const i of itens) {
    await db.query(
      `insert into registro_da_conversa
         (organization_id, contact_id, tipo, tema, chave, status, pergunta, resposta, prazo, vezes,
          agent_id, conversation_id, job_id, criado_em, atualizado_em, resolvido_em)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       on conflict (organization_id, contact_id, tipo, chave) do update set
         tema = excluded.tema,
         status = excluded.status,
         pergunta = coalesce(excluded.pergunta, registro_da_conversa.pergunta),
         resposta = excluded.resposta,
         prazo = excluded.prazo,
         vezes = excluded.vezes,
         agent_id = coalesce(excluded.agent_id, registro_da_conversa.agent_id),
         conversation_id = coalesce(excluded.conversation_id, registro_da_conversa.conversation_id),
         job_id = coalesce(excluded.job_id, registro_da_conversa.job_id),
         atualizado_em = excluded.atualizado_em,
         resolvido_em = excluded.resolvido_em`,
      [
        organizationId,
        contactId,
        i.tipo,
        i.tema,
        i.chave,
        i.status,
        i.pergunta,
        i.resposta,
        i.prazo,
        Math.max(0, Math.min(i.vezes, 1000)),
        i.agentId,
        i.conversationId,
        i.jobId,
        i.criadoEm,
        i.atualizadoEm,
        i.resolvidoEm,
      ],
    );
    gravados += 1;
  }
  return gravados;
}

/**
 * O fechamento do turno grava o registro: lê o que existe, mescla o delta e as
 * promessas declaradas, grava o que mudou. Devolve quantos itens mudaram.
 */
export async function aplicarRegistroDoFechamento(
  db: Queryable,
  args: {
    organizationId: string;
    contactId: string;
    registro: unknown;
    promessas: readonly Promessa[];
    contexto: ContextoDaMescla;
  },
): Promise<number> {
  const turno = lerRegistroDoFechamento(args.registro);
  if (turno === null && args.promessas.length === 0) return 0;
  const atuais = await lerRegistro(db, args.organizationId, args.contactId);
  const mudados = mesclarRegistro(atuais, turno, args.promessas, args.contexto);
  return gravarItens(db, args.organizationId, args.contactId, mudados);
}

/** O bloco do turno, lido do banco. Falha = vazio (o turno segue sem ele). */
export async function blocoDoRegistro(
  db: Queryable,
  args: { organizationId: string; contactId: string; agora: Date; fuso: string },
): Promise<string> {
  const itens = await lerRegistro(db, args.organizationId, args.contactId);
  if (itens.length === 0) return '';
  const equipe = itens.some((i) => i.tipo === 'promessa' && i.status === 'pendente')
    ? await equipeFalouPorUltimo(db, args.organizationId, args.contactId)
    : null;
  return renderRegistro(itens, args.agora, args.fuso, equipe);
}

/**
 * As perguntas que o registro diz que JÁ foram respondidas (ou recusadas), para
 * a trava de repetição (PC-018) — sem janela de tempo: é o que sobrevive à
 * compactação e à troca de agente.
 */
export interface PerguntaRespondida {
  id: string;
  /** O texto contra o qual comparar: a pergunta como foi feita, ou o tema. */
  texto: string;
  tema: string;
  resposta: string | null;
  quando: Date;
}

export function perguntasRespondidas(itens: readonly ItemDoRegistro[]): PerguntaRespondida[] {
  return itens
    .filter((i) => i.tipo === 'pergunta' && (i.status === 'respondida' || i.status === 'recusada') && i.id !== null)
    .map((i) => ({
      id: i.id!,
      texto: i.pergunta ?? i.tema,
      tema: i.tema,
      resposta: i.status === 'recusada' ? 'não quis responder' : i.resposta,
      quando: i.resolvidoEm ?? i.atualizadoEm,
    }));
}
