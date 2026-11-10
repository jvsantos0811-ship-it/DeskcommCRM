/**
 * ENVIAR O CONTRATO AO CLIENTE (fork 9008; serviço de assinatura no PC-030).
 *
 * O miolo que a rota `POST /contracts/:id/send` (pessoa) e a ferramenta
 * `enviar_contrato` (IA, PC-030 parte 2) usam — um caminho só.
 *
 *   1. o contrato precisa estar em `rascunho` ou `enviado` (reenviar é pedir
 *      outra via, e o cliente pede);
 *   2. a conversa é a do contato do NEGÓCIO (a mais recente, fora de grupo);
 *   3. o provedor prepara o documento: o `manual` não prepara nada; um serviço
 *      eletrônico cria o pedido de assinatura (com o signatário e o prazo da
 *      conta) — e, num reenvio com pedido ainda vivo, REAPROVEITA o link em vez
 *      de abrir outro envelope (cada envelope custa);
 *   4. a cópia do PDF entra na pasta da conversa em `whatsapp-media`;
 *   5. a mensagem sai pelo MESMO handler da Inbox.
 *
 * O desfecho é decidido pelo status DEVOLVIDO pela mensagem, nunca pela
 * ausência de exceção: `failed` mantém o estado de antes e grava o motivo no
 * contrato; `queued` (canal fora do ar) já conta como enviado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { BUCKET_DOS_CONTRATOS, caminhoDaCopiaNaConversa, nomeDoArquivoParaOCliente } from "@/lib/contratos/arquivo";
import { servicoDaOrganizacao } from "@/lib/contratos/assinatura/conta";
import { ErroDoServico, type Signatario } from "@/lib/contratos/assinatura/servico";
import { cpfValido } from "@/lib/contratos/modelo-do-contrato";
import { provedorDeAssinatura, type PreparoDaAssinatura } from "@/lib/contratos/provedores";
import { COLUNAS_DO_CONTRATO, carregarContrato, paraATela, type LinhaDoContrato } from "@/lib/contratos/servidor";
import type { ContratoDoNegocio } from "@/lib/contratos/tipos";
import { ehProvedorEletronico, podeEnviar } from "@/lib/contratos/vocabulario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { logger } from "@/lib/logger";
import { fusoDaOrganizacao, somarDiasNoFuso } from "@/lib/propostas/data-no-fuso";

export type RecusaDoEnvio = {
  ok: false;
  status: 404 | 409 | 422;
  codigo: "not_found" | "invalid_state_transition" | "validation_failed";
  mensagem: string;
};

export interface EntradaDoEnvio {
  orgId: string;
  contratoId: string;
  actor: Actor;
  /** Quem enviou, quando é uma pessoa. A IA envia com `null`. */
  userId: string | null;
  /** O texto que vai junto com o arquivo (e o link, quando há). */
  mensagem: string;
  idioma?: Idioma;
  requestId: string;
  t: (texto: string) => string;
}

const digitos = (v: unknown) => (typeof v === "string" ? v.replace(/\D/g, "") : "");

/** Quem assina: o nome completo do negócio (se houver), o telefone do contato, o CPF válido. */
async function signatarioDoNegocio(
  admin: SupabaseClient,
  orgId: string,
  leadId: string | null,
  contatoId: string,
): Promise<Signatario | null> {
  const [{ data: contato }, { data: lead }] = await Promise.all([
    admin
      .from("contacts")
      .select("display_name, name, phone_number, email")
      .eq("organization_id", orgId)
      .eq("id", contatoId)
      .maybeSingle(),
    leadId
      ? admin.from("crm_leads").select("custom_fields").eq("organization_id", orgId).eq("id", leadId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const c = contato as { display_name?: string | null; name?: string | null; phone_number?: string | null; email?: string | null } | null;
  const campos = ((lead as { custom_fields?: Record<string, unknown> | null } | null)?.custom_fields ?? {}) as Record<
    string,
    unknown
  >;
  const telefone = digitos(c?.phone_number ?? "");
  // O nome completo confirmado no funil vence; sem ele, o nome do contato pela
  // regra única de nome (`nomeDoContato`).
  const nome =
    (typeof campos.nome_completo === "string" && campos.nome_completo.trim()) || nomeDoContato(c) || "";
  if (!nome || telefone.length < 10) return null;
  const cpf = cpfValido(campos.cpf) ? digitos(String(campos.cpf)) : null;
  const emailCampo = typeof campos.email === "string" ? campos.email.trim() : "";
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailCampo) ? emailCampo : (c?.email ?? null);
  return { nome: nome.slice(0, 200), telefone: telefone.startsWith("55") ? telefone : `55${telefone}`, cpf, email };
}

export async function enviarContrato(
  admin: SupabaseClient,
  e: EntradaDoEnvio,
): Promise<{ ok: true; contrato: ContratoDoNegocio; enviado: boolean } | RecusaDoEnvio> {
  const { t } = e;
  const contrato = await carregarContrato(admin, e.orgId, e.contratoId);
  if (!contrato) return { ok: false, status: 404, codigo: "not_found", mensagem: t("Contrato não encontrado.") };
  if (!podeEnviar(contrato.status)) {
    return {
      ok: false,
      status: 409,
      codigo: "invalid_state_transition",
      mensagem: t("Este contrato já foi encerrado e não pode ser enviado."),
    };
  }
  if (!contrato.arquivo_path) {
    return { ok: false, status: 422, codigo: "validation_failed", mensagem: t("O arquivo deste contrato não existe mais.") };
  }

  // O contato é o do NEGÓCIO de agora: se o card mudou de contato (cadastro
  // duplicado juntado), o contrato vai para quem o negócio é hoje.
  const { data: lead } = contrato.lead_id
    ? await admin
        .from("crm_leads")
        .select("id, contact_id")
        .eq("organization_id", e.orgId)
        .eq("id", contrato.lead_id)
        .maybeSingle()
    : { data: null };
  const contatoId = (lead as { contact_id: string | null } | null)?.contact_id ?? contrato.contact_id;
  if (!contatoId) {
    return {
      ok: false,
      status: 422,
      codigo: "validation_failed",
      mensagem: t("Este negócio não tem contato para receber o contrato."),
    };
  }

  const { data: conversa } = await admin
    .from("conversations")
    .select("id, channel_session_id")
    .eq("organization_id", e.orgId)
    .eq("contact_id", contatoId)
    .eq("is_group", false)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conversa) {
    return {
      ok: false,
      status: 422,
      codigo: "validation_failed",
      mensagem: t("Este contato ainda não tem conversa no WhatsApp para receber o contrato."),
    };
  }
  const conversaId = (conversa as { id: string }).id;

  const provedor = provedorDeAssinatura(contrato.provedor_assinatura);
  const nomeDoArquivo = nomeDoArquivoParaOCliente(contrato.titulo);

  const falhar = async (motivo: string, extra: Partial<LinhaDoContrato> = {}) => {
    logger.warn("contracts.send_failed", { organizationId: e.orgId, contratoId: contrato.id, erro: motivo });
    const { data: falhou } = await admin
      .from("crm_contracts")
      .update({ ultima_falha_envio: motivo, ...extra })
      .eq("organization_id", e.orgId)
      .eq("id", contrato.id)
      .select(COLUNAS_DO_CONTRATO)
      .single();
    const [tela] = await paraATela(admin, e.orgId, [(falhou ?? contrato) as unknown as LinhaDoContrato]);
    return { ok: true as const, contrato: tela!, enviado: false };
  };

  let mensagem: Awaited<ReturnType<typeof sendMessageHandler>>;
  let preparo: PreparoDaAssinatura;
  try {
    const { data: original, error: dlErr } = await admin.storage
      .from(BUCKET_DOS_CONTRATOS)
      .download(contrato.arquivo_path);
    if (dlErr || !original) throw new Error(t("Não foi possível ler o arquivo do contrato."));
    const pdf = Buffer.from(await original.arrayBuffer());

    if (ehProvedorEletronico(contrato.provedor_assinatura) && contrato.provedor_documento_id && contrato.link_assinatura) {
      // Reenvio com pedido vivo no serviço: o mesmo link, sem outro envelope.
      preparo = { documentoId: contrato.provedor_documento_id, linkAssinatura: contrato.link_assinatura };
    } else if (ehProvedorEletronico(contrato.provedor_assinatura)) {
      const s = await servicoDaOrganizacao(admin, e.orgId);
      if (!s.ok) throw new Error(t("O serviço de assinatura eletrônica não está configurado nesta organização."));
      const signatario = await signatarioDoNegocio(admin, e.orgId, contrato.lead_id, contatoId);
      if (!signatario) throw new Error(t("Falta o nome ou o telefone do cliente para o pedido de assinatura."));
      const prazo = somarDiasNoFuso(new Date(), s.valor.conta.prazo_para_assinar_dias, await fusoDaOrganizacao(admin, e.orgId));
      preparo = await provedor.preparar({
        organizationId: e.orgId,
        contratoId: contrato.id,
        pdf,
        nomeDoArquivo,
        signatario,
        prazo,
        servico: s.valor.servico,
      });
    } else {
      preparo = await provedor.preparar({ organizationId: e.orgId, contratoId: contrato.id, pdf, nomeDoArquivo });
    }

    const copia = caminhoDaCopiaNaConversa(e.orgId, conversaId, contrato.id, nomeDoArquivo);
    const { error: upErr } = await admin.storage
      .from("whatsapp-media")
      .upload(copia, pdf, { contentType: "application/pdf", upsert: true });
    if (upErr) throw new Error(t("Não foi possível preparar o arquivo para o WhatsApp."));

    const legenda = [e.mensagem, preparo.linkAssinatura ?? ""].filter((p) => p.trim()).join("\n\n");
    mensagem = await sendMessageHandler(
      admin,
      { organization_id: e.orgId, actor: e.actor, requestId: e.requestId, ...(e.idioma ? { idioma: e.idioma } : {}) },
      {
        conversation_id: conversaId,
        type: "document",
        media_storage_path: copia,
        media_mime: "application/pdf",
        media_size_bytes: pdf.length,
        ...(legenda ? { body: legenda } : {}),
      },
    );
  } catch (erro) {
    if (erro instanceof ErroDoServico) {
      const motivo =
        erro.codigo === "credencial_invalida"
          ? t("O serviço de assinatura recusou a chave da organização.")
          : erro.codigo === "dado_recusado"
            ? t("O serviço de assinatura recusou os dados do pedido.")
            : t("O serviço de assinatura está fora do ar. Tente de novo em alguns minutos.");
      return falhar(motivo);
    }
    return falhar(erro instanceof Error && erro.message ? erro.message : t("Falha desconhecida ao enviar."));
  }

  if (mensagem.status === "failed") {
    return falhar(mensagem.error_message ?? t("O WhatsApp não aceitou o envio."), {
      message_id: mensagem.id,
      conversation_id: conversaId,
      contact_id: contatoId,
      // O pedido no serviço já existe: guardá-lo evita outro envelope no reenvio.
      provedor_documento_id: preparo.documentoId,
      link_assinatura: preparo.linkAssinatura,
    });
  }

  const reenvio = contrato.status === "enviado";
  const { data: enviado } = await admin
    .from("crm_contracts")
    .update({
      status: "enviado",
      enviado_em: new Date().toISOString(),
      enviado_por_user_id: e.userId,
      message_id: mensagem.id,
      conversation_id: conversaId,
      contact_id: contatoId,
      ultima_falha_envio: null,
      provedor_documento_id: preparo.documentoId,
      link_assinatura: preparo.linkAssinatura,
    })
    .eq("organization_id", e.orgId)
    .eq("id", contrato.id)
    .select(COLUNAS_DO_CONTRATO)
    .single();

  if (contrato.lead_id) {
    await emitLeadActivity(admin, {
      organizationId: e.orgId,
      leadId: contrato.lead_id,
      contactId: contatoId,
      type: "contract_sent",
      sourceModule: "contracts",
      sourceId: contrato.id,
      actor: e.actor,
      reason: reenvio
        ? "Contrato enviado de novo ao cliente pelo WhatsApp"
        : preparo.linkAssinatura
          ? "Contrato enviado ao cliente pelo WhatsApp com o link de assinatura"
          : "Contrato enviado ao cliente pelo WhatsApp, aguardando assinatura",
    });
  }
  void audit({
    action: "contract.sent",
    actorUserId: e.userId,
    organizationId: e.orgId,
    resourceType: "crm_contracts",
    resourceId: contrato.id,
    requestId: e.requestId,
    metadata: {
      lead_id: contrato.lead_id,
      message_id: mensagem.id,
      entrega: mensagem.status,
      reenvio,
      provedor: provedor.id,
      com_link: Boolean(preparo.linkAssinatura),
    },
  });

  const [tela] = await paraATela(admin, e.orgId, [(enviado ?? contrato) as unknown as LinhaDoContrato]);
  return { ok: true, contrato: tela!, enviado: true };
}
