/**
 * POST /api/v1/contracts/[id]/decide — uma pessoa da equipe marca o desfecho.
 *
 * Multipart: `desfecho` (`assinado` | `recusado` | `cancelado`), `motivo`
 * opcional (até 500 caracteres) e, só em `assinado`, `file` opcional com a via
 * assinada em PDF.
 *
 * Fork, migration 9008. Assinar e recusar pedem que o contrato tenha SAÍDO;
 * cancelar vale para o que ainda não terminou. Os três são finais — um contrato
 * novo é outro arquivo, e reabrir apagaria a história do que o cliente recebeu.
 * Rota de SESSÃO, `agent`+.
 *
 * Quando o contrato for de um serviço de assinatura eletrônica
 * (`desfechoPorPessoa = false`), assinado/recusado chegam pelo webhook do
 * serviço e esta rota recusa — só o cancelamento continua aqui.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { BUCKET_DOS_CONTRATOS, caminhoDoAssinado, pareceUmPdf } from "@/lib/contratos/arquivo";
import { provedorDeAssinatura } from "@/lib/contratos/provedores";
import { COLUNAS_DO_CONTRATO, carregarContrato, paraATela, type LinhaDoContrato } from "@/lib/contratos/servidor";
import {
  DESFECHOS_DO_CONTRATO,
  podeDecidir,
  TAMANHO_MAXIMO_DO_CONTRATO,
  type DesfechoDoContrato,
} from "@/lib/contratos/vocabulario";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import type { ActivityType } from "@/lib/leads/activity-vocabulary";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const camposSchema = z.object({
  desfecho: z.enum(DESFECHOS_DO_CONTRATO),
  motivo: z.string().trim().max(500).optional(),
});

const ATIVIDADE: Record<DesfechoDoContrato, { tipo: ActivityType; razao: string }> = {
  assinado: { tipo: "contract_signed", razao: "Contrato marcado como assinado pela equipe" },
  recusado: { tipo: "contract_declined", razao: "Contrato marcado como recusado pela equipe" },
  cancelado: { tipo: "contract_cancelled", razao: "Contrato cancelado pela equipe" },
};

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_contracts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("not_found", t("Contrato não encontrado."), 404, { requestId });
  }

  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > TAMANHO_MAXIMO_DO_CONTRATO + 1_048_576) {
    return fail("payload_too_large", t("O contrato passa de 20 MB."), 413, { requestId });
  }
  const form = await req.formData().catch(() => null);
  const motivoBruto = form?.get("motivo");
  const campos = camposSchema.safeParse({
    desfecho: form?.get("desfecho"),
    motivo: typeof motivoBruto === "string" && motivoBruto.trim() ? motivoBruto : undefined,
  });
  if (!campos.success) {
    return fail("validation_failed", t("Escolha assinado, recusado ou cancelado (motivo com até 500 caracteres)."), 422, {
      requestId,
      details: campos.error.flatten(),
    });
  }
  const { desfecho, motivo } = campos.data;

  const arquivo = form?.get("file");
  const viaAssinada = arquivo instanceof File && arquivo.size > 0 ? arquivo : null;
  if (viaAssinada && desfecho !== "assinado") {
    return fail("validation_failed", t("Só o contrato assinado leva arquivo."), 422, { requestId });
  }
  if (viaAssinada && viaAssinada.size > TAMANHO_MAXIMO_DO_CONTRATO) {
    return fail("payload_too_large", t("O contrato passa de 20 MB."), 413, { requestId });
  }
  const bytes = viaAssinada ? new Uint8Array(await viaAssinada.arrayBuffer()) : null;
  if (bytes && !pareceUmPdf(bytes)) {
    return fail("unsupported_media_type", t("A via assinada precisa ser um arquivo PDF."), 415, { requestId });
  }

  const admin = createAdminClient();
  const contrato = await carregarContrato(admin, orgId, id);
  if (!contrato) return fail("not_found", t("Contrato não encontrado."), 404, { requestId });

  if (!podeDecidir(contrato.status, desfecho)) {
    return fail(
      "invalid_state_transition",
      desfecho === "cancelado"
        ? t("Este contrato já foi encerrado.")
        : t("Só dá para marcar assinado ou recusado depois de enviar o contrato ao cliente."),
      409,
      { requestId },
    );
  }
  if (desfecho !== "cancelado" && !provedorDeAssinatura(contrato.provedor_assinatura).desfechoPorPessoa) {
    return fail("invalid_state_transition", t("O desfecho deste contrato chega pelo serviço de assinatura."), 409, {
      requestId,
    });
  }

  let assinadoPath: string | null = contrato.assinado_path;
  if (bytes) {
    assinadoPath = caminhoDoAssinado(orgId, contrato.id);
    const { error: upErr } = await admin.storage
      .from(BUCKET_DOS_CONTRATOS)
      .upload(assinadoPath, Buffer.from(bytes), { contentType: "application/pdf", upsert: true });
    if (upErr) {
      logger.error("contracts.signed_upload_failed", { organizationId: orgId, erro: upErr.message });
      return fail("internal_error", t("Não foi possível guardar a via assinada. Tente de novo."), 500, { requestId });
    }
  }

  // A transição é condicionada ao status LIDO: duas pessoas decidindo ao mesmo
  // tempo não se sobrescrevem — a segunda recebe 409 em vez de apagar a primeira.
  const { data: decidido } = await admin
    .from("crm_contracts")
    .update({
      status: desfecho,
      decidido_em: new Date().toISOString(),
      decidido_por_user_id: authz.user.id,
      motivo: motivo ?? null,
      assinado_path: assinadoPath,
    })
    .eq("organization_id", orgId)
    .eq("id", contrato.id)
    .eq("status", contrato.status)
    .select(COLUNAS_DO_CONTRATO)
    .maybeSingle();
  if (!decidido) {
    return fail("invalid_state_transition", t("Alguém já mudou este contrato. Recarregue para ver como ele está."), 409, {
      requestId,
    });
  }

  if (contrato.lead_id) {
    await emitLeadActivity(admin, {
      organizationId: orgId,
      leadId: contrato.lead_id,
      contactId: contrato.contact_id,
      type: ATIVIDADE[desfecho].tipo,
      sourceModule: "contracts",
      sourceId: contrato.id,
      actor: { type: "user", id: authz.user.id },
      reason: ATIVIDADE[desfecho].razao,
    });
  }
  void audit({
    action: "contract.decided",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "crm_contracts",
    resourceId: contrato.id,
    requestId,
    metadata: { lead_id: contrato.lead_id, de: contrato.status, para: desfecho, via_assinada: !!bytes },
  });

  const [tela] = await paraATela(admin, orgId, [decidido as unknown as LinhaDoContrato]);
  return ok(tela, { requestId });
}
