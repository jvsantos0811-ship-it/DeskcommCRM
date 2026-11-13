/**
 * PC-035 — SEM PASSADA FINAL.
 *
 * A resposta do agente é um laço: o modelo pede ferramentas, o motor executa e
 * chama o modelo de novo com os resultados. Depois da ÚLTIMA ferramenta o laço
 * chamava o modelo mais uma vez só para ele dizer que terminou — uma chamada
 * que relê o contexto inteiro (~20 mil tokens) e segura o "digitando" por mais
 * 8 a 15 segundos, sem mudar nada do que o cliente recebe.
 *
 * A regra: se a passada que acabou JÁ ENVIOU a mensagem (envio aceito) e nela
 * não foi pedida nenhuma ferramenta cujo resultado o modelo precise ler, o laço
 * termina ali. As ferramentas de registro pedidas JUNTO (nota, etiqueta, etapa,
 * campo, caso, passagem) já executaram — as ferramentas de uma mesma passada
 * rodam todas antes desta pergunta.
 *
 * O laço CONTINUA, como sempre, quando:
 *  - a mensagem foi vetada pela cadeia de travas (o modelo reescreve);
 *  - qualquer ferramenta da passada devolveu erro (o modelo corrige: a trava de
 *    etapa do PC-003 ensina "faltam os campos…" e ele tem de ver isso);
 *  - a passada pediu uma consulta (base de conhecimento, contexto, nota,
 *    agenda, listas do CRM): quem consulta quer ler a resposta;
 *  - a passada não enviou mensagem nenhuma.
 *
 * Função pura, sem banco e sem modelo. Só vale com a chave da organização.
 */
import { READ_ONLY_TOOLS } from './tool-breaker';

/** O que esta regra lê de uma passada do laço (um `StepResult` do AI SDK serve). */
export interface PassadaDoLaco {
  toolCalls: ReadonlyArray<{ toolName: string }>;
  toolResults: ReadonlyArray<{ toolName: string; output: unknown }>;
}

/** As ferramentas que entregam mensagem ao cliente. */
const FERRAMENTAS_DE_ENVIO: ReadonlySet<string> = new Set(['send_message', 'send_template']);

/**
 * Ferramentas do catálogo do CRM que só LEEM, pelo prefixo do nome. A cerca
 * `sem-passada-final.test.ts` confere esta lista contra a categoria `read` de
 * TODAS as ferramentas do catálogo — ferramenta de leitura com nome novo
 * reprova lá, em vez de encerrar o laço sem o modelo ler o que consultou.
 */
const PREFIXOS_DE_CONSULTA = [
  'crm_list_',
  'crm_get_',
  'crm_search_',
  'crm_find_',
  'crm_describe_',
  'crm_query_',
  'crm_render_',
  'crm_preparar_',
] as const;

/**
 * Agenda: marcar e remarcar ESCREVEM, mas o modelo precisa do resultado (o
 * horário confirmado, ou a recusa de um horário tomado) para falar com o cliente.
 */
const FERRAMENTAS_DE_AGENDA_QUE_PEDEM_LEITURA: ReadonlySet<string> = new Set([
  'crm_book_appointment',
  'crm_reschedule_appointment',
  'crm_cancel_appointment',
  'crm_find_and_book_appointment',
]);

const SO_LEITURA_DO_MOTOR: ReadonlySet<string> = new Set<string>(READ_ONLY_TOOLS);

/** A ferramenta devolve algo que o modelo precisa ler antes de terminar? */
export function ferramentaPedeLeitura(nome: string): boolean {
  if (SO_LEITURA_DO_MOTOR.has(nome)) return true;
  if (FERRAMENTAS_DE_AGENDA_QUE_PEDEM_LEITURA.has(nome)) return true;
  return PREFIXOS_DE_CONSULTA.some((p) => nome.startsWith(p));
}

/** O resultado é uma recusa ou um erro? Convenção do repo: `ok === false`. */
function falhou(output: unknown): boolean {
  if (output === null || typeof output !== 'object') return false;
  const o = output as { ok?: unknown; isError?: unknown; error?: unknown };
  return o.ok === false || o.isError === true || (o.ok === undefined && o.error !== undefined && o.error !== null);
}

/** O envio foi ACEITO? Só `ok === true` conta: na dúvida, o laço segue. */
function envioAceito(output: unknown): boolean {
  return output !== null && typeof output === 'object' && (output as { ok?: unknown }).ok === true;
}

/**
 * A passada que acabou encerra o turno? (Ver o cabeçalho.)
 *
 * `undefined` (nenhuma passada ainda) → não.
 */
export function passadaEncerraOTurno(passada: PassadaDoLaco | undefined): boolean {
  if (passada === undefined) return false;
  const { toolCalls, toolResults } = passada;
  if (toolCalls.length === 0) return false;
  // Uma chamada sem resultado é ferramenta que lançou ou foi negada: o modelo vê.
  if (toolResults.length !== toolCalls.length) return false;
  if (toolCalls.some((c) => ferramentaPedeLeitura(c.toolName))) return false;
  const envios = toolResults.filter((r) => FERRAMENTAS_DE_ENVIO.has(r.toolName));
  if (envios.length === 0) return false;
  if (!envios.every((r) => envioAceito(r.output))) return false;
  return !toolResults.some((r) => falhou(r.output));
}
