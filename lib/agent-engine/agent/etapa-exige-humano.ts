/**
 * ═══ ETAPA "SÓ ATENDIMENTO HUMANO", LIDA PELO MOTOR DE AGENTES ═══
 *
 * `crm_stages.requires_human` existe desde a Spec 04, e até aqui só o worker
 * legado a lia (`checkG4Stage` em lib/ai/handoff/triggers.ts) — um worker que não
 * responde ninguém desde a v1.17.0. Resultado medido em 26/10/2026: num funil
 * com "Análise humana" e "Aguardando assinatura", o agente publicado seguia
 * respondendo o cliente com o negócio parado nessas etapas.
 *
 * A regra, nas palavras de quem configura: **enquanto o negócio está numa etapa
 * marcada "só atendimento humano", a IA não fala com o cliente.** Lida no começo
 * de todo turno que escreve para ele — resposta (`inbound_turn`), follow-up
 * escrito pela IA e follow-up de texto fixo — e não só na mudança de etapa, de
 * propósito: o negócio pode chegar à etapa por arrasto, automação, agente ou
 * importação, e a leitura no turno cobre todos sem um gatilho por caminho.
 *
 * ─── Qual negócio ───────────────────────────────────────────────────────────
 *
 * O "lead" do motor é o CONTATO, e um contato pode ter mais de um negócio. Vale
 * QUALQUER negócio ABERTO do contato numa etapa marcada (e não arquivada). Errar
 * para o lado do humano é o erro barato: o pior caso é uma pessoa receber um
 * aviso a mais na Central; o oposto é a IA falar com um cliente que o escritório
 * reservou para o advogado. Negócio ganho ou perdido não conta — "Aguardando
 * assinatura" que virou "Contratado" devolve a conversa à IA sozinho.
 *
 * ─── O que acontece ─────────────────────────────────────────────────────────
 *
 * `performHumanHandoff` — o mesmo dos outros caminhos: `force_human`, conversa
 * silenciada e na fila humana, follow-ups agendados cancelados, linha em
 * `passagens_de_atendimento` (origem `etapa_do_funil`, motivo `critical_stage`)
 * e aviso na Central. NÃO manda mensagem ao cliente: a etapa é escolha do
 * escritório para um momento em que uma pessoa já conduz (análise do caso,
 * assinatura), e um "vou te passar para a equipe" ali seria anúncio de algo que
 * já aconteceu.
 *
 * Devolver para a IA com o negócio ainda na etapa faz a próxima mensagem passar
 * de novo: é a regra pedida. O aviso da Central diz isso com todas as letras —
 * para a IA voltar, o negócio sai da etapa.
 */
import type pg from 'pg';

import {
  montarBriefingDaPassagem,
  type CheckpointParaBriefing,
} from '@/lib/escalacao/briefing-da-passagem';
import { traduzir } from '@/lib/i18n/dicionario';
import type { Idioma } from '@/lib/i18n/idiomas';

import type { Logger } from '../obs/logger';
import { idiomaDaOrganizacao, performHumanHandoff } from './human-handoff';

export interface EtapaQueExigeHumano {
  negocioId: string;
  etapaId: string;
  etapaNome: string;
}

/**
 * O negócio aberto do contato que está numa etapa "só atendimento humano", ou
 * `null`. Com mais de um, o de atividade mais recente — só para o aviso nomear
 * uma etapa; a decisão (passar para humano) é a mesma com qualquer um.
 */
export async function etapaQueExigeHumano(
  db: pg.Pool,
  tenantId: string,
  contactId: string,
): Promise<EtapaQueExigeHumano | null> {
  const { rows } = await db.query<{ negocio_id: string; etapa_id: string; etapa_nome: string }>(
    `select l.id as negocio_id, s.id as etapa_id, s.name as etapa_nome
       from crm_leads l
       join crm_stages s
         on s.id = l.stage_id
        and s.organization_id = l.organization_id
      where l.organization_id = $1
        and l.contact_id = $2
        and l.status = 'open'
        and s.requires_human
        and not s.is_archived
      order by l.last_activity_at desc nulls last, l.created_at desc
      limit 1`,
    [tenantId, contactId],
  );
  const r = rows[0];
  return r === undefined ? null : { negocioId: r.negocio_id, etapaId: r.etapa_id, etapaNome: r.etapa_nome };
}

/**
 * O título do aviso na Central, no idioma da ORGANIZAÇÃO (o título é gravado e
 * nunca passa por `t()` na tela). O nome da etapa é do escritório, não dado do
 * cliente.
 */
export function tituloDoAvisoDaEtapa(etapaNome: string, idioma: Idioma): string {
  return traduzir(
    "Negócio na etapa «{etapa}», só atendimento humano. Para a IA voltar a atender, mova o negócio para outra etapa.",
    idioma,
  ).replace("{etapa}", etapaNome.slice(0, 80));
}

/**
 * Passa a conversa para uma pessoa porque o negócio está numa etapa marcada.
 * `checkpoint` vem do chamador (o turno já o lê): importar o leitor daqui
 * criaria um ciclo com inbound-turn.ts.
 */
export async function passarParaHumanoPelaEtapa(
  db: pg.Pool,
  ids: { tenantId: string; leadId: string; conversationId: string },
  etapa: EtapaQueExigeHumano,
  opts: { checkpoint: CheckpointParaBriefing | null; log: Logger },
): Promise<void> {
  const briefing = montarBriefingDaPassagem({
    checkpoint: opts.checkpoint,
    motivo: { codigo: 'critical_stage' },
  });
  const idioma = await idiomaDaOrganizacao(db, ids.tenantId, opts.log);
  await performHumanHandoff(db, ids, {
    reason: 'critical_stage',
    conversationSummary: briefing.body,
    inboxTitle: tituloDoAvisoDaEtapa(etapa.etapaNome, idioma),
    passagem: { origem: 'etapa_do_funil', motivoCodigo: 'critical_stage', briefing, idioma },
    log: opts.log,
  });
  // Só ids e o motivo: nome da etapa e do cliente ficam fora do log (regra 8).
  opts.log.info('handoff humano — negócio numa etapa "só atendimento humano"', {
    negocio_id: etapa.negocioId,
    etapa_id: etapa.etapaId,
  });
}
