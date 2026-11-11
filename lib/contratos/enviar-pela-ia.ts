/**
 * A IA ENVIA O CONTRATO (PC-030, item 4) — o que a ferramenta `enviar_contrato`
 * faz, fora do turno (o turno só traduz o resultado para o modelo).
 *
 * Ordem, e por quê:
 *  1. o negócio ATIVO do contato (sem adivinhar quando há dois abertos);
 *  2. o serviço de assinatura ligado (sem ele, nada é gerado);
 *  3. as travas da regra pura (`decidirEnvioPelaIa`): etapa configurada, "já tem
 *     advogado ou processo?" CONFIRMADO com NÃO — SIM volta como
 *     `tem_advogado_ou_processo`, e o turno passa para a equipe;
 *  4. um contrato vivo do negócio (enviado ou esperando aprovação) NÃO vira um
 *     segundo: a IA ouve que ele já foi;
 *  5. gera pelo modelo aprovado (`gerarContratoDoModelo` confere modelo,
 *     aprovação, campos CONFIRMADOS, CPF e CEP — e diz o que perguntar);
 *  6. aprovação da equipe LIGADA → caso "Contrato pronto para aprovar" e para;
 *  7. fora da janela de 24 h do canal → caso para a equipe (o link não sai como
 *     texto livre; a equipe envia com o modelo da Meta);
 *  8. envia pelo caminho de sempre (`enviarContrato`: pedido no serviço, link
 *     pelo WhatsApp, linha do tempo, auditoria) e põe a tag `contrato-enviado`.
 *
 * Toda falha (serviço fora, dado recusado) abre o caso "Contrato não gerado"
 * com o motivo e devolve à IA que a equipe vai mandar — nunca silêncio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { estadoDaJanela } from "@/lib/channels/janela";
import { servicoDaOrganizacao } from "@/lib/contratos/assinatura/conta";
import { abrirCasoDoContrato } from "@/lib/contratos/caso-do-contrato";
import { enviarContrato } from "@/lib/contratos/enviar";
import { gerarContratoDoModelo } from "@/lib/contratos/gerar-do-modelo";
import {
  CAMPO_ADVOGADO_OU_PROCESSO,
  CASO_CONTRATO_NAO_GERADO,
  CASO_CONTRATO_PRONTO_PARA_APROVAR,
  decidirEnvioPelaIa,
  etapaDoContrato,
  TAG_CONTRATO_ENVIADO,
} from "@/lib/contratos/regra-da-ia";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { statusDosCampos } from "@/lib/leads/status-dos-campos";
import { logger } from "@/lib/logger";

/** A legenda do PDF que vai ao cliente: neutra, sem promessa (OAB). */
export const LEGENDA_DO_CONTRATO =
  "Segue o contrato para você ler com calma. Para assinar, é só abrir o link abaixo e seguir os passos na tela.";

export type ResultadoDoEnvioPelaIa =
  | { status: "enviado"; contratoId: string; leadId: string }
  | { status: "ja_enviado"; contratoId: string; enviadoEm: string | null }
  | { status: "aguardando_aprovacao"; contratoId: string }
  | { status: "fora_da_janela"; contratoId: string }
  | { status: "tem_advogado_ou_processo"; leadId: string; mensagem: string }
  | { status: "recusado"; motivo: string; mensagem: string }
  | { status: "faltam_dados"; faltas: string[] }
  | { status: "falhou"; motivo: string };

interface NegocioParaOContrato {
  id: string;
  pipeline_id: string;
  stage_id: string | null;
  custom_fields: Record<string, unknown> | null;
  status_dos_campos: unknown;
  settings: Record<string, unknown> | null;
}

/** O negócio ativo do contato, com o funil — `null` quando não há um só. */
export async function negocioAtivoDoContato(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<NegocioParaOContrato | null> {
  const [{ data: leads }, { data: padrao }] = await Promise.all([
    admin
      .from("crm_leads")
      .select("id, organization_id, pipeline_id, stage_id, status, last_activity_at, created_at, custom_fields, status_dos_campos")
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
  const linhas = (leads ?? []) as Array<LeadCandidate & Omit<NegocioParaOContrato, "settings">>;
  const rota = resolveActiveLeadForContact(linhas, {
    defaultPipelineId: (padrao as { id: string } | null)?.id ?? null,
  });
  if (!rota.routed) return null;
  const lead = linhas.find((l) => l.id === rota.leadId)!;
  const { data: funil } = await admin
    .from("crm_pipelines")
    .select("settings")
    .eq("organization_id", orgId)
    .eq("id", lead.pipeline_id)
    .maybeSingle();
  return {
    id: lead.id,
    pipeline_id: lead.pipeline_id,
    stage_id: lead.stage_id,
    custom_fields: lead.custom_fields,
    status_dos_campos: lead.status_dos_campos,
    settings: ((funil as { settings?: Record<string, unknown> } | null)?.settings ?? null) as Record<string, unknown> | null,
  };
}

export async function enviarContratoPelaIa(
  admin: SupabaseClient,
  e: {
    orgId: string;
    contactId: string;
    conversationId: string;
    agentId: string | null;
    requestId: string;
    agora?: Date;
  },
): Promise<ResultadoDoEnvioPelaIa> {
  const actor: Actor = e.agentId
    ? { type: "ai_agent", id: e.agentId, agent_id: e.agentId, role: "ai_operator" }
    : { type: "webhook_source", id: "enviar_contrato" };

  const lead = await negocioAtivoDoContato(admin, e.orgId, e.contactId);
  if (!lead) {
    return {
      status: "recusado",
      motivo: "sem_negocio",
      mensagem: "não há um negócio aberto (e só um) deste cliente. Não envie contrato; siga a conversa.",
    };
  }

  const servico = await servicoDaOrganizacao(admin, e.orgId);
  if (!servico.ok) {
    return {
      status: "recusado",
      motivo: "servico_nao_configurado",
      mensagem: "a assinatura eletrônica não está ligada neste escritório. Não prometa o contrato: diga que a equipe vai mandar.",
    };
  }

  // A regra pura: etapa, e "já tem advogado ou processo?".
  const destino = etapaDoContrato(lead.settings);
  const campo = camposDoFunil(lead.settings).find((c) => c.key === CAMPO_ADVOGADO_OU_PROCESSO);
  let nomeDaEtapa: string | null = null;
  if (destino) {
    const { data: etapa } = await admin
      .from("crm_stages")
      .select("name")
      .eq("organization_id", e.orgId)
      .eq("id", destino)
      .maybeSingle();
    nomeDaEtapa = (etapa as { name: string } | null)?.name ?? null;
  }
  const decisao = decidirEnvioPelaIa({
    etapaDoContrato: destino,
    etapaAtual: lead.stage_id,
    nomeDaEtapaDoContrato: nomeDaEtapa,
    campoAdvogado: {
      existe: Boolean(campo),
      status: statusDosCampos(lead.status_dos_campos)[CAMPO_ADVOGADO_OU_PROCESSO] ?? null,
      valor: lead.custom_fields?.[CAMPO_ADVOGADO_OU_PROCESSO],
    },
  });
  if (!decisao.pode) {
    if (decisao.motivo === "tem_advogado_ou_processo") {
      return { status: "tem_advogado_ou_processo", leadId: lead.id, mensagem: decisao.mensagem };
    }
    return { status: "recusado", motivo: decisao.motivo, mensagem: decisao.mensagem };
  }

  // Um contrato vivo não vira um segundo.
  const { data: vivos } = await admin
    .from("crm_contracts")
    .select("id, status, origem_envio, enviado_em")
    .eq("organization_id", e.orgId)
    .eq("lead_id", lead.id)
    .in("status", ["enviado", "rascunho"])
    .order("created_at", { ascending: false });
  const vivo = ((vivos ?? []) as Array<{ id: string; status: string; origem_envio: string; enviado_em: string | null }>).find(
    (c) => c.status === "enviado" || c.origem_envio === "ia",
  );
  if (vivo?.status === "enviado") return { status: "ja_enviado", contratoId: vivo.id, enviadoEm: vivo.enviado_em };
  if (vivo && servico.valor.conta.aprovacao_da_equipe) return { status: "aguardando_aprovacao", contratoId: vivo.id };

  // Gera (ou reaproveita o rascunho que a própria IA gerou e não saiu).
  let contratoId: string;
  if (vivo) {
    contratoId = vivo.id;
  } else {
    const gerado = await gerarContratoDoModelo(admin, {
      orgId: e.orgId,
      leadId: lead.id,
      origem: "ia",
      actor,
      userId: null,
    });
    if (!gerado.ok) {
      if (gerado.codigo === "faltam_dados") return { status: "faltam_dados", faltas: gerado.faltas.map((f) => f.frase) };
      return {
        status: "recusado",
        motivo: gerado.codigo,
        mensagem:
          gerado.codigo === "sem_modelo" || gerado.codigo === "modelo_sem_aprovacao"
            ? "não há modelo de contrato aprovado pelo advogado para este pedido. Não prometa o contrato: diga que a equipe vai mandar."
            : "não achei o negócio deste cliente. Não envie contrato; siga a conversa.",
      };
    }
    contratoId = gerado.contrato.id;
  }

  const { data: conversa } = await admin
    .from("conversations")
    .select("id, last_inbound_at, channel_session_id")
    .eq("organization_id", e.orgId)
    .eq("id", e.conversationId)
    .maybeSingle();
  const c = conversa as { last_inbound_at: string | null; channel_session_id: string | null } | null;
  const { data: canal } = c?.channel_session_id
    ? await admin
        .from("channel_sessions")
        .select("provider")
        .eq("organization_id", e.orgId)
        .eq("id", c.channel_session_id)
        .maybeSingle()
    : { data: null };

  // Aprovação da equipe LIGADA: a pessoa confere o PDF e clica "Aprovar e enviar".
  if (servico.valor.conta.aprovacao_da_equipe) {
    await abrirCasoDoContrato(admin, {
      orgId: e.orgId,
      conversationId: e.conversationId,
      leadId: lead.id,
      contratoId,
      titulo: CASO_CONTRATO_PRONTO_PARA_APROVAR,
      resumo:
        "A IA gerou o contrato pelo modelo aprovado, com os dados confirmados pelo cliente. Confira o PDF no card do negócio antes de enviar.",
      bloqueio: 'Abrir o card do negócio, conferir o PDF e clicar "Aprovar e enviar" (ou "Corrigir").',
    });
    return { status: "aguardando_aprovacao", contratoId };
  }

  // Fora da janela de 24 h do canal, o link não sai como texto livre.
  const provedorDoCanal = (canal as { provider: string | null } | null)?.provider ?? null;
  const janela = estadoDaJanela(provedorDoCanal, c?.last_inbound_at ?? null, e.agora ?? new Date());
  if (janela.tipo === "fechada") {
    await abrirCasoDoContrato(admin, {
      orgId: e.orgId,
      conversationId: e.conversationId,
      leadId: lead.id,
      contratoId,
      titulo: "Contrato pronto, fora da janela de 24 h",
      resumo:
        "O contrato foi gerado, mas o cliente não escreve há mais de 24 h: pelo canal oficial o link só sai com um modelo aprovado da Meta.",
      bloqueio: "Enviar o contrato pelo card com um modelo aprovado, ou esperar o cliente escrever.",
    });
    return { status: "fora_da_janela", contratoId };
  }

  try {
    const r = await enviarContrato(admin, {
      orgId: e.orgId,
      contratoId,
      actor,
      userId: null,
      mensagem: LEGENDA_DO_CONTRATO,
      requestId: e.requestId,
      t: (texto) => texto,
    });
    if (!r.ok || !r.enviado) {
      const motivo = r.ok ? (r.contrato.ultima_falha_envio ?? "o envio não saiu") : r.mensagem;
      await casoDeFalha(admin, e, lead.id, contratoId, motivo);
      return { status: "falhou", motivo };
    }
    await admin.rpc("fn_lead_adicionar_etiquetas", {
      p_org: e.orgId,
      p_lead: lead.id,
      p_etiquetas: [TAG_CONTRATO_ENVIADO],
    });
    return { status: "enviado", contratoId, leadId: lead.id };
  } catch (err) {
    const motivo = err instanceof Error ? err.message.slice(0, 200) : "erro";
    logger.warn("[contrato] envio pela IA falhou", { organization_id: e.orgId, contrato_id: contratoId, detalhe: motivo });
    await casoDeFalha(admin, e, lead.id, contratoId, motivo);
    return { status: "falhou", motivo };
  }
}

async function casoDeFalha(
  admin: SupabaseClient,
  e: { orgId: string; conversationId: string },
  leadId: string,
  contratoId: string,
  motivo: string,
) {
  await abrirCasoDoContrato(admin, {
    orgId: e.orgId,
    conversationId: e.conversationId,
    leadId,
    contratoId,
    titulo: CASO_CONTRATO_NAO_GERADO,
    resumo: `A IA tentou enviar o contrato e não conseguiu: ${motivo}`,
    bloqueio: "Conferir o motivo e enviar o contrato pelo card do negócio.",
  });
}

/** O que o modelo recebe de cada desfecho: curto, com o que fazer a seguir. Pura. */
export function resultadoDoEnvioParaOModelo(r: ResultadoDoEnvioPelaIa): Record<string, unknown> {
  switch (r.status) {
    case "enviado":
      return {
        ok: true,
        status: "enviado",
        message:
          "Contrato enviado com o link de assinatura. Explique em poucas palavras como assinar (abrir o link, conferir os dados e assinar na tela), sem prometer resultado nem prazo do caso.",
      };
    case "ja_enviado":
      return {
        ok: true,
        status: "ja_enviado",
        message: "O contrato já foi enviado a este cliente e o link continua valendo. Não envie outro; ajude com a assinatura se ele pedir.",
      };
    case "aguardando_aprovacao":
      return {
        ok: true,
        status: "aguardando_aprovacao",
        message: "O contrato está pronto e a equipe confere antes de enviar. Diga ao cliente que o contrato chega em seguida pela equipe.",
      };
    case "fora_da_janela":
      return {
        ok: true,
        status: "com_a_equipe",
        message: "O contrato está pronto e a equipe vai enviar. Diga ao cliente que ele recebe o contrato em seguida.",
      };
    case "faltam_dados":
      return {
        ok: false,
        error: {
          code: "faltam_dados",
          message: `Antes do contrato, confirme com o cliente: ${r.faltas.join(" ")}`,
        },
      };
    case "recusado":
      return { ok: false, error: { code: r.motivo, message: r.mensagem } };
    case "tem_advogado_ou_processo":
      return { ok: true, status: "passou_para_a_equipe", message: r.mensagem };
    case "falhou":
      return {
        ok: false,
        error: {
          code: "contrato_nao_gerado",
          message: "Não consegui enviar o contrato agora. Diga ao cliente que a equipe vai mandar o contrato em seguida.",
        },
      };
  }
}
