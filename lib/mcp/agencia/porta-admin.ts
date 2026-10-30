/**
 * A FRONTEIRA DA PORTA ADMIN (PM das duas portas, aprovada em 30/10/2026).
 *
 * A porta Admin altera a CONFIGURAÇÃO de qualquer organização da agência e:
 *
 *   - não lê conversa, mensagem, prévia de mensagem, nota de caso nem dado de
 *     contato (nome, telefone, CPF, saúde, documento, mídia);
 *   - nunca fala com o cliente final: enviar mensagem, iniciar conversa e criar
 *     rascunho de mensagem ficam de fora (decisão do João, 30/10/2026);
 *   - mexe em negócio só pelo id (mover, atualizar, retomar, etiquetar), e a
 *     resposta volta só com metadados.
 *
 * Como é garantido, em camadas:
 *
 *   1. LISTA FECHADA. Só entra ferramenta nomeada aqui. Ferramenta nova do CRM
 *      não aparece na porta Admin até alguém decidir por escrito que ela é
 *      segura — o teste `porta-admin.test.ts` reprova se a lista citar nome que
 *      não existe e mostra a fronteira inteira.
 *   2. SAÍDA POR LISTA DE CHAVES (`projetar`). Ferramenta que devolve negócio ou
 *      conversa passa por uma máscara que só deixa sair chaves nomeadas
 *      (ids, etapa, status, datas, valores, etiquetas). Campo novo que o handler
 *      passar a devolver sai da porta Admin — nunca entra por omissão.
 *   3. ANTES E DEPOIS (`foto`). Toda escrita grava na auditoria a foto do alvo
 *      antes e depois, também só com metadados.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Uma regra de máscara: `true` deixa passar o valor; um objeto desce nele. */
export type Mascara = { [chave: string]: true | Mascara };

/**
 * Aplica a máscara. Chave fora dela some. Lista é mapeada item a item. Valor
 * que a máscara manda descer mas não é objeto (ou lista de objetos) some — um
 * texto onde se esperava `{ id, name }` não passa por engano.
 */
export function aplicarMascara(valor: unknown, mascara: Mascara): unknown {
  if (Array.isArray(valor)) return valor.map((v) => aplicarMascara(v, mascara));
  if (valor === null || typeof valor !== "object") return undefined;
  const saida: Record<string, unknown> = {};
  for (const [chave, regra] of Object.entries(mascara)) {
    if (!(chave in (valor as Record<string, unknown>))) continue;
    const v = (valor as Record<string, unknown>)[chave];
    if (regra === true) {
      saida[chave] = v;
    } else if (v !== null && typeof v === "object") {
      saida[chave] = aplicarMascara(v, regra);
    } else if (v === null) {
      saida[chave] = null;
    }
  }
  return saida;
}

const ETAPA_LEGIVEL: Mascara = { id: true, name: true };

/** O que a porta Admin pode ver de um negócio. Sem título, descrição, contato nem campos personalizados. */
export const MASCARA_DO_NEGOCIO: Mascara = {
  id: true,
  pipeline_id: true,
  stage_id: true,
  stage: ETAPA_LEGIVEL,
  contact_id: true,
  status: true,
  owner_user_id: true,
  owner_agent_id: true,
  owner_user_name: true,
  position_in_stage: true,
  value_cents: true,
  currency: true,
  expected_close_date: true,
  source: true,
  lost_reason: true,
  lost_reason_category: true,
  tags: true,
  retomado_de_lead_id: true,
  created_at: true,
  updated_at: true,
  stage_changed_at: true,
  closed_at: true,
};

/** O que a porta Admin pode ver de uma conversa. Sem prévia de mensagem e sem contato. */
export const MASCARA_DA_CONVERSA: Mascara = {
  id: true,
  contact_id: true,
  channel: true,
  status: true,
  assigned_to_user_id: true,
  assigned_to_user_name: true,
  assignee_kind: true,
  tags: true,
  queue_position: true,
  last_message_at: true,
  unread_count: true,
  is_group: true,
};

const MASCARA_DO_CAMPO_RECUSADO: Mascara = { campo: true, motivo: true, mensagem: true };

const PAGINA = { cursor: true, has_more: true } as const;

/** A foto de um alvo, para o antes e depois da auditoria. Nunca lança: falha vira `null`. */
type Foto = (db: SupabaseClient, organizationId: string, args: Record<string, unknown>) => Promise<unknown>;

export interface FerramentaDaPortaAdmin {
  /** Máscara da resposta. Ausente = a resposta da ferramenta já é só configuração. */
  projetar?: Mascara;
  /** Foto do alvo antes e depois (só nas escritas). */
  foto?: Foto;
}

async function tentar<T>(f: () => PromiseLike<{ data: T | null; error: unknown }>): Promise<T | null> {
  try {
    const { data, error } = await f();
    return error ? null : data;
  } catch {
    return null;
  }
}

const COLUNAS_DA_ETAPA =
  "id, name, position, is_won, is_lost, is_archived, win_probability, expected_duration_hours, requires_human";
const COLUNAS_DO_NEGOCIO_NA_FOTO =
  "id, pipeline_id, stage_id, status, owner_user_id, owner_agent_id, value_cents, currency, expected_close_date, tags, lost_reason, closed_at, updated_at";

const fotoDasEtapas: Foto = (db, org, args) =>
  tentar(() =>
    db
      .from("crm_stages")
      .select(COLUNAS_DA_ETAPA)
      .eq("organization_id", org)
      .eq("pipeline_id", String(args.pipeline_id))
      .order("position", { ascending: true }),
  );

const fotoDoNegocio: Foto = (db, org, args) =>
  tentar(() =>
    db.from("crm_leads").select(COLUNAS_DO_NEGOCIO_NA_FOTO).eq("organization_id", org).eq("id", String(args.lead_id)).maybeSingle(),
  );

const fotoDasEntradas: Foto = (db, org) =>
  tentar(() =>
    db.from("webhook_sources").select("id, name, is_active").eq("organization_id", org).order("created_at", { ascending: true }),
  );

const fotoDaRegra: Foto = (db, org, args) =>
  tentar(() =>
    db.from("automation_rules").select("id, name, is_active").eq("organization_id", org).eq("id", String(args.rule_id)).maybeSingle(),
  );

const fotoDasEtiquetas: Foto = (db, org, args) => {
  const tabela =
    args.target_kind === "lead" ? "crm_leads" : args.target_kind === "contact" ? "contacts" : "conversations";
  return tentar(() =>
    db.from(tabela).select("id, tags").eq("organization_id", org).eq("id", String(args.target_id)).maybeSingle(),
  );
};

const fotoDaMemoria: Foto = (db, org) =>
  tentar(() =>
    db
      .from("org_memory_entries")
      .select("id, title, status, updated_at")
      .eq("organization_id", org)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(50),
  );

/**
 * LEITURA na porta Admin: só configuração e contagens. De fora, de propósito:
 * conversas/mensagens/histórico, contato, caso humano, follow-up agendado
 * (leva o texto), execuções de regra e eventos de webhook (levam dados do
 * lead), propostas de melhoria (a evidência cita conversa), modelo renderizado
 * (com dados do contato), honorários e banco externo.
 */
export const LEITURAS_DA_PORTA_ADMIN: Record<string, FerramentaDaPortaAdmin> = {
  crm_list_pipelines: {},
  crm_get_pipeline_forecast: {},
  crm_list_stages: {},
  crm_list_tags: {},
  crm_list_message_templates: {},
  crm_list_webhook_sources: {},
  crm_list_automation_rules: {},
  crm_list_team_members: {},
  crm_list_event_types: {},
  crm_list_knowledge_sources: {},
  crm_search_knowledge: {},
  crm_get_org_memory: {},
  crm_get_queue_status: {},
  // Para achar o id do que mexer — com máscara: ids, etapa, status, datas, valores.
  crm_list_leads: { projetar: { leads: MASCARA_DO_NEGOCIO, ...PAGINA } },
  crm_list_conversations: { projetar: { conversations: MASCARA_DA_CONVERSA, ...PAGINA } },
};

/**
 * ESCRITA na porta Admin: configuração da organização e negócio por id.
 * Nenhuma envia mensagem, cria rascunho, agenda contato, marca compromisso,
 * passa para humano ou devolve ao automático.
 */
export const ESCRITAS_DA_PORTA_ADMIN: Record<string, FerramentaDaPortaAdmin> = {
  crm_create_stage: { foto: fotoDasEtapas },
  crm_update_stage: { foto: fotoDasEtapas },
  crm_archive_stage: { foto: fotoDasEtapas },
  crm_create_webhook_source: { foto: fotoDasEntradas },
  crm_set_webhook_source_active: { foto: fotoDasEntradas },
  crm_set_automation_rule_active: { foto: fotoDaRegra },
  crm_save_org_memory: { foto: fotoDaMemoria },
  crm_move_lead_stage: {
    foto: fotoDoNegocio,
    projetar: { lead: MASCARA_DO_NEGOCIO },
  },
  crm_update_lead: {
    foto: fotoDoNegocio,
    projetar: { lead: MASCARA_DO_NEGOCIO, campos_nao_gravados: MASCARA_DO_CAMPO_RECUSADO },
  },
  crm_retomar_lead: {
    foto: fotoDoNegocio,
    projetar: { lead: MASCARA_DO_NEGOCIO },
  },
  crm_manage_tags: { foto: fotoDasEtiquetas },
};

export function regraDaPortaAdmin(nome: string): FerramentaDaPortaAdmin | null {
  return LEITURAS_DA_PORTA_ADMIN[nome] ?? ESCRITAS_DA_PORTA_ADMIN[nome] ?? null;
}

/** Ferramentas que nunca entram na porta Admin, mesmo se alguém as puser na lista. */
export const NUNCA_NA_PORTA_ADMIN = [
  "crm_send_whatsapp_message",
  "crm_start_conversation_and_send",
  "crm_create_conversation_draft",
  "crm_get_conversation",
  "crm_get_conversation_history",
  "crm_get_contact",
  "crm_search_contacts",
  "crm_get_lead",
  "crm_get_human_case",
  "crm_add_case_note",
] as const;
