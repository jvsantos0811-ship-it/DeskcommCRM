/**
 * POST /api/v1/contracts/[id]/send — uma pessoa da equipe envia o contrato ao
 * cliente pelo WhatsApp. Corpo opcional: `{ mensagem }`, o texto que vai junto
 * com o arquivo. Aceita `Idempotency-Key` (o clique repetido não manda duas
 * vezes).
 *
 * Fork, migration 9008 (item 7 do briefing de 26/10/2026). Decisão do dono:
 * "por enquanto um humano envia o contrato" — rota de SESSÃO, `agent`+, fora de
 * `lib/auth/public-paths.ts`: nenhum agente de IA, ferramenta MCP ou token de
 * integração chega aqui.
 *
 * O caminho:
 *
 *   1. o contrato precisa estar em `rascunho` ou `enviado` (reenviar é pedir
 *      outra via, e o cliente pede);
 *   2. a conversa é a do contato do NEGÓCIO (a mais recente, fora de grupo);
 *   3. o provedor de assinatura prepara o documento — o `manual` não prepara
 *      nada; um serviço eletrônico devolveria o link, que vai na legenda;
 *   4. a cópia do PDF entra na pasta da conversa em `whatsapp-media`, com nome
 *      legível (`lib/contratos/arquivo.ts` explica por que ali);
 *   5. a mensagem sai pelo MESMO handler da Inbox, como envio de uma pessoa.
 *
 * O desfecho é decidido pelo status DEVOLVIDO pela mensagem, nunca pela
 * ausência de exceção (a lição da D3 das propostas): `failed` mantém o estado
 * de antes e grava o motivo no contrato, para a tela mostrar; `queued` (canal
 * fora do ar) já conta como enviado — a mensagem sai quando o canal voltar, e a
 * tela mostra "na fila" lendo a própria mensagem.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  BUCKET_DOS_CONTRATOS,
  caminhoDaCopiaNaConversa,
  nomeDoArquivoParaOCliente,
} from "@/lib/contratos/arquivo";
import { provedorDeAssinatura } from "@/lib/contratos/provedores";
import { COLUNAS_DO_CONTRATO, carregarContrato, paraATela, type LinhaDoContrato } from "@/lib/contratos/servidor";
import type { ContratoDoNegocio } from "@/lib/contratos/tipos";
import { podeEnviar } from "@/lib/contratos/vocabulario";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const ENDPOINT = "POST /api/v1/contracts/[id]/send";

const corpoSchema = z
  .object({
    mensagem: z.string().trim().max(1000).optional(),
  })
  .strict();

/** A recusa já como a resposta HTTP que ela vira — sai de dentro do efeito. */
class Recusa extends Error {
  constructor(public readonly resposta: Response) {
    super("recusa");
  }
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_contracts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const userId = authz.user.id;
  const idioma = authz.user.idioma;

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("not_found", t("Contrato não encontrado."), 404, { requestId });
  }

  const bruto = await req.json().catch(() => ({}));
  const corpo = corpoSchema.safeParse(bruto ?? {});
  if (!corpo.success) {
    return fail("validation_failed", t("A mensagem do envio tem até 1000 caracteres."), 422, {
      requestId,
      details: corpo.error.flatten(),
    });
  }

  const textoDoEnvio = corpo.data.mensagem ?? "";
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_failed", t("Idempotency-Key deve ser UUID."), 400, { requestId });
  }

  const admin = createAdminClient();

  async function enviar(): Promise<ContratoDoNegocio> {
    const contrato = await carregarContrato(admin, orgId, id);
    if (!contrato) throw new Recusa(fail("not_found", t("Contrato não encontrado."), 404, { requestId }));
    if (!podeEnviar(contrato.status)) {
      throw new Recusa(
        fail("invalid_state_transition", t("Este contrato já foi encerrado e não pode ser enviado."), 409, {
          requestId,
        }),
      );
    }
    if (!contrato.arquivo_path) {
      throw new Recusa(fail("validation_failed", t("O arquivo deste contrato não existe mais."), 422, { requestId }));
    }

    // O contato é o do NEGÓCIO de agora: se o card mudou de contato (cadastro
    // duplicado juntado), o contrato vai para quem o negócio é hoje.
    const { data: lead } = contrato.lead_id
      ? await admin
          .from("crm_leads")
          .select("id, contact_id")
          .eq("organization_id", orgId)
          .eq("id", contrato.lead_id)
          .maybeSingle()
      : { data: null };
    const contatoId = (lead as { contact_id: string | null } | null)?.contact_id ?? contrato.contact_id;
    if (!contatoId) {
      throw new Recusa(fail("validation_failed", t("Este negócio não tem contato para receber o contrato."), 422, { requestId }));
    }

    const { data: conversa } = await admin
      .from("conversations")
      .select("id, channel_session_id")
      .eq("organization_id", orgId)
      .eq("contact_id", contatoId)
      .eq("is_group", false)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!conversa) {
      throw new Recusa(
        fail("validation_failed", t("Este contato ainda não tem conversa no WhatsApp para receber o contrato."), 422, {
          requestId,
        }),
      );
    }
    const conversaId = (conversa as { id: string }).id;

    const provedor = provedorDeAssinatura(contrato.provedor_assinatura);
    const nomeDoArquivo = nomeDoArquivoParaOCliente(contrato.titulo);

    let mensagem: Awaited<ReturnType<typeof sendMessageHandler>>;
    let preparo: Awaited<ReturnType<typeof provedor.preparar>>;
    try {
      const { data: original, error: dlErr } = await admin.storage
        .from(BUCKET_DOS_CONTRATOS)
        .download(contrato.arquivo_path);
      if (dlErr || !original) throw new Error(t("Não foi possível ler o arquivo do contrato."));
      const pdf = Buffer.from(await original.arrayBuffer());

      preparo = await provedor.preparar({ organizationId: orgId, contratoId: contrato.id, pdf, nomeDoArquivo });

      const copia = caminhoDaCopiaNaConversa(orgId, conversaId, contrato.id, nomeDoArquivo);
      const { error: upErr } = await admin.storage
        .from("whatsapp-media")
        .upload(copia, pdf, { contentType: "application/pdf", upsert: true });
      if (upErr) throw new Error(t("Não foi possível preparar o arquivo para o WhatsApp."));

      const legenda = [textoDoEnvio, preparo.linkAssinatura ?? ""].filter((p) => p.trim()).join("\n\n");
      mensagem = await sendMessageHandler(
        admin,
        { organization_id: orgId, actor: { type: "user", id: userId }, requestId, idioma },
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
      const motivo = erro instanceof Error && erro.message ? erro.message : t("Falha desconhecida ao enviar.");
      logger.warn("contracts.send_failed", { organizationId: orgId, contratoId: contrato.id, erro: motivo });
      const { data: falhou } = await admin
        .from("crm_contracts")
        .update({ ultima_falha_envio: motivo })
        .eq("organization_id", orgId)
        .eq("id", contrato.id)
        .select(COLUNAS_DO_CONTRATO)
        .single();
      const [tela] = await paraATela(admin, orgId, [(falhou ?? contrato) as unknown as LinhaDoContrato]);
      return tela!;
    }

    if (mensagem.status === "failed") {
      const { data: falhou } = await admin
        .from("crm_contracts")
        .update({
          ultima_falha_envio: mensagem.error_message ?? t("O WhatsApp não aceitou o envio."),
          message_id: mensagem.id,
          conversation_id: conversaId,
          contact_id: contatoId,
        })
        .eq("organization_id", orgId)
        .eq("id", contrato.id)
        .select(COLUNAS_DO_CONTRATO)
        .single();
      const [tela] = await paraATela(admin, orgId, [(falhou ?? contrato) as unknown as LinhaDoContrato]);
      return tela!;
    }

    const reenvio = contrato.status === "enviado";
    const { data: enviado } = await admin
      .from("crm_contracts")
      .update({
        status: "enviado",
        enviado_em: new Date().toISOString(),
        enviado_por_user_id: userId,
        message_id: mensagem.id,
        conversation_id: conversaId,
        contact_id: contatoId,
        ultima_falha_envio: null,
        provedor_documento_id: preparo.documentoId,
        link_assinatura: preparo.linkAssinatura,
      })
      .eq("organization_id", orgId)
      .eq("id", contrato.id)
      .select(COLUNAS_DO_CONTRATO)
      .single();

    if (contrato.lead_id) {
      await emitLeadActivity(admin, {
        organizationId: orgId,
        leadId: contrato.lead_id,
        contactId: contatoId,
        type: "contract_sent",
        sourceModule: "contracts",
        sourceId: contrato.id,
        actor: { type: "user", id: userId },
        reason: reenvio
          ? "Contrato enviado de novo ao cliente pelo WhatsApp"
          : "Contrato enviado ao cliente pelo WhatsApp, aguardando assinatura",
      });
    }
    void audit({
      action: "contract.sent",
      actorUserId: userId,
      organizationId: orgId,
      resourceType: "crm_contracts",
      resourceId: contrato.id,
      requestId,
      metadata: {
        lead_id: contrato.lead_id,
        message_id: mensagem.id,
        entrega: mensagem.status,
        reenvio,
        provedor: provedor.id,
      },
    });

    const [tela] = await paraATela(admin, orgId, [(enviado ?? contrato) as unknown as LinhaDoContrato]);
    return tela!;
  }

  try {
    if (chave === null) return ok(await enviar(), { requestId });

    const supabase = await createClient();
    const desfecho = await comIdempotencia({
      db: supabase,
      organizationId: orgId,
      endpoint: ENDPOINT,
      chave,
      corpo: { contrato_id: id, ...corpo.data },
      executar: async () => ({ resposta: await enviar(), status: 200 }),
    });
    if (desfecho.tipo === "conflito") {
      return fail("idempotency_conflict", t("Esta chave de idempotência já foi usada com outro conteúdo."), 409, {
        requestId,
      });
    }
    if (desfecho.tipo === "em_curso") {
      return fail("idempotency_in_progress", t("O envio deste contrato ainda está em curso. Aguarde um instante."), 409, {
        requestId,
      });
    }
    return ok(desfecho.resposta, { requestId });
  } catch (erro) {
    if (erro instanceof Recusa) return erro.resposta;
    logger.error("contracts.send_unexpected", {
      organizationId: orgId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return fail("internal_error", t("Não foi possível enviar o contrato agora."), 500, { requestId });
  }
}
