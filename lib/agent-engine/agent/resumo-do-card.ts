/**
 * O RESUMO DAS RESPOSTAS NA DESCRIÇÃO DO CARD (PC-026, item 2).
 *
 * A equipe que vai assumir em "Análise humana" ou "Aguardando assinatura" não
 * deveria abrir a conversa inteira para saber o que o cliente já respondeu. Um
 * bloco PRÓPRIO, dentro da descrição do negócio, traz só as respostas às
 * perguntas que o agente pede — uma linha por pergunta respondida:
 *
 *   === Resumo da IA · atualizado em 10/11 14:32 ===
 *   Já teve o bebê: sim
 *   Data do parto: março de 2026
 *   === fim do resumo ===
 *
 * ─── O que nunca acontece ────────────────────────────────────────────────────
 *
 *  - Tudo FORA do bloco é da equipe e não muda. Descrição sem bloco: o bloco
 *    entra no começo; com bloco: ele é trocado inteiro.
 *  - Sem lista de "Perguntas do resumo" no agente, nada é escrito e nenhuma IA
 *    é chamada (nada de adivinhar).
 *  - Nenhuma chamada por mensagem: o resumo atualiza só nos MOMENTOS (passagem
 *    para outro agente, passagem para pessoa ou caso aberto, mudança de etapa
 *    feita pela IA) — e no máximo UMA chamada barata por momento.
 *  - LGPD: telefone, CID e nome de etiqueta saem; saúde vira "sim"/"não"/
 *    "informado" (nunca diagnóstico ou remédio); dado de documento (CPF, RG,
 *    endereço, CEP, data de nascimento) nunca entra, mesmo que a pergunta peça.
 *
 * As respostas vêm do Registro da conversa (PC-019) e dos campos do negócio
 * CONFIRMADOS — nunca do texto livre da conversa inteira.
 */
import { ehDeSaude, lerRegistro, sanearTexto, simOuNao } from './registro-da-conversa';
import { extrairJsonDoTexto } from '@/lib/agent-engine/texto/extrair-json-do-texto';
import { camposDoFunil, escopoDoCampo } from '@/lib/leads/campos-do-funil';
import { statusDosCampos } from '@/lib/leads/status-dos-campos';
import { tagDeIdioma } from '@/lib/i18n/datas';
import { IDIOMA_PADRAO } from '@/lib/i18n/idiomas';

import type { Queryable } from '../queue/queue';

/** Até 15 perguntas por agente (o pedido). */
export const TETO_DE_PERGUNTAS = 15;
/** Cada rótulo de pergunta, até 80 caracteres. */
export const TETO_DO_ROTULO = 80;
/** Cada resposta no bloco, até 60 caracteres. */
export const TETO_DA_RESPOSTA = 60;
/** O bloco inteiro (cabeçalho e rodapé inclusos), até 600 caracteres. */
export const TETO_DO_BLOCO = 600;

export const INICIO_DO_BLOCO = '=== Resumo da IA · atualizado em ';
export const FIM_DO_BLOCO = '=== fim do resumo ===';

/** O bloco já gravado: do cabeçalho ao rodapé, com a quebra de linha que o segue. */
const BLOCO_GRAVADO = /=== Resumo da IA · atualizado em [^\n]*===\n[\s\S]*?=== fim do resumo ===\n?\n?/;

// ─── Puro ───────────────────────────────────────────────────────────────────

/** A lista do agente, limpa: sem vazio, sem repetida, até 15 de até 80 caracteres. */
export function normalizarPerguntasDoResumo(bruto: unknown): string[] {
  if (!Array.isArray(bruto)) return [];
  const vistas = new Set<string>();
  const saida: string[] = [];
  for (const v of bruto) {
    if (typeof v !== 'string') continue;
    const r = v.replace(/\s+/g, ' ').trim().slice(0, TETO_DO_ROTULO);
    const chave = comparavel(r);
    if (!r || vistas.has(chave)) continue;
    vistas.add(chave);
    saida.push(r);
    if (saida.length >= TETO_DE_PERGUNTAS) break;
  }
  return saida;
}

function comparavel(v: string): string {
  return v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A pergunta (ou a resposta) é sobre dado de documento? Esses nunca entram no bloco. */
const DOCUMENTO =
  /\b(cpf|rg|identidade|cnh|titulo de eleitor|cep|endereco|rua|avenida|logradouro|bairro|nascimento|nasceu|data de nasc|pis|nis|nit|ctps|carteira de trabalho n)/;
const NUMERO_DE_DOCUMENTO = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\b\d{5}-?\d{3}\b|\b\d{2}\.?\d{3}\.?\d{3}-?[\dxX]\b/;

/**
 * A linha como pode entrar no bloco, ou `null` quando ela não pode entrar
 * (documento, vazia). Saúde vira "sim"/"não"/"informado". Puro.
 */
export function sanearLinhaDoResumo(
  rotulo: string,
  resposta: string,
  etiquetas: readonly string[] = [],
): string | null {
  const r = resposta.replace(/\s+/g, ' ').trim();
  if (!r) return null;
  if (DOCUMENTO.test(comparavel(rotulo)) || DOCUMENTO.test(comparavel(r)) || NUMERO_DE_DOCUMENTO.test(r)) return null;
  let texto: string;
  if (ehDeSaude(rotulo, r)) {
    texto = simOuNao(r) ?? 'informado';
  } else {
    texto = sanearTexto(r);
    for (const etiqueta of etiquetas) {
      const e = etiqueta.trim();
      if (e.length < 3) continue;
      const escapada = e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      texto = texto.replace(new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapada}(?=$|[^\\p{L}\\p{N}_-])`, 'giu'), '$1');
    }
    texto = texto.replace(/\[saúde\]/g, 'informado').replace(/\s{2,}/g, ' ').trim();
  }
  if (!texto) return null;
  if (texto.length > TETO_DA_RESPOSTA) texto = `${texto.slice(0, TETO_DA_RESPOSTA - 1).trimEnd()}…`;
  return `${rotulo}: ${texto}`;
}

export interface LinhaDoModelo {
  pergunta: string;
  resposta: string;
}

/**
 * Lê o que o modelo devolveu: só perguntas DA LISTA (casadas sem acento nem
 * caixa), uma vez cada, na ordem da lista. O que não está na lista é ignorado.
 * Puro.
 */
export function lerLinhasDoModelo(texto: string, perguntas: readonly string[]): LinhaDoModelo[] {
  const json = extrairJsonDoTexto(texto) as { linhas?: unknown } | null;
  const bruto = Array.isArray(json?.linhas) ? json.linhas : [];
  const porChave = new Map<string, string>();
  for (const item of bruto) {
    if (!item || typeof item !== 'object') continue;
    const p = (item as { pergunta?: unknown }).pergunta;
    const r = (item as { resposta?: unknown }).resposta;
    if (typeof p !== 'string' || typeof r !== 'string' || !r.trim()) continue;
    const chave = comparavel(p);
    if (!porChave.has(chave)) porChave.set(chave, r);
  }
  const saida: LinhaDoModelo[] = [];
  for (const pergunta of perguntas) {
    const r = porChave.get(comparavel(pergunta));
    if (r !== undefined) saida.push({ pergunta, resposta: r });
  }
  return saida;
}

/**
 * "10/11 14:32" no fuso da organização. Puro. Só as partes numéricas: o bloco é
 * texto GRAVADO no card, com os marcadores em português, e não interface.
 */
export function quandoDoResumo(agora: Date, fuso: string): string {
  const partes = new Intl.DateTimeFormat(tagDeIdioma(IDIOMA_PADRAO), {
    timeZone: fuso,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(agora);
  const p = (t: string) => partes.find((x) => x.type === t)?.value ?? '';
  return `${p('day')}/${p('month')} ${p('hour')}:${p('minute')}`;
}

/** O bloco, até 600 caracteres: corta linhas do fim antes de cortar o rodapé. Puro. */
export function montarBloco(linhas: readonly string[], quando: string): string {
  const cabecalho = `${INICIO_DO_BLOCO}${quando} ===`;
  const usadas = [...linhas];
  const juntar = () => [cabecalho, ...usadas, FIM_DO_BLOCO].join('\n');
  while (usadas.length > 0 && juntar().length > TETO_DO_BLOCO) usadas.pop();
  return juntar();
}

/**
 * A descrição com o bloco novo: troca o bloco que já existe (inteiro) ou põe o
 * novo no começo. O texto da equipe, fora do bloco, sai idêntico. Puro.
 */
export function aplicarBlocoNaDescricao(descricao: string | null | undefined, bloco: string): string {
  const atual = descricao ?? '';
  if (BLOCO_GRAVADO.test(atual)) {
    const resto = atual.replace(BLOCO_GRAVADO, '');
    return resto ? `${bloco}\n\n${resto}` : bloco;
  }
  return atual ? `${bloco}\n\n${atual}` : bloco;
}

/** O que a chamada barata recebe. Sem dado de documento: ele nem chega ao modelo. */
export function pedidoAoModelo(
  perguntas: readonly string[],
  respostas: ReadonlyArray<{ tema: string; resposta: string }>,
): { sistema: string; mensagem: string } {
  const sistema =
    'Você resume um atendimento para a equipe. Para cada pergunta da lista, escreva SÓ a resposta que o cliente deu, ' +
    `em até ${TETO_DA_RESPOSTA} caracteres, sem inventar, sem comentário, sem impressão sobre o cliente, sem recomendação. ` +
    'Pergunta que o cliente não respondeu fica de fora. Saúde só como "sim" ou "não" (nunca doença, CID ou remédio). ' +
    'Nunca escreva CPF, RG, endereço, CEP, telefone ou data de nascimento. ' +
    'Responda SÓ com JSON: {"linhas": [{"pergunta": "<exatamente como na lista>", "resposta": "<curta>"}]}';
  const mensagem =
    `Perguntas:\n${perguntas.map((p) => `- ${p}`).join('\n')}\n\n` +
    `O que o cliente respondeu (tema: resposta):\n${respostas.map((r) => `- ${r.tema}: ${r.resposta}`).join('\n')}`;
  return { sistema, mensagem };
}

// ─── Com banco ──────────────────────────────────────────────────────────────

export type ResultadoDoResumo =
  | { status: 'atualizado'; leadId: string; linhas: number }
  | { status: 'sem_perguntas' | 'sem_negocio' | 'sem_respostas' | 'nada_util' | 'descricao_mudou' };

/**
 * Atualiza o bloco do resumo no negócio ativo do contato. UMA chamada ao
 * modelo (`chamarModelo`), e só quando há perguntas na lista e respostas para
 * resumir. A escrita só vence se a descrição não mudou no meio do caminho (a
 * equipe pode estar editando). Nunca lança: o turno segue.
 */
export async function atualizarResumoDoCard(
  db: Queryable,
  e: {
    organizationId: string;
    contactId: string;
    perguntas: readonly string[];
    fuso: string;
    agora?: Date;
    chamarModelo: (sistema: string, mensagem: string) => Promise<string>;
  },
): Promise<ResultadoDoResumo> {
  const perguntas = normalizarPerguntasDoResumo(e.perguntas);
  if (perguntas.length === 0) return { status: 'sem_perguntas' };

  const { rows } = await db.query<{
    id: string;
    description: string | null;
    custom_fields: Record<string, unknown> | null;
    status_dos_campos: unknown;
    tags: string[] | null;
    settings: Record<string, unknown> | null;
  }>(
    `select l.id, l.description, l.custom_fields, l.status_dos_campos, l.tags, p.settings
       from crm_leads l
       left join crm_pipelines p on p.id = l.pipeline_id and p.organization_id = l.organization_id
      where l.organization_id = $1 and l.contact_id = $2 and l.status = 'open'
      order by coalesce(l.last_activity_at, l.created_at) desc
      limit 1`,
    [e.organizationId, e.contactId],
  );
  const lead = rows[0];
  if (!lead) return { status: 'sem_negocio' };

  // O que o cliente respondeu: o registro da conversa e os campos CONFIRMADOS.
  const itens = await lerRegistro(db, e.organizationId, e.contactId);
  const respostas: Array<{ tema: string; resposta: string }> = itens
    .filter((i) => i.tipo === 'pergunta' && typeof i.resposta === 'string' && i.resposta.trim() !== '')
    .map((i) => ({ tema: i.tema, resposta: i.resposta as string }));
  const statuses = statusDosCampos(lead.status_dos_campos);
  for (const campo of camposDoFunil(lead.settings)) {
    if (escopoDoCampo(campo) !== 'negocio' || statuses[campo.key] !== 'CONFIRMADO') continue;
    if (DOCUMENTO.test(comparavel(`${campo.key} ${campo.label}`))) continue;
    const v = lead.custom_fields?.[campo.key];
    if (v === null || v === undefined || v === '') continue;
    respostas.push({ tema: campo.label, resposta: typeof v === 'string' ? v : JSON.stringify(v) });
  }
  // Nada de documento chega ao modelo, nem pela resposta.
  const paraOModelo = respostas
    .filter((r) => !DOCUMENTO.test(comparavel(r.tema)) && !NUMERO_DE_DOCUMENTO.test(r.resposta))
    .map((r) => ({ tema: sanearTexto(r.tema).slice(0, 80), resposta: sanearTexto(r.resposta).slice(0, 200) }))
    .filter((r) => r.tema && r.resposta);
  if (paraOModelo.length === 0) return { status: 'sem_respostas' };

  const { sistema, mensagem } = pedidoAoModelo(perguntas, paraOModelo);
  const texto = await e.chamarModelo(sistema, mensagem);
  const linhas = lerLinhasDoModelo(texto, perguntas)
    .map((l) => sanearLinhaDoResumo(l.pergunta, l.resposta, lead.tags ?? []))
    .filter((l): l is string => l !== null);
  if (linhas.length === 0) return { status: 'nada_util' };

  const bloco = montarBloco(linhas, quandoDoResumo(e.agora ?? new Date(), e.fuso));
  const nova = aplicarBlocoNaDescricao(lead.description, bloco);
  const upd = await db.query<{ id: string }>(
    `update crm_leads set description = $3
      where organization_id = $1 and id = $2 and description is not distinct from $4
      returning id`,
    [e.organizationId, lead.id, nova, lead.description],
  );
  if (upd.rows.length === 0) return { status: 'descricao_mudou' };
  return { status: 'atualizado', leadId: lead.id, linhas: linhas.length };
}

/** A etapa do negócio ativo do contato agora (para saber, no fim do turno, se a IA a mudou). */
export async function etapaDoNegocioAtivo(
  db: Queryable,
  organizationId: string,
  contactId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ stage_id: string | null }>(
    `select stage_id from crm_leads
      where organization_id = $1 and contact_id = $2 and status = 'open'
      order by coalesce(last_activity_at, created_at) desc
      limit 1`,
    [organizationId, contactId],
  );
  return rows[0]?.stage_id ?? null;
}

/**
 * Houve, neste turno, um MOMENTO de atualizar o resumo além das passagens (que
 * o turno já sabe)? Caso aberto nesta conversa desde o começo do turno, ou a
 * etapa do negócio ativo mudou.
 */
export async function houveCasoOuEtapaNova(
  db: Queryable,
  e: { organizationId: string; contactId: string; conversationId: string; desde: Date; etapaNoInicio: string | null },
): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `select exists (
       select 1 from agent_cases
        where organization_id = $1 and conversation_id = $2 and opened_at >= $3
     ) as ok`,
    [e.organizationId, e.conversationId, e.desde.toISOString()],
  );
  if (rows[0]?.ok === true) return true;
  const agora = await etapaDoNegocioAtivo(db, e.organizationId, e.contactId);
  return agora !== null && e.etapaNoInicio !== null && agora !== e.etapaNoInicio;
}
