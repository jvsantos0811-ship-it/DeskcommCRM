/**
 * FRASES PROIBIDAS POR ORGANIZAÇÃO (PC-022, Pacote Conversa) — barradas antes
 * de a mensagem sair.
 *
 * ## O defeito
 *
 * As muletas aparecem mesmo proibidas no prompt ("sem pressa nenhuma" 3 vezes
 * numa conversa; "Anotado", "Perfeito", "Obrigada pela informação" nos pulsos do
 * Gestor). O prompt orienta; só o CRM garante.
 *
 * ## A régua
 *
 * Uma lista por organização (`organizations.settings.conversa.frases_proibidas`),
 * editável pelo admin em Configurações › IA. Ausente = a lista padrão
 * (`FRASES_PADRAO`, escrita para o atendimento de escritório de advocacia — a
 * decisão do João de 03/11 é que o pacote vale para todas as organizações).
 *
 * A busca ignora maiúscula, acento e pontuação, e casa por palavra inteira com
 * variação simples: "sem pressa" pega "sem pressa nenhuma"; "Entendi" pega
 * "Entendi." mas não "entendimento".
 *
 * ## O que acontece quando acha
 *
 * Antes de enviar (resposta e follow-up escrito pela IA): 1ª vez no turno → um
 * erro de ensino ("tire 'X' e diga de outro jeito") e o modelo reescreve. Se a
 * reescrita ainda tiver: a frase SAI quando é só muleta isolada (ex.: "Perfeito!"
 * no começo — `removerMuletas`); senão a mensagem sai como está e fica
 * registrada. Nenhuma troca de palavra por outra sem o modelo reescrever (fica
 * artificial), exceto a muleta isolada. Mensagem sem frase proibida: nenhuma
 * chamada de modelo a mais (a busca é pura).
 *
 * Registro: ocorrências por frase por semana (`frases_proibidas_na_semana`),
 * na própria tela da lista.
 */
import { z } from 'zod';

import type { Queryable } from '../queue/queue';

// ─── A lista ────────────────────────────────────────────────────────────────

/** A lista padrão (PC-022, item 2). O admin edita na tela. */
export const FRASES_PADRAO: readonly string[] = [
  'sem pressa',
  'quando tiver um minutinho',
  'sem compromisso',
  'passando para saber',
  'Anotado',
  'Registrei',
  'Está salvo',
  'Obrigada pela informação',
  'Isso ajuda a equipe',
  'Entendi',
  'Compreendo',
  'Perfeito',
  'Ótimo',
  'Certo, então',
  'não paga nada',
];

export const TETO_DE_FRASES = 60;

/** O que a tela grava. `null` em `lista` nunca: para voltar ao padrão, grava o padrão. */
export const frasesProibidasSchema = z.strictObject({
  lista: z
    .array(z.string().trim().min(2).max(80))
    .max(TETO_DE_FRASES)
    .transform((l) => dedupe(l)),
});
export type FrasesProibidasGravadas = z.infer<typeof frasesProibidasSchema>;

function dedupe(lista: readonly string[]): string[] {
  const vistas = new Set<string>();
  const out: string[] = [];
  for (const f of lista) {
    const k = normalizarFrase(f);
    if (!k || vistas.has(k)) continue;
    vistas.add(k);
    out.push(f.trim());
  }
  return out;
}

/** A lista em vigor: a da organização, ou a padrão quando ela não gravou. Nunca lança. */
export function lerFrasesProibidas(settings: unknown): string[] {
  const conversa = (settings as { conversa?: unknown } | null)?.conversa;
  const cru = (conversa as { frases_proibidas?: unknown } | null)?.frases_proibidas;
  const p = frasesProibidasSchema.safeParse(cru);
  return p.success ? p.data.lista : [...FRASES_PADRAO];
}

// ─── A busca (pura) ─────────────────────────────────────────────────────────

/** Sem acento, sem caixa, pontuação vira espaço. Puro. */
export function normalizarFrase(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** As frases da lista que aparecem no texto (por palavra inteira). Puro. */
export function acharFrasesProibidas(texto: string, lista: readonly string[]): string[] {
  const t = ` ${normalizarFrase(texto)} `;
  if (t.trim() === '') return [];
  return lista.filter((f) => {
    const n = normalizarFrase(f);
    return n !== '' && t.includes(` ${n} `);
  });
}

const VARIANTES: Record<string, string> = {
  a: '[aáàâãä]',
  e: '[eéèêë]',
  i: '[iíìîï]',
  o: '[oóòôõö]',
  u: '[uúùûü]',
  c: '[cç]',
  n: '[nñ]',
};

/** A frase como expressão que casa no texto ORIGINAL (acento, caixa, pontuação entre palavras). */
function expressaoDaFrase(frase: string): string {
  return normalizarFrase(frase)
    .split(' ')
    .map((palavra) =>
      [...palavra].map((ch) => VARIANTES[ch] ?? ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''),
    )
    .join('[\\s,.;:!?-]+');
}

const PONTUACAO = '[,.;:!?…—–-]';

/**
 * Tira a frase quando ela é MULETA ISOLADA: sozinha numa frase ("Perfeito!",
 * "Entendi."), ou abrindo a frase seguida de pontuação ("Perfeito, me conta…",
 * "Certo, então: qual…"). A primeira letra do que sobra volta a ser maiúscula.
 * Devolve `null` quando alguma frase da lista ficaria no texto (não é muleta
 * isolada: o modelo é que tem de reescrever) ou quando não sobra nada. Puro.
 */
export function removerMuletas(texto: string, achadas: readonly string[]): string | null {
  // O marcador guarda ONDE algo saiu: só ali a primeira letra volta a ser
  // maiúscula (o resto do texto do modelo não é tocado).
  const MARCA = '\u0000';
  let out = texto;
  for (const frase of achadas) {
    const f = expressaoDaFrase(frase);
    // Começo do texto, de linha ou de frase: a frase + pontuação/espaço.
    // Só com PONTUAÇÃO depois: "Perfeito, me conta…" sai; "Perfeito para você" não.
    const re = new RegExp(
      `(^|[\\n.!?…]\\s*)${f}(?:\\s+(?:nenhuma|mesmo|demais|total))?\\s*${PONTUACAO}+\\s*`,
      'giu',
    );
    out = out.replace(re, `$1${MARCA}`);
    // Fim do texto, sozinha depois de uma frase: "…cidade? Perfeito."
    const fim = new RegExp(`([.!?…]\\s*)${f}\\s*${PONTUACAO}*$`, 'iu');
    out = out.replace(fim, '$1');
  }
  out = out
    .replace(new RegExp(`${MARCA}+\\s*(\\p{Ll})`, 'gu'), (_m, letra: string) => letra.toUpperCase())
    .replaceAll(MARCA, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (out === '') return null;
  if (acharFrasesProibidas(out, achadas).length > 0) return null;
  return out;
}

/** O erro de ensino: o que tirar. Puro. */
export function erroDeEnsinoDasFrases(achadas: readonly string[]): string {
  const lista = achadas.map((f) => JSON.stringify(f)).join(', ');
  return (
    `A mensagem tem ${achadas.length > 1 ? 'expressões que este escritório não usa' : 'uma expressão que este escritório não usa'}: ${lista}. ` +
    'Tire e diga de outro jeito, direto ao ponto (sem trocar por um sinônimo de muleta). A mensagem NÃO foi enviada.'
  );
}

// ─── Banco ──────────────────────────────────────────────────────────────────

/** A lista em vigor na organização. Falha de leitura = a padrão (o envio segue). */
export async function frasesDaOrganizacao(db: Queryable, organizationId: string): Promise<string[]> {
  try {
    const { rows } = await db.query<{ settings: unknown }>('select settings from organizations where id = $1', [
      organizationId,
    ]);
    return lerFrasesProibidas(rows[0]?.settings ?? null);
  } catch {
    return [...FRASES_PADRAO];
  }
}

export type DesfechoDaFrase = 'barrada' | 'removida' | 'enviada';

/**
 * Conta a ocorrência por frase e semana (segunda-feira no fuso da
 * organização). Sem chamada de modelo.
 */
export async function contarFrasesProibidas(
  db: Queryable,
  args: { organizationId: string; frases: readonly string[]; desfecho: DesfechoDaFrase; fuso: string },
): Promise<void> {
  if (args.frases.length === 0) return;
  const coluna = args.desfecho === 'barrada' ? 'barradas' : args.desfecho === 'removida' ? 'removidas' : 'enviadas';
  for (const frase of args.frases) {
    await db.query(
      `insert into frases_proibidas_na_semana (organization_id, frase, semana, ${coluna}, atualizado_em)
       values ($1, $2, (date_trunc('week', now() at time zone $3))::date, 1, now())
       on conflict (organization_id, frase, semana)
       do update set ${coluna} = frases_proibidas_na_semana.${coluna} + 1, atualizado_em = now()`,
      [args.organizationId, frase.trim().slice(0, 80), args.fuso],
    );
  }
}
