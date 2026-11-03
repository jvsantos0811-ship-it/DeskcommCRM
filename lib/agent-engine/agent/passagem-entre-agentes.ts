/**
 * PASSAGEM DA CONVERSA ENTRE AGENTES DO ROTEADOR (PC-014, Pacote Conversa).
 *
 * ## O defeito que este arquivo conserta
 *
 * Com três agentes no mesmo número (Recepção → especialista → outro
 * especialista), um agente não conseguia passar a conversa para outro: a troca
 * só acontecia quando o classificador mudava de intenção numa mensagem NOVA do
 * cliente (`resolve-turn-agent.ts`, regra 2). Medido no desenho da Bórbora:
 *
 *  1. a Recepção confirmava nome e benefício, mas quem respondia a essa mensagem
 *     já era a especialista — a Recepção nunca gravava etiqueta nem etapa;
 *  2. se o classificador não trocava, a conversa ficava presa na Recepção até o
 *     cliente escrever de novo;
 *  3. a passagem entre especialistas dependia do classificador acertar no meio
 *     da qualificação.
 *
 * ## O que existe agora
 *
 * A ferramenta nativa `passar_para_agente`, visível só quando a conversa está
 * num número com roteador ATIVO e o agente do turno é membro dele (ou a reserva
 * dele). Efeito, nesta ordem: grava o cartão como nota fixa no negócio; põe a
 * conversa com o agente de destino (`conversations.active_ai_agent_id` /
 * `active_intent`, a mesma gravação da Fase 3); registra a passagem em
 * `passagens_entre_agentes` e em `ai_router_decisions` (desfecho
 * `passagem_agente`); e enfileira um turno do DESTINO que fala primeiro, sem
 * esperar o cliente, 5 a 10 s depois do último envio (a fila serializa por
 * contato, então o turno do destino nunca começa antes de o atual terminar).
 *
 * Depois da passagem o destino vale como "grudado": a mensagem seguinte com
 * intenção "nenhuma" fica com ele (regra 2 do resolvedor, com a aderência
 * forçada pela passagem mesmo num roteador sem `sticky`). O follow-up já sai
 * pela voz dele, porque `loadConversationAgentConfig` lê o agente ativo.
 *
 * ## Travas (nunca silêncio)
 *
 *  - não passa para si mesmo (a própria intenção nem aparece na lista);
 *  - no máximo 2 passagens pela ferramenta por conversa por hora — a 3ª abre
 *    caso para a equipe com o motivo "passagem em laço" e não passa;
 *  - conversa com pessoa da equipe (bot calado) → recusa, sem efeito;
 *  - destino sem versão publicada → erro legível para o modelo, e o agente
 *    atual segue respondendo.
 *
 * ## O cartão de passagem
 *
 * Sempre no mesmo formato, até 600 caracteres: nome confirmado · quem fala ·
 * benefício e situação · campos da qualificação com status (lidos do negócio,
 * nunca do modelo) · urgência real e data · o que falta · próximo passo · jeito
 * do cliente. Sem telefone, sem diagnóstico/CID, sem nome de etiqueta — o
 * saneamento abaixo tira o que der para tirar por regra; a descrição da
 * ferramenta proíbe o resto.
 */
import { z } from 'zod';
import type pg from 'pg';

import { camposDoFunil, escopoDoCampo } from '@/lib/leads/campos-do-funil';
import { statusDosCampos } from '@/lib/leads/status-dos-campos';
import { resolveActiveLeadForContact } from '@/lib/leads/active-lead';

import type { Queryable } from '../queue/queue';
import { enqueueJob } from '../queue/queue';
import { isLeadInHandoff } from './human-handoff';
import type { LoadedRouter } from './router-config';

/** Teto do cartão (a ordem do João: até 600 caracteres). */
export const TETO_DO_CARTAO = 600;
/** Teto do motivo. */
export const TETO_DO_MOTIVO = 200;
/** Passagens pela ferramenta permitidas por conversa numa janela de 1 hora. */
export const PASSAGENS_POR_HORA = 2;
/** Atraso do turno do destino depois do último envio (ritmo, sem bolha dupla). */
export const ATRASO_MIN_MS = 5_000;
export const ATRASO_MAX_MS = 10_000;
/** Teto da espera, para nunca segurar o worker mais que isso. */
export const ESPERA_MAX_MS = 15_000;

/** Os campos que o modelo escreve. Todos curtos; nenhum obrigatório além do nome da intenção. */
export const cartaoDaPassagemSchema = z.strictObject({
  nome_confirmado: z.string().max(80).optional(),
  quem_fala: z.string().max(80).optional(),
  beneficio_e_situacao: z.string().max(160).optional(),
  urgencia: z.string().max(120).optional(),
  o_que_falta: z.string().max(160).optional(),
  proximo_passo: z.string().max(140).optional(),
  jeito_do_lead: z.string().max(120).optional(),
});
export type CartaoEntreAgentes = z.infer<typeof cartaoDaPassagemSchema>;

/** A whitelist real (o schema do SDK é largo; a validação de verdade é esta). */
export function passarParaAgenteInputSchema(intencoes: readonly [string, ...string[]]) {
  return z.strictObject({
    intencao: z.enum(intencoes),
    motivo: z.string().min(1).max(TETO_DO_MOTIVO),
    cartao: cartaoDaPassagemSchema,
  });
}

/** O schema que o modelo vê, com a lista de intenções do roteador menos a do próprio agente. */
export function definicaoDaFerramentaDePassagem(destinos: ReadonlyArray<{ intencao: string; descricao: string; agente: string }>) {
  const lista = destinos
    .map((d) => `- ${d.intencao}: ${d.agente}${d.descricao ? ` — ${d.descricao}` : ''}`)
    .join('\n');
  const intencoes = destinos.map((d) => d.intencao) as [string, ...string[]];
  return {
    description:
      'Passa esta conversa para OUTRO agente deste número, que continua o atendimento sem o cliente ' +
      'precisar escrever de novo. Use quando o assunto do cliente é de outro agente da lista. ' +
      'Antes de chamar, diga ao cliente em uma frase curta que vai seguir com a pessoa certa (sem prometer resultado). ' +
      'Depois de chamar, NÃO faça mais perguntas: quem segue é o outro agente.\n' +
      `Destinos possíveis:\n${lista}\n` +
      'O cartão é o que o outro agente vai ler: escreva só o que o cliente disse, em poucas palavras. ' +
      'NUNCA ponha telefone, diagnóstico, CID, nome de remédio ou nome de etiqueta.',
    inputSchema: z
      .object({
        intencao: z.enum(intencoes).describe('a intenção do agente que vai assumir'),
        motivo: z.string().describe(`por que você está passando, em uma frase (até ${TETO_DO_MOTIVO} caracteres)`),
        cartao: z
          .object({
            nome_confirmado: z.string().optional().describe('o nome que o cliente confirmou'),
            quem_fala: z.string().optional().describe('"o próprio" ou o familiar e o grau ("filha")'),
            beneficio_e_situacao: z
              .string()
              .optional()
              .describe('o benefício ou assunto e em que pé está (ex.: "auxílio-acidente; negado no INSS em 2025")'),
            urgencia: z.string().optional().describe('urgência real e a data, ou "nenhuma"'),
            o_que_falta: z.string().optional().describe('o que ainda falta saber ou receber'),
            proximo_passo: z.string().optional().describe('o próximo passo combinado'),
            jeito_do_lead: z.string().optional().describe('como o cliente prefere conversar (ex.: "manda áudio, frases curtas")'),
          })
          .passthrough(),
      })
      .passthrough(),
  };
}

// ─── Saneamento do cartão ────────────────────────────────────────────────────

/** Telefone brasileiro (com ou sem DDI/DDD/traço) e qualquer sequência longa de dígitos. */
const TELEFONE = /(?:\+?\d{2}[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}\b/g;
/** Código da CID (ex.: M54.5, S82, F32.1) — diagnóstico não entra no cartão. */
const CID = /\b(?:CID[\s:-]*)?[A-TV-Z]\d{2}(?:\.\d{1,2})?\b/g;

function semEspacoSobrando(texto: string): string {
  return texto.replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').trim();
}

/**
 * Tira do texto o que nunca entra no cartão: telefone, código de CID e o nome de
 * qualquer etiqueta do negócio. Puro.
 */
export function sanearTextoDoCartao(texto: string, etiquetas: readonly string[] = []): string {
  let t = texto.replace(TELEFONE, '').replace(CID, '');
  for (const etiqueta of etiquetas) {
    const e = etiqueta.trim();
    if (e.length < 3) continue;
    const escapada = e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapada}(?=$|[^\\p{L}\\p{N}_-])`, 'giu'), '$1');
  }
  return semEspacoSobrando(t);
}

const ROTULOS: ReadonlyArray<[keyof CartaoEntreAgentes | 'qualificacao', string]> = [
  ['nome_confirmado', 'Nome confirmado'],
  ['quem_fala', 'Quem fala'],
  ['beneficio_e_situacao', 'Benefício e situação'],
  ['qualificacao', 'Qualificação'],
  ['urgencia', 'Urgência'],
  ['o_que_falta', 'O que falta'],
  ['proximo_passo', 'Próximo passo'],
  ['jeito_do_lead', 'Jeito do cliente'],
];

/**
 * O cartão no formato fixo, até `TETO_DO_CARTAO` caracteres. Campo vazio vira
 * "não informado" (o formato é sempre o mesmo). Quando passa do teto, a linha
 * de qualificação (a mais longa e a única gerada pelo sistema) encolhe primeiro;
 * depois, as demais são cortadas por igual. Puro.
 */
export function formatarCartaoEntreAgentes(
  cartao: CartaoEntreAgentes,
  qualificacao: string,
  etiquetas: readonly string[] = [],
): string {
  const valores = new Map<string, string>();
  for (const [chave] of ROTULOS) {
    const cru = chave === 'qualificacao' ? qualificacao : (cartao[chave] ?? '');
    const limpo = chave === 'qualificacao' ? semEspacoSobrando(cru) : sanearTextoDoCartao(cru, etiquetas);
    valores.set(chave, limpo === '' ? 'não informado' : limpo);
  }
  const montar = () => ROTULOS.map(([k, rotulo]) => `${rotulo}: ${valores.get(k)}`).join('\n');
  let texto = montar();
  if (texto.length <= TETO_DO_CARTAO) return texto;

  const cortar = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…`);
  const excesso = texto.length - TETO_DO_CARTAO;
  const q = valores.get('qualificacao') ?? '';
  valores.set('qualificacao', cortar(q, Math.max(20, q.length - excesso)));
  texto = montar();
  if (texto.length <= TETO_DO_CARTAO) return texto;

  // Ainda grande: corta cada campo do modelo até caber.
  for (let teto = 120; teto >= 20 && texto.length > TETO_DO_CARTAO; teto -= 10) {
    for (const [k] of ROTULOS) valores.set(k, cortar(valores.get(k) ?? '', teto));
    texto = montar();
  }
  return texto.length <= TETO_DO_CARTAO ? texto : cortar(texto, TETO_DO_CARTAO);
}

/**
 * Os campos "com status" do negócio, só rótulo e status (nunca o dado: o dado
 * pode ser diagnóstico ou documento). Ex.: "Categoria: CONFIRMADO; Data do
 * acidente: PENDENTE". Puro.
 */
export function qualificacaoDoNegocio(negocio: {
  settings: Record<string, unknown> | null;
  status_dos_campos: unknown;
} | null): string {
  if (negocio === null) return '';
  const campos = camposDoFunil(negocio.settings).filter((c) => escopoDoCampo(c) === 'negocio' && c.com_status === true);
  if (campos.length === 0) return '';
  const statuses = statusDosCampos(negocio.status_dos_campos);
  return campos.map((c) => `${c.label}: ${statuses[c.key] ?? 'PENDENTE'}`).join('; ');
}

// ─── Elegibilidade ──────────────────────────────────────────────────────────

export interface DestinoDaPassagem {
  intencao: string;
  descricao: string;
  agentId: string;
  /** Nome do agente (para a lista que o modelo vê e para o bloco de chegada). */
  agente: string;
}

/**
 * Os destinos possíveis para o agente do turno, ou `null` quando a ferramenta não
 * deve aparecer: sem roteador ativo, agente fora do roteador (nem membro nem a
 * reserva) ou nenhum outro membro. A própria intenção sai da lista (não passa
 * para si mesmo). Puro.
 */
export function destinosDaPassagem(
  router: LoadedRouter | null,
  agentId: string | null,
  nomes: ReadonlyMap<string, string>,
): DestinoDaPassagem[] | null {
  if (router === null || agentId === null) return null;
  const ehMembro = router.members.some((m) => m.agentId === agentId);
  const ehReserva = router.fallbackAgentId === agentId;
  if (!ehMembro && !ehReserva) return null;
  const destinos = router.members
    .filter((m) => m.agentId !== agentId)
    .map((m) => ({
      intencao: m.intentName,
      descricao: m.intentDescription,
      agentId: m.agentId,
      agente: nomes.get(m.agentId) ?? m.intentName,
    }));
  return destinos.length > 0 ? destinos : null;
}

/** Nomes dos agentes do roteador (um select só). */
export async function nomesDosAgentes(
  db: Queryable,
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await db.query<{ id: string; name: string }>(
    'select id, name from ai_agents where organization_id = $1 and id = any($2::uuid[])',
    [organizationId, ids],
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ─── Leituras e escritas ────────────────────────────────────────────────────

/** Passagens pela ferramenta nesta conversa na última hora. */
export async function passagensNaUltimaHora(
  db: Queryable,
  organizationId: string,
  conversationId: string,
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from passagens_entre_agentes
      where organization_id = $1 and conversation_id = $2
        and origem = 'ferramenta' and desfecho = 'passou'
        and created_at > now() - interval '1 hour'`,
    [organizationId, conversationId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * A conversa está com uma pessoa da equipe? A MESMA régua do começo do turno
 * (`isLeadInHandoff`: handoff, `force_human`, `ai_opt_out`, bot calado) mais o
 * dono humano da conversa — duas réguas para "está com uma pessoa" divergiriam
 * no primeiro ajuste.
 */
export async function conversaComPessoa(
  db: pg.Pool,
  organizationId: string,
  contactId: string,
  conversationId: string,
): Promise<boolean> {
  if (await isLeadInHandoff(db, organizationId, contactId)) return true;
  const { rows } = await db.query<{ com_pessoa: boolean }>(
    `select (assignee_kind = 'user' or assigned_to_user_id is not null) as com_pessoa
       from conversations where organization_id = $1 and id = $2`,
    [organizationId, conversationId],
  );
  return rows[0]?.com_pessoa === true;
}

/** O negócio aberto do contato (para a qualificação e as etiquetas do cartão). */
export async function negocioDoContato(
  db: Queryable,
  organizationId: string,
  contactId: string,
): Promise<{ id: string; settings: Record<string, unknown> | null; status_dos_campos: unknown; tags: string[] } | null> {
  const { rows } = await db.query<{
    id: string;
    organization_id: string;
    pipeline_id: string;
    status: 'open' | 'won' | 'lost';
    created_at: string;
    last_activity_at: string | null;
    settings: Record<string, unknown> | null;
    status_dos_campos: unknown;
    tags: string[] | null;
  }>(
    `select l.id, l.organization_id, l.pipeline_id, l.status, l.created_at::text,
            l.last_activity_at::text, p.settings, l.status_dos_campos, l.tags
       from crm_leads l
       left join crm_pipelines p on p.id = l.pipeline_id
      where l.organization_id = $1 and l.contact_id = $2`,
    [organizationId, contactId],
  );
  const rota = resolveActiveLeadForContact(
    rows.map((r) => ({
      id: r.id,
      organization_id: r.organization_id,
      pipeline_id: r.pipeline_id,
      status: r.status,
      created_at: r.created_at,
      last_activity_at: r.last_activity_at,
    })),
  );
  if (!rota.routed) return null;
  const n = rows.find((r) => r.id === rota.leadId);
  return n ? { id: n.id, settings: n.settings, status_dos_campos: n.status_dos_campos, tags: n.tags ?? [] } : null;
}

export interface RegistroDaPassagemEntreAgentes {
  organizationId: string;
  conversationId: string;
  contactId: string | null;
  routerId: string | null;
  deAgenteId: string | null;
  paraAgenteId: string | null;
  intencao: string | null;
  origem: 'ferramenta' | 'roteador' | 'equipe';
  desfecho?: 'passou' | 'laco';
  motivo?: string | null;
  cartao?: string | null;
  porUserId?: string | null;
  jobId?: string | null;
}

/** Grava uma linha em `passagens_entre_agentes` e devolve o id. */
export async function registrarPassagemEntreAgentes(db: Queryable, r: RegistroDaPassagemEntreAgentes): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into passagens_entre_agentes
       (organization_id, conversation_id, contact_id, router_id, de_agente_id, para_agente_id,
        intencao, origem, desfecho, motivo, cartao, por_user_id, job_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     returning id`,
    [
      r.organizationId,
      r.conversationId,
      r.contactId,
      r.routerId,
      r.deAgenteId,
      r.paraAgenteId,
      r.intencao,
      r.origem,
      r.desfecho ?? 'passou',
      r.motivo === undefined || r.motivo === null ? null : r.motivo.slice(0, TETO_DO_MOTIVO),
      r.cartao === undefined || r.cartao === null ? null : r.cartao.slice(0, TETO_DO_CARTAO),
      r.porUserId ?? null,
      r.jobId ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('passagens_entre_agentes: insert sem retorno');
  return id;
}

/** Marca que o destino respondeu (primeira mensagem dele depois da passagem). Idempotente. */
export async function marcarRespostaDoDestino(
  db: Queryable,
  organizationId: string,
  passagemId: string,
): Promise<void> {
  await db.query(
    `update passagens_entre_agentes set destino_respondeu_em = now()
      where organization_id = $1 and id = $2 and destino_respondeu_em is null`,
    [organizationId, passagemId],
  );
}

/**
 * A passagem que ainda espera a primeira resposta do destino nesta conversa
 * (a mais recente, para o agente que está respondendo agora), se houver.
 */
export async function passagemEsperandoODestino(
  db: Queryable,
  organizationId: string,
  conversationId: string,
  agentId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `select id from passagens_entre_agentes
      where organization_id = $1 and conversation_id = $2 and para_agente_id = $3
        and desfecho = 'passou' and destino_respondeu_em is null
        and created_at > now() - interval '1 day'
      order by created_at desc limit 1`,
    [organizationId, conversationId, agentId],
  );
  return rows[0]?.id ?? null;
}

export interface UltimaPassagem {
  id: string;
  deAgente: string | null;
  paraAgenteId: string | null;
  origem: 'ferramenta' | 'roteador' | 'equipe';
  motivo: string | null;
  cartao: string | null;
  createdAt: Date;
}

/** A passagem mais recente que de fato passou, nesta conversa. */
export async function ultimaPassagem(
  db: Queryable,
  organizationId: string,
  conversationId: string,
): Promise<UltimaPassagem | null> {
  const { rows } = await db.query<{
    id: string;
    de_agente: string | null;
    para_agente_id: string | null;
    origem: 'ferramenta' | 'roteador' | 'equipe';
    motivo: string | null;
    cartao: string | null;
    created_at: Date;
  }>(
    `select p.id, a.name as de_agente, p.para_agente_id, p.origem, p.motivo, p.cartao, p.created_at
       from passagens_entre_agentes p
       left join ai_agents a on a.id = p.de_agente_id
      where p.organization_id = $1 and p.conversation_id = $2 and p.desfecho = 'passou'
      order by p.created_at desc limit 1`,
    [organizationId, conversationId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: r.id,
    deAgente: r.de_agente,
    paraAgenteId: r.para_agente_id,
    origem: r.origem,
    motivo: r.motivo,
    cartao: r.cartao,
    createdAt: r.created_at,
  };
}

/** Hora curta no fuso da organização (ex.: "10h02"). */
function horaCurta(d: Date, fuso: string): string {
  try {
    // Só os dígitos importam (o texto é para o modelo, sempre "10h02"): o
    // relógio de 24 h vem do `hourCycle`, não do idioma.
    const p = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: fuso }).formatToParts(d);
    const h = p.find((x) => x.type === 'hour')?.value ?? '';
    const m = p.find((x) => x.type === 'minute')?.value ?? '';
    return `${h}h${m}`;
  } catch {
    return '';
  }
}

/**
 * O bloco de chegada: o que o agente de destino lê no turno ("<agente> passou:
 * <cartão>"). Só quando a passagem mais recente desta conversa foi para ESTE
 * agente — e enquanto ele segue sendo o agente da conversa. Puro.
 */
export function blocoDeChegada(p: UltimaPassagem | null, agentId: string | null, fuso: string): string {
  if (p === null || agentId === null || p.paraAgenteId !== agentId) return '';
  if (p.origem === 'roteador') return '';
  const quem = p.origem === 'equipe' ? 'A equipe' : (p.deAgente ?? 'Outro agente');
  const hora = horaCurta(p.createdAt, fuso);
  const corpo = (p.cartao ?? '').trim();
  const linhas = [
    `## Chegada desta conversa${hora ? ` (${hora})` : ''}`,
    p.origem === 'equipe'
      ? `${quem} devolveu a conversa para você e escreveu o que fez: ${corpo === '' ? '(sem nota)' : corpo}`
      : `${quem} passou a conversa para você. Cartão da passagem:\n${corpo === '' ? '(sem cartão)' : corpo}`,
    'Não repita o que já foi perguntado e respondido; siga do próximo passo.',
  ];
  return linhas.join('\n');
}

/**
 * Enfileira o turno do destino que fala primeiro. O `source_event_id` é o id da
 * passagem: reentrega não vira segundo turno. A fila serializa por contato
 * (`uniq_job_queue_one_running_per_contact`): o turno do destino só começa
 * depois que o turno atual terminar, e o handler espera 5 a 10 s depois do
 * último envio antes de falar.
 */
export async function enfileirarTurnoDoDestino(
  db: Queryable,
  args: {
    organizationId: string;
    contactId: string;
    conversationId: string;
    channelSessionId: string;
    inboundMessageId: string;
    passagemId: string;
  },
): Promise<string> {
  const { job } = await enqueueJob(db, args.organizationId, {
    kind: 'inbound_turn',
    leadId: args.contactId,
    sourceEventId: args.passagemId,
    runAfter: new Date(Date.now() + ATRASO_MIN_MS),
    payload: {
      conversation_id: args.conversationId,
      contact_id: args.contactId,
      channel_session_id: args.channelSessionId,
      inbound_message_id: args.inboundMessageId,
      crm_event_id: args.passagemId,
      passagem_id: args.passagemId,
    },
  });
  await db.query(
    `update passagens_entre_agentes set turno_destino_job_id = $3 where organization_id = $1 and id = $2`,
    [args.organizationId, args.passagemId, job.id],
  );
  return job.id;
}

/**
 * Quanto o turno do destino ainda espera antes de falar: 5 a 10 s depois do
 * último envio da conversa (ou nada, se já passou). Puro: `sorteio` em [0,1).
 */
export function esperaAntesDeFalar(ultimoEnvio: Date | null, agora: Date, sorteio: number): number {
  if (ultimoEnvio === null) return 0;
  const atraso = ATRASO_MIN_MS + Math.floor(sorteio * (ATRASO_MAX_MS - ATRASO_MIN_MS));
  const alvo = ultimoEnvio.getTime() + atraso;
  return Math.max(0, Math.min(ESPERA_MAX_MS, alvo - agora.getTime()));
}

/** O último envio para o cliente nesta conversa (saída que não falhou). */
export async function ultimoEnvioDaConversa(
  db: Queryable,
  organizationId: string,
  conversationId: string,
): Promise<Date | null> {
  const { rows } = await db.query<{ quando: Date | null }>(
    `select max(greatest(created_at, sent_at)) as quando from messages
      where organization_id = $1 and conversation_id = $2 and direction = 'outbound'
        and status <> 'failed' and created_at > now() - interval '10 minutes'`,
    [organizationId, conversationId],
  );
  return rows[0]?.quando ?? null;
}

export type ResultadoDaPassagemEntreAgentes =
  | { ok: true; status: 'passou'; para: string; message: string }
  | { ok: true; status: 'teste'; para: string; message: string }
  | { ok: false; error: { code: string; message: string } };

/** Payload no formato de passagem, já validado (helper para quem chama). */
export type PassagemValidada = { intencao: string; motivo: string; cartao: CartaoEntreAgentes };

/** Valida o payload cru do modelo; erro vira ensino, nunca exceção. */
export function validarPayloadDaPassagem(
  raw: unknown,
  destinos: readonly DestinoDaPassagem[],
): { ok: true; data: PassagemValidada } | { ok: false; error: { code: string; message: string } } {
  const intencoes = destinos.map((d) => d.intencao);
  if (intencoes.length === 0) {
    return { ok: false, error: { code: 'sem_destino', message: 'não há outro agente neste número para passar a conversa.' } };
  }
  const schema = passarParaAgenteInputSchema(intencoes as [string, ...string[]]);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const campo = parsed.error.issues[0]?.path.join('.') ?? '';
    return {
      ok: false,
      error: {
        code: 'invalid_payload',
        message:
          `payload inválido em passar_para_agente${campo ? ` (campo ${campo})` : ''}. ` +
          `Mande intencao (uma de: ${intencoes.join(', ')}), motivo (até ${TETO_DO_MOTIVO} caracteres) e cartao ` +
          '(nome_confirmado, quem_fala, beneficio_e_situacao, urgencia, o_que_falta, proximo_passo, jeito_do_lead). Nada além disso.',
      },
    };
  }
  return { ok: true, data: parsed.data };
}


// ─── A ferramenta, de ponta a ponta ─────────────────────────────────────────

export interface ContextoDaPassagem {
  organizationId: string;
  contactId: string;
  conversationId: string;
  channelSessionId: string;
  /** Agente do turno (quem passa). */
  agentId: string;
  router: LoadedRouter;
  destinos: readonly DestinoDaPassagem[];
  /** A mensagem que acordou o turno; sem ela, a última do cliente na conversa. */
  inboundMessageId: string | null;
  jobId: string | null;
}

export interface DependenciasDaPassagem {
  /** Carrega a versão publicada do destino (`loadPublishedAgentConfigById`). */
  versaoPublicada: (agentId: string) => Promise<unknown | null>;
  /** Abre o caso da passagem em laço (`openCase`). */
  abrirCaso: (input: { title: string; summary: string; blocker: string }) => Promise<unknown>;
  /** Escreve o cartão na linha do tempo do negócio. */
  anotarNoNegocio: (cartao: string, destino: string) => Promise<void>;
  /** Nome do agente que passa (para a nota e o aviso). */
  nomeDeQuemPassa: string;
}

/**
 * Executa `passar_para_agente` com as travas. Erro de regra vira ensino para o
 * modelo (`ok: false` com mensagem legível); nunca deixa o cliente sem resposta:
 * em toda recusa, o agente atual segue respondendo.
 */
export async function executarPassagemPelaFerramenta(
  pool: pg.Pool,
  ctx: ContextoDaPassagem,
  deps: DependenciasDaPassagem,
  raw: unknown,
): Promise<ResultadoDaPassagemEntreAgentes> {
  const validado = validarPayloadDaPassagem(raw, ctx.destinos);
  if (!validado.ok) return validado;
  const { intencao, motivo, cartao } = validado.data;
  const destino = ctx.destinos.find((d) => d.intencao === intencao);
  if (destino === undefined || destino.agentId === ctx.agentId) {
    return {
      ok: false,
      error: { code: 'mesmo_agente', message: 'você não pode passar a conversa para si mesmo. Siga atendendo.' },
    };
  }

  if (await conversaComPessoa(pool, ctx.organizationId, ctx.contactId, ctx.conversationId)) {
    return {
      ok: false,
      error: {
        code: 'conversa_com_humano',
        message: 'esta conversa está com uma pessoa da equipe agora. Não passe para outro agente e não escreva mais nada.',
      },
    };
  }

  if ((await deps.versaoPublicada(destino.agentId)) === null) {
    return {
      ok: false,
      error: {
        code: 'destino_sem_versao',
        message:
          `${destino.agente} ainda não tem versão publicada, então a conversa continua com você. ` +
          'Siga atendendo o cliente normalmente e não diga que vai passar para outra pessoa.',
      },
    };
  }

  const negocio = await negocioDoContato(pool, ctx.organizationId, ctx.contactId).catch(() => null);
  const textoDoCartao = formatarCartaoEntreAgentes(cartao, qualificacaoDoNegocio(negocio), negocio?.tags ?? []);
  const motivoLimpo = sanearTextoDoCartao(motivo, negocio?.tags ?? []).slice(0, TETO_DO_MOTIVO);

  // 3ª passagem na mesma hora: não passa; abre caso para a equipe.
  if ((await passagensNaUltimaHora(pool, ctx.organizationId, ctx.conversationId)) >= PASSAGENS_POR_HORA) {
    await registrarPassagemEntreAgentes(pool, {
      organizationId: ctx.organizationId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      routerId: ctx.router.id,
      deAgenteId: ctx.agentId,
      paraAgenteId: destino.agentId,
      intencao,
      origem: 'ferramenta',
      desfecho: 'laco',
      motivo: motivoLimpo,
      cartao: textoDoCartao,
      jobId: ctx.jobId,
    });
    await deps.abrirCaso({
      title: 'Passagem em laço',
      summary:
        `A conversa já trocou de agente ${PASSAGENS_POR_HORA} vezes na última hora e ${deps.nomeDeQuemPassa} ` +
        `tentou passar de novo para ${destino.agente}. Motivo: ${motivoLimpo}\n\n${textoDoCartao}`,
      blocker: 'passagem em laço',
    });
    return {
      ok: false,
      error: {
        code: 'passagem_em_laco',
        message:
          `não passei: esta conversa já trocou de agente ${PASSAGENS_POR_HORA} vezes na última hora. ` +
          'Abri um caso para a equipe olhar. Continue atendendo o cliente você mesmo e não chame passar_para_agente de novo agora.',
      },
    };
  }

  // 1) a nota no negócio
  await deps.anotarNoNegocio(textoDoCartao, destino.agente);

  // 2) a conversa com o destino + 3) o registro, na mesma transação
  const client = await pool.connect();
  let passagemId: string;
  try {
    await client.query('begin');
    await client.query(
      `update conversations
          set active_ai_agent_id = $3, active_intent = $4, active_agent_set_at = now()
        where organization_id = $1 and id = $2`,
      [ctx.organizationId, ctx.conversationId, destino.agentId, intencao],
    );
    passagemId = await registrarPassagemEntreAgentes(client, {
      organizationId: ctx.organizationId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      routerId: ctx.router.id,
      deAgenteId: ctx.agentId,
      paraAgenteId: destino.agentId,
      intencao,
      origem: 'ferramenta',
      motivo: motivoLimpo,
      cartao: textoDoCartao,
      jobId: ctx.jobId,
    });
    await client.query(
      `insert into ai_router_decisions
         (organization_id, router_id, conversation_id, intent_name, confidence, agent_id, outcome, job_id,
          de_agente_id, passagem_id)
       values ($1,$2,$3,$4,null,$5,'passagem_agente',$6,$7,$8)`,
      [ctx.organizationId, ctx.router.id, ctx.conversationId, intencao, destino.agentId, ctx.jobId, ctx.agentId, passagemId],
    );
    await client.query(
      `insert into api_audit_log (action, organization_id, resource_type, resource_id, metadata)
       values ('ai.agent_passagem', $1, 'conversation', $2, $3)`,
      [
        ctx.organizationId,
        ctx.conversationId,
        JSON.stringify({ passagem_id: passagemId, de_agente_id: ctx.agentId, para_agente_id: destino.agentId, intencao }),
      ],
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // 4) o turno do destino, que fala primeiro (depois que este turno terminar)
  const inboundId = ctx.inboundMessageId ?? (await ultimaMensagemDoCliente(pool, ctx.organizationId, ctx.conversationId));
  if (inboundId !== null) {
    await enfileirarTurnoDoDestino(pool, {
      organizationId: ctx.organizationId,
      contactId: ctx.contactId,
      conversationId: ctx.conversationId,
      channelSessionId: ctx.channelSessionId,
      inboundMessageId: inboundId,
      passagemId,
    });
  }

  return {
    ok: true,
    status: 'passou',
    para: destino.agente,
    message:
      `Pronto: a conversa agora é de ${destino.agente}, que vai falar com o cliente em instantes. ` +
      'Não faça mais perguntas neste turno. Se ainda não avisou o cliente, mande UMA frase curta dizendo que segue com a pessoa certa.',
  };
}

/** A última mensagem do cliente na conversa (para amarrar o turno do destino). */
export async function ultimaMensagemDoCliente(
  db: Queryable,
  organizationId: string,
  conversationId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `select id from messages where organization_id = $1 and conversation_id = $2 and direction = 'inbound'
      order by sent_at desc, created_at desc, id desc limit 1`,
    [organizationId, conversationId],
  );
  return rows[0]?.id ?? null;
}

/** No Testar: a ferramenta aparece e diz para quem passaria, sem efeito. */
export function passagemNoTeste(raw: unknown, destinos: readonly DestinoDaPassagem[]): ResultadoDaPassagemEntreAgentes {
  const validado = validarPayloadDaPassagem(raw, destinos);
  if (!validado.ok) return validado;
  const destino = destinos.find((d) => d.intencao === validado.data.intencao);
  const para = destino?.agente ?? validado.data.intencao;
  return {
    ok: true,
    status: 'teste',
    para,
    message: `No Testar nada muda: aqui a conversa passaria para ${para}. Encerre o turno.`,
  };
}

/**
 * O roteador do agente no Testar: o rascunho não tem número de verdade, então
 * vale o roteador ativo de que ele faz parte (membro ou reserva), se houver.
 */
export async function sessaoDoRoteadorDoAgente(
  db: Queryable,
  organizationId: string,
  agentId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ channel_session_id: string }>(
    `select r.channel_session_id from ai_routers r
      where r.organization_id = $1 and r.is_active
        and (r.fallback_agent_id = $2
             or exists (select 1 from ai_router_members m where m.router_id = r.id and m.organization_id = $1 and m.agent_id = $2))
      order by r.updated_at desc nulls last limit 1`,
    [organizationId, agentId],
  );
  return rows[0]?.channel_session_id ?? null;
}

// ─── O turno do destino ─────────────────────────────────────────────────────

/** A passagem que o turno do destino veio cumprir. */
export interface PassagemDoTurno {
  id: string;
  paraAgenteId: string | null;
  intencao: string | null;
  deAgente: string | null;
  destinoRespondeuEm: Date | null;
  ativoDaConversa: string | null;
  /** Chegou mensagem do cliente depois da passagem? */
  clienteEscreveuDepois: boolean;
}

export async function lerPassagemDoTurno(
  db: Queryable,
  organizationId: string,
  passagemId: string,
): Promise<PassagemDoTurno | null> {
  const { rows } = await db.query<{
    id: string;
    para_agente_id: string | null;
    intencao: string | null;
    de_agente: string | null;
    destino_respondeu_em: Date | null;
    ativo: string | null;
    cliente_escreveu_depois: boolean;
  }>(
    `select p.id, p.para_agente_id, p.intencao, a.name as de_agente, p.destino_respondeu_em,
            c.active_ai_agent_id as ativo,
            exists (
              select 1 from messages m
               where m.organization_id = p.organization_id and m.conversation_id = p.conversation_id
                 and m.direction = 'inbound' and m.created_at > p.created_at
            ) as cliente_escreveu_depois
       from passagens_entre_agentes p
       join conversations c on c.id = p.conversation_id and c.organization_id = p.organization_id
       left join ai_agents a on a.id = p.de_agente_id
      where p.organization_id = $1 and p.id = $2 and p.desfecho = 'passou'`,
    [organizationId, passagemId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: r.id,
    paraAgenteId: r.para_agente_id,
    intencao: r.intencao,
    deAgente: r.de_agente,
    destinoRespondeuEm: r.destino_respondeu_em,
    ativoDaConversa: r.ativo,
    clienteEscreveuDepois: r.cliente_escreveu_depois === true,
  };
}

/**
 * O turno do destino ainda tem o que fazer? Não, quando: a passagem não existe;
 * a conversa já saiu deste agente (o cliente escreveu e outra regra decidiu, ou
 * uma pessoa assumiu); ou o destino já respondeu (o cliente escreveu antes e o
 * turno dele já atendeu). Puro.
 */
export function turnoDaPassagemTemOQueFazer(p: PassagemDoTurno | null): boolean {
  if (p === null || p.paraAgenteId === null) return false;
  if (p.ativoDaConversa !== p.paraAgenteId) return false;
  return p.destinoRespondeuEm === null;
}

/**
 * A abertura do turno em que o destino fala primeiro. O cartão chega pelo bloco
 * de chegada (no sufixo, como em todo turno deste agente); aqui vai a instrução
 * de quem abre a conversa sem mensagem nova do cliente. Puro.
 */
export function aberturaDoTurnoDaPassagem(deAgente: string | null, ritual: readonly string[]): string {
  const quem = deAgente ?? 'outro agente';
  return [
    `Você acaba de assumir esta conversa: ${quem} passou o atendimento para você agora.`,
    'O cliente NÃO escreveu nada novo — é você quem fala primeiro.',
    '',
    ...ritual,
    '',
    '## Como abrir',
    'Mande UMA mensagem curta: apresente-se como quem continua o atendimento e siga para o próximo passo do cartão da passagem.',
    'Não repita pergunta que já foi feita e respondida; uma pergunta por vez.',
    'Responda ao lead usando a tool send_message — NUNCA escreva a resposta como texto direto',
    '(texto fora de tool é descartado pelo runtime). Use get_lead_context se precisar reler o contexto.',
  ].join('\n');
}
