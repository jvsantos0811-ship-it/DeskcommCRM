/**
 * EQUIPE RESPONDEU = HUMANO ASSUMIU (PC-029) — pelo CRM ou pelo celular.
 *
 * ─── A regra (João, 03/11 e 10/11/2026) ──────────────────────────────────────
 *
 * Quando uma pessoa da equipe entra na conversa, a IA não pode continuar
 * falando por cima: o cliente recebe duas vozes, a IA contradiz a pessoa e
 * repete pergunta. Lead que passou para a equipe fica com a equipe; a IA só
 * volta pelo botão "Devolver para a IA".
 *
 * ─── O que havia antes (e por que não bastava) ──────────────────────────────
 *
 *  - Resposta pela TELA do CRM calava a IA por 5 minutos (janela deslizante do
 *    `sendMessageHandler`); só assumia a conversa com "A conversa fica com quem
 *    atendeu" ligado.
 *  - Resposta pelo CELULAR calava por 60 minutos (ajustável) e a IA voltava
 *    sozinha (`pausarIaPorAtendimentoManual`). No canal intermediado,
 *    a resposta pelo celular numa conversa que JÁ existia nem calava a IA: só
 *    as redes sociais chamavam a pausa.
 *
 * ─── O que acontece agora, nos dois caminhos ────────────────────────────────
 *
 *  1. A conversa passa para quem respondeu (CRM), ou para o RESPONSÁVEL DO
 *     NÚMERO (celular, `channel_sessions.responsavel_user_id`), pela MESMA RPC do
 *     "Assumir" (`fn_conversation_assign`, trava otimista: conversa de outra
 *     pessoa não é tomada). Sem pessoa identificada, fica sem dono, marcada
 *     "Equipe (celular)".
 *  2. A IA cala de forma DURÁVEL (`bot_silenced_until = 'infinity'`) e o
 *     contato fica "só humano" (`contacts.force_human`): o mesmo estado da
 *     passagem para humano. `last_handoff_at` preenchido = a devolução
 *     automática por prazo não vale para ela (PC-014); só "Devolver" solta.
 *  3. As mensagens agendadas da conversa são canceladas, com a nota do
 *     "Sistema" no fio (a mesma frase da passagem, migration 9007).
 *  4. Os follow-ups seguem a política de passagem de cada fluxo na hora do
 *     envio (`pessoa-no-comando-no-turno.ts`): "pausar" (padrão) segura até
 *     alguém devolver; "cancelar" encerra a inscrição.
 *  5. No funil, o card vai para a "Etapa quando a equipe assume" do funil
 *     (Configurações › Funis), só se a etapa atual vem ANTES dela e não é de
 *     ganho nem de perda — pelo mesmo caminho do arrasto (`moveLeadHandler`).
 *  6. A linha do tempo diz "Equipe assumiu respondendo pelo CRM (nome)" ou
 *     "…pelo celular".
 *
 * Os passos 2–6 rodam UMA vez por episódio: a segunda mensagem da mesma pessoa
 * não refaz nota, movimento nem linha do tempo.
 *
 * ─── O que NÃO conta como pessoa ─────────────────────────────────────────────
 *
 * Quem chama decide: no CRM só entra envio por SESSÃO de uma pessoa (nunca a
 * IA, o fluxo, o modelo da Meta disparado pelo CRM, a integração por chave ou o
 * aviso do sistema); no celular, o eco do NOSSO envio sai antes, como
 * duplicata. A resposta automática do app do WhatsApp Business (saudação,
 * ausência) é reconhecida pelo TEXTO (`lib/messaging/textos-automaticos.ts`):
 * o mesmo texto em 3+ conversas, 80% das vezes até 60 s depois do cliente.
 * Antes de um texto se repetir 3 vezes, ele ainda conta como pessoa.
 *
 * Nunca lança: o envio (ou a ingestão) já aconteceu, e falhar aqui não pode
 * derrubar a mensagem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import type { ActivityType } from "@/lib/leads/activity-vocabulary";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import {
  MOTIVO_EQUIPE_RESPONDEU_PELO_CELULAR,
  MOTIVO_EQUIPE_RESPONDEU_PELO_CRM,
  destinoQuandoAEquipeAssume,
  etapaQuandoAEquipeAssume,
  fraseDaLinhaDoTempo,
  type EtapaDoFunil,
  type OrigemDaResposta,
} from "./equipe-assumiu-regra";
import {
  ehMensagemAutomatica,
  lerTextosAutomaticos,
  normalizarTexto,
} from "@/lib/messaging/textos-automaticos";
import { logger } from "@/lib/logger";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export {
  MOTIVO_EQUIPE_RESPONDEU_PELO_CRM,
  MOTIVO_EQUIPE_RESPONDEU_PELO_CELULAR,
  fraseDaLinhaDoTempo,
  destinoQuandoAEquipeAssume,
  etapaQuandoAEquipeAssume,
  type OrigemDaResposta,
  type EtapaDoFunil,
} from "./equipe-assumiu-regra";

// ─── Textos automáticos do app, com memória curta por empresa ───────────────

const MEMORIA_DOS_AUTOMATICOS_MS = 10 * 60 * 1000;
const automaticosPorOrg = new Map<string, { ate: number; textos: ReadonlySet<string> }>();

async function textosAutomaticosDaOrg(
  admin: SupabaseClient,
  orgId: string,
): Promise<ReadonlySet<string>> {
  const agora = Date.now();
  const guardado = automaticosPorOrg.get(orgId);
  if (guardado && guardado.ate > agora) return guardado.textos;
  try {
    const textos = await lerTextosAutomaticos(admin, orgId, new Date(agora));
    automaticosPorOrg.set(orgId, { ate: agora + MEMORIA_DOS_AUTOMATICOS_MS, textos });
    return textos;
  } catch (err) {
    // Sem a lista, a mensagem conta como pessoa: calar a IA a mais é o lado
    // seguro (o cliente não recebe duas vozes).
    logger.warn("[equipe-assumiu] textos automáticos não lidos", {
      organization_id: orgId,
      detalhe: err instanceof Error ? err.message.slice(0, 160) : "erro",
    });
    return new Set();
  }
}

/** Só para teste: esquece a memória dos textos automáticos. */
export function esquecerTextosAutomaticos(): void {
  automaticosPorOrg.clear();
}

// ─── O eco do NOSSO envio que chegou antes do id ────────────────────────────

/** Janela em que um envio do CRM ainda pode ter o eco chegando antes do id gravado. */
const JANELA_DO_ECO_MS = 3 * 60 * 1000;

/**
 * O canal pode entregar o eco de um envio do PRÓPRIO CRM (IA, fluxo, modelo)
 * ANTES de o envio gravar o id da mensagem — a linha nasce `external_device` e o
 * envio a apaga logo depois (`removerEcoDoProprioEnvio`). Contar esse eco como
 * pessoa calaria a IA pelo próprio envio, e agora para sempre. Por isso: se há,
 * na mesma conversa, um envio nosso com o MESMO texto nos últimos minutos, não é
 * pessoa. Sem texto (mídia sem legenda), vale um envio nosso SEM texto ainda
 * saindo. Texto diferente de tudo o que nós mandamos é pessoa, mesmo com um
 * envio nosso no ar: é a regra do #519 (`eco-do-envio-nao-silencia-o-bot`).
 */
async function ehEcoDeEnvioNoAr(
  admin: SupabaseClient,
  e: EntradaDaEquipeAssumiu,
): Promise<boolean> {
  try {
    const { data } = await admin
      .from("messages")
      .select("body, status")
      .eq("organization_id", e.organizationId)
      .eq("conversation_id", e.conversationId)
      .eq("direction", "outbound")
      .neq("sent_via", "external_device")
      .gte("created_at", new Date(Date.now() - JANELA_DO_ECO_MS).toISOString())
      .limit(20);
    const texto = normalizarTexto(e.texto);
    return ((data ?? []) as Array<{ body: string | null; status: string | null }>).some((m) =>
      texto !== ""
        ? normalizarTexto(m.body) === texto
        : normalizarTexto(m.body) === "" && (m.status === "sending" || m.status === "queued"),
    );
  } catch {
    return false;
  }
}

// ─── O que o "Assumir" e a resposta da equipe fazem igual ───────────────────

/**
 * O contato fica "só humano" (`contacts.force_human`, o mesmo estado da
 * passagem para humano) e as mensagens agendadas da conversa são canceladas,
 * com a nota do "Sistema" no fio. É o pedaço COMUM entre a equipe que assume
 * respondendo e o botão "Assumir" (Inbox e pop-up do negócio): o pedido do
 * João é um serviço só, sem caminho paralelo. O "Devolver" desfaz o
 * `force_human` (`devolverAtendimentoAoAgente`). Nunca lança; devolve quantas
 * agendadas cancelou.
 */
export async function contatoSoHumanoEAgendadasCanceladas(
  admin: SupabaseClient,
  alvo: { organizationId: string; conversationId: string; contactId: string | null },
): Promise<number> {
  try {
    if (alvo.contactId) {
      const { error } = await admin
        .from("contacts")
        .update({ force_human: true })
        .eq("organization_id", alvo.organizationId)
        .eq("id", alvo.contactId);
      if (error) throw new Error(`só humano: ${error.message}`);
    }
    const { data } = await admin.rpc("fn_cancelar_agendadas_da_conversa", {
      p_organization_id: alvo.organizationId,
      p_conversation_id: alvo.conversationId,
    });
    return typeof data === "number" ? data : 0;
  } catch (err) {
    logger.warn("[equipe-assumiu] só humano / agendadas não aplicados", {
      organization_id: alvo.organizationId,
      conversation_id: alvo.conversationId,
      detalhe: err instanceof Error ? err.message.slice(0, 160) : "erro",
    });
    return 0;
  }
}

// ─── O serviço ──────────────────────────────────────────────────────────────

export interface EntradaDaEquipeAssumiu {
  organizationId: string;
  conversationId: string;
  origem: OrigemDaResposta;
  /** Quem respondeu pela tela (CRM). No celular é `null`: o responsável do número entra no lugar. */
  userId: string | null;
  /** O nome de quem respondeu, para a linha do tempo. */
  nomeDaPessoa?: string | null;
  /** O texto da mensagem do celular, para reconhecer a resposta automática do app. */
  texto?: string | null;
  /**
   * Client que faz o "Assumir" (a RPC). No CRM é o da SESSÃO de quem respondeu
   * (o evento de troca de dono guarda quem mudou); no celular, o de serviço.
   */
  clientDoAssumir?: SupabaseClient;
  requestId?: string;
}

export interface ResultadoDaEquipeAssumiu {
  aplicado: boolean;
  motivo?: "grupo" | "automatica" | "eco_proprio" | "ja_assumida" | "sem_conversa" | "erro";
  dono?: string | null;
  agendadasCanceladas?: number;
  cardMovidoPara?: string | null;
}

export async function equipeAssumiuRespondendo(
  admin: SupabaseClient,
  e: EntradaDaEquipeAssumiu,
): Promise<ResultadoDaEquipeAssumiu> {
  try {
    const { data: conv, error } = await admin
      .from("conversations")
      .select(
        "id, contact_id, channel_session_id, is_group, assigned_to_user_id, bot_silenced_until, last_handoff_reason, last_handoff_at, service_started_at",
      )
      .eq("organization_id", e.organizationId)
      .eq("id", e.conversationId)
      .maybeSingle();
    if (error || !conv) return { aplicado: false, motivo: "sem_conversa" };
    const c = conv as {
      id: string;
      contact_id: string | null;
      channel_session_id: string | null;
      is_group: boolean | null;
      assigned_to_user_id: string | null;
      bot_silenced_until: string | null;
      last_handoff_reason: string | null;
      last_handoff_at: string | null;
      service_started_at: string | null;
    };
    if (c.is_group) return { aplicado: false, motivo: "grupo" };

    if (e.origem === "celular") {
      if (await ehEcoDeEnvioNoAr(admin, e)) return { aplicado: false, motivo: "eco_proprio" };
      const automaticos = await textosAutomaticosDaOrg(admin, e.organizationId);
      if (
        ehMensagemAutomatica(
          { direction: "outbound", sent_via: "external_device", body: e.texto ?? null },
          automaticos,
        )
      ) {
        return { aplicado: false, motivo: "automatica" };
      }
    }

    // ── 1) quem fica com a conversa ────────────────────────────────────────
    let dono = e.userId;
    if (!dono && e.origem === "celular" && c.channel_session_id) {
      const { data: sessao } = await admin
        .from("channel_sessions")
        .select("responsavel_user_id")
        .eq("organization_id", e.organizationId)
        .eq("id", c.channel_session_id)
        .maybeSingle();
      dono =
        (sessao as { responsavel_user_id?: string | null } | null)?.responsavel_user_id ?? null;
    }
    let assumiu = false;
    if (dono && !c.assigned_to_user_id) {
      const { data: claimed, error: claimErr } = await (e.clientDoAssumir ?? admin).rpc(
        "fn_conversation_assign",
        {
          p_organization_id: e.organizationId,
          p_conversation_id: e.conversationId,
          p_to_user_id: dono,
          p_reason: "claim",
          p_enforce_expected: true,
        },
      );
      if (claimErr) {
        logger.warn("[equipe-assumiu] o assumir falhou — a IA cala mesmo assim", {
          organization_id: e.organizationId,
          conversation_id: e.conversationId,
          detalhe: claimErr.message.slice(0, 160),
        });
      }
      assumiu = Array.isArray(claimed) && claimed.length > 0;
      if (assumiu) {
        // O mesmo rastro do botão "Assumir": auditoria e evento.
        await audit({
          action: "conversation.claimed",
          actorUserId: e.userId,
          organizationId: e.organizationId,
          resourceType: "conversation",
          resourceId: e.conversationId,
          requestId: e.requestId,
          metadata: { via: "resposta", origem: e.origem, dono },
        });
        const { error: emitErr } = await admin.rpc("emit_event", {
          p_event_type: "conversation.claimed",
          p_entity_kind: "conversation",
          p_entity_id: e.conversationId,
          p_payload: { assigned_to_user_id: dono },
          p_metadata: { request_id: e.requestId ?? null, via: "resposta", origem: e.origem },
          p_organization_id: e.organizationId,
        });
        if (emitErr) {
          logger.warn("[equipe-assumiu] emit_event falhou", {
            organization_id: e.organizationId,
            detalhe: emitErr.message,
          });
        }
      }
    }

    // ── 2–6 uma vez por episódio ────────────────────────────────────────────
    const motivoGravado =
      e.origem === "crm" ? MOTIVO_EQUIPE_RESPONDEU_PELO_CRM : MOTIVO_EQUIPE_RESPONDEU_PELO_CELULAR;
    const jaEstaComAEquipe =
      c.bot_silenced_until === "infinity" &&
      (c.last_handoff_reason === MOTIVO_EQUIPE_RESPONDEU_PELO_CRM ||
        c.last_handoff_reason === MOTIVO_EQUIPE_RESPONDEU_PELO_CELULAR) &&
      (!c.service_started_at || !c.last_handoff_at || c.last_handoff_at >= c.service_started_at);
    if (jaEstaComAEquipe) return { aplicado: false, motivo: "ja_assumida", dono };

    const agora = new Date().toISOString();
    const { error: silErr } = await admin
      .from("conversations")
      .update({
        bot_silenced_until: "infinity",
        last_handoff_at: agora,
        last_handoff_reason: motivoGravado,
      })
      .eq("organization_id", e.organizationId)
      .eq("id", e.conversationId);
    if (silErr) throw new Error(`silêncio: ${silErr.message}`);

    const canceladas = await contatoSoHumanoEAgendadasCanceladas(admin, {
      organizationId: e.organizationId,
      conversationId: e.conversationId,
      contactId: c.contact_id,
    });

    const ator: Actor = e.userId
      ? { type: "user", id: e.userId }
      : dono
        ? { type: "user", id: dono }
        : { type: "webhook_source", id: c.channel_session_id ?? e.conversationId };
    // O nome só é lido aqui, uma vez por episódio (é uma ida ao serviço de login).
    const nome =
      e.nomeDaPessoa ??
      (e.userId ? ((await nomesDosAtendentes([e.userId])).get(e.userId) ?? null) : null);
    const frase = fraseDaLinhaDoTempo(e.origem, nome);

    // O negócio do contato, lido UMA vez e pelo MESMO cliente de serviço: ele
    // recebe a linha do tempo e, se for o caso, anda no funil. (Não passa por
    // `registrarTrocaDeComando`, que abre um segundo cliente de serviço para
    // furar a visibilidade de quem clicou — aqui o cliente já é o de serviço.)
    let cardMovidoPara: string | null = null;
    if (c.contact_id) {
      const lead = await negocioDoContato(admin, e.organizationId, c.contact_id);
      if (lead) {
        const linha = await emitLeadActivity(admin, {
          organizationId: e.organizationId,
          leadId: lead.id,
          contactId: c.contact_id,
          type: "conversation_claimed" satisfies ActivityType,
          sourceModule: "inbox.comando",
          sourceId: e.conversationId,
          actor: ator,
          reason: frase,
          payload: { conversation_id: e.conversationId, origem: e.origem, assumiu },
        });
        if (!linha.ok) {
          logger.warn("[equipe-assumiu] linha do tempo não gravada", {
            organization_id: e.organizationId,
            conversation_id: e.conversationId,
          });
        }
        cardMovidoPara = await moverParaAEtapaDaEquipe(admin, e, lead, ator, frase);
      }
    }

    return {
      aplicado: true,
      dono,
      agendadasCanceladas: canceladas,
      cardMovidoPara,
    };
  } catch (err) {
    logger.warn("[equipe-assumiu] não aplicado", {
      organization_id: e.organizationId,
      conversation_id: e.conversationId,
      origem: e.origem,
      detalhe: err instanceof Error ? err.message.slice(0, 200) : "erro",
    });
    return { aplicado: false, motivo: "erro" };
  }
}

type NegocioDoContato = LeadCandidate & { stage_id: string | null };

/** O negócio ativo do contato, pela mesma régua da Inbox (`resolveActiveLeadForContact`). */
async function negocioDoContato(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<NegocioDoContato | null> {
  const [{ data: leads }, { data: padrao }] = await Promise.all([
    admin
      .from("crm_leads")
      .select("id, organization_id, pipeline_id, stage_id, status, last_activity_at, created_at")
      .eq("organization_id", orgId)
      .eq("contact_id", contactId),
    admin
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", orgId)
      .eq("is_default", true)
      .eq("is_archived", false)
      .limit(1)
      .maybeSingle(),
  ]);
  const candidatos = (leads ?? []) as NegocioDoContato[];
  const alvo = resolveActiveLeadForContact(candidatos, {
    defaultPipelineId: (padrao as { id: string } | null)?.id ?? null,
  });
  if (!alvo.routed) return null;
  return candidatos.find((l) => l.id === alvo.leadId) ?? null;
}

async function moverParaAEtapaDaEquipe(
  admin: SupabaseClient,
  e: EntradaDaEquipeAssumiu,
  lead: NegocioDoContato,
  ator: Actor,
  frase: string,
): Promise<string | null> {
  const [{ data: funil }, { data: etapas }] = await Promise.all([
    admin
      .from("crm_pipelines")
      .select("settings")
      .eq("organization_id", e.organizationId)
      .eq("id", lead.pipeline_id)
      .maybeSingle(),
    admin
      .from("crm_stages")
      .select("id, position, is_won, is_lost, is_archived")
      .eq("organization_id", e.organizationId)
      .eq("pipeline_id", lead.pipeline_id),
  ]);
  const destino = destinoQuandoAEquipeAssume(
    (etapas ?? []) as EtapaDoFunil[],
    lead.stage_id,
    etapaQuandoAEquipeAssume((funil as { settings?: unknown } | null)?.settings),
  );
  if (!destino) return null;
  try {
    await moveLeadHandler(
      admin,
      {
        organization_id: e.organizationId,
        actor: ator,
        requestId: e.requestId ?? `equipe-assumiu:${e.conversationId}`,
      },
      lead.id,
      { to_stage_id: destino, reason: frase },
    );
    return destino;
  } catch (err) {
    logger.warn("[equipe-assumiu] card não movido", {
      organization_id: e.organizationId,
      lead_id: lead.id,
      detalhe: err instanceof Error ? err.message.slice(0, 160) : "erro",
    });
    return null;
  }
}
