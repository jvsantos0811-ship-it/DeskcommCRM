/**
 * GET  /api/v1/leads/[id]/contracts — os contratos de um negócio.
 * POST /api/v1/leads/[id]/contracts — anexa o PDF do contrato do escritório
 *      (multipart: `file`, `titulo` opcional). Nasce em `rascunho`.
 *
 * Fork, migration 9008 (item 7 do briefing de 26/10/2026). Rota de SESSÃO: não
 * está em `lib/auth/public-paths.ts`, então token de integração, ferramenta MCP
 * e agente de IA não chegam aqui — contrato é coisa de pessoa.
 *
 * Leitura: qualquer papel da organização. Escrita: `agent`+ ("qualquer
 * atendente", decisão do dono), e o suporte só-leitura não escreve.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { BUCKET_DOS_CONTRATOS, caminhoDoOriginal, pareceUmPdf } from "@/lib/contratos/arquivo";
import { COLUNAS_DO_CONTRATO, paraATela, type LinhaDoContrato } from "@/lib/contratos/servidor";
import { TAMANHO_MAXIMO_DO_CONTRATO } from "@/lib/contratos/vocabulario";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const idSchema = z.string().uuid();
const tituloSchema = z.string().trim().min(1).max(120);

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_contracts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  const { data, error } = await admin
    .from("crm_contracts")
    .select(COLUNAS_DO_CONTRATO)
    .eq("organization_id", authz.org.orgId)
    .eq("lead_id", id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return fail("internal_error", t("Não foi possível carregar os contratos."), 500, { requestId });

  return ok(await paraATela(admin, authz.org.orgId, (data ?? []) as unknown as LinhaDoContrato[]), { requestId });
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_contracts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id: leadId } = await ctx.params;
  if (!idSchema.safeParse(leadId).success) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  // Guarda de DoS: recusa pelo tamanho DECLARADO antes de ler o corpo inteiro.
  // 1 MB de folga para o envelope do multipart; a conferência que vale é o
  // `file.size` depois do parse (Content-Length pode mentir).
  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > TAMANHO_MAXIMO_DO_CONTRATO + 1_048_576) {
    return fail("payload_too_large", t("O contrato passa de 20 MB."), 413, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Escolha o arquivo PDF do contrato."), 422, { requestId });
  }
  if (file.size <= 0) return fail("validation_failed", t("O arquivo está vazio."), 422, { requestId });
  if (file.size > TAMANHO_MAXIMO_DO_CONTRATO) {
    return fail("payload_too_large", t("O contrato passa de 20 MB."), 413, { requestId });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!pareceUmPdf(bytes)) {
    return fail("unsupported_media_type", t("O contrato precisa ser um arquivo PDF."), 415, { requestId });
  }

  const nomeOriginal = (file.name || "contrato.pdf").slice(0, 200);
  const tituloBruto = form?.get("titulo");
  const tituloInformado = typeof tituloBruto === "string" && tituloBruto.trim() ? tituloBruto : null;
  const titulo = tituloSchema.safeParse(tituloInformado ?? nomeOriginal.replace(/\.pdf$/i, ""));
  if (!titulo.success) {
    return fail("validation_failed", t("Dê ao contrato um nome de até 120 caracteres."), 422, { requestId });
  }

  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("crm_leads")
    .select("id, contact_id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  // O id nasce aqui para o arquivo subir ANTES da linha: uma linha apontando
  // para um arquivo que não subiu seria um contrato que ninguém consegue abrir.
  const contratoId = randomUUID();
  const caminho = caminhoDoOriginal(authz.org.orgId, contratoId);
  const { error: upErr } = await admin.storage
    .from(BUCKET_DOS_CONTRATOS)
    .upload(caminho, Buffer.from(bytes), { contentType: "application/pdf", upsert: false });
  if (upErr) {
    logger.error("contracts.upload_failed", { organizationId: authz.org.orgId, erro: upErr.message });
    return fail("internal_error", t("Não foi possível guardar o arquivo. Tente de novo."), 500, { requestId });
  }

  const { data: criado, error: insErr } = await admin
    .from("crm_contracts")
    .insert({
      id: contratoId,
      organization_id: authz.org.orgId,
      lead_id: lead.id,
      contact_id: (lead as { contact_id: string | null }).contact_id,
      titulo: titulo.data,
      arquivo_path: caminho,
      arquivo_nome: nomeOriginal,
      arquivo_bytes: file.size,
      criado_por_user_id: authz.user.id,
    })
    .select(COLUNAS_DO_CONTRATO)
    .single();
  if (insErr || !criado) {
    // Sem linha, o arquivo é órfão: sai do bucket em vez de ocupar a cota.
    await admin.storage.from(BUCKET_DOS_CONTRATOS).remove([caminho]);
    logger.error("contracts.insert_failed", { organizationId: authz.org.orgId, erro: insErr?.message });
    return fail("internal_error", t("Não foi possível anexar o contrato. Tente de novo."), 500, { requestId });
  }

  await emitLeadActivity(admin, {
    organizationId: authz.org.orgId,
    leadId: lead.id,
    contactId: (lead as { contact_id: string | null }).contact_id,
    type: "contract_uploaded",
    sourceModule: "contracts",
    sourceId: contratoId,
    actor: { type: "user", id: authz.user.id },
    reason: "Contrato anexado ao negócio",
  });
  void audit({
    action: "contract.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "crm_contracts",
    resourceId: contratoId,
    requestId,
    metadata: { lead_id: lead.id, bytes: file.size },
  });

  const [contrato] = await paraATela(admin, authz.org.orgId, [criado as unknown as LinhaDoContrato]);
  return ok(contrato, { requestId, status: 201 });
}
