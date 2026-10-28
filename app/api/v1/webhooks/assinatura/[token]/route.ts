/**
 * POST /api/v1/webhooks/assinatura/:token — o aviso `contrato.assinado` de um
 * provedor de assinatura eletrônica (PC-003, item 3 (a)).
 *
 * NENHUM provedor está ligado ainda: esta é a porta e a validação, prontas para
 * o dia em que o escritório escolher um (ZapSign, Clicksign…). O provedor manda:
 *
 *   POST /api/v1/webhooks/assinatura/<token-da-organização>
 *   x-assinatura-segredo: <segredo da organização>
 *   { "evento": "contrato.assinado", "lead_id": "<uuid>",
 *     "data_assinatura": "AAAA-MM-DD", "provedor": "zapsign", "documento_id": "..." }
 *
 * A organização sai do TOKEN do caminho (nunca do corpo), e o segredo é
 * conferido contra o hash SHA-256 gravado (`assinatura_webhook_chaves`) em
 * tempo constante. Segredo errado, token desconhecido, negócio de outra
 * organização ou evento desconhecido: NADA muda, e a recusa fica registrada
 * (`recusas_da_ia`, tipo `assinatura_recusada`) quando a organização é
 * conhecida. Válido: o MESMO efeito do botão "Assinatura confirmada" da equipe,
 * com origem "provedor".
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { confirmarAssinatura, dataDeAssinaturaValida } from "@/lib/leads/assinatura-confirmada";
import { registrarRecusaPeloSupabase } from "@/lib/leads/trava-da-ia";
import { HEADER_SEGREDO_DA_ASSINATURA, segredoConfere } from "@/lib/leads/assinatura-webhook";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  evento: z.literal("contrato.assinado"),
  lead_id: z.string().uuid(),
  data_assinatura: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  provedor: z.string().trim().min(1).max(60).optional(),
  documento_id: z.string().trim().min(1).max(200).optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    return fail("not_found", "Not found.", 404, { requestId });
  }

  const rl = await checkRateLimit(`webhook_assinatura:${token}`, 60, 60);
  if (!rl.allowed) {
    return fail("rate_limited", "Too many requests.", 429, { requestId, headers: { "Retry-After": "60" } });
  }

  const admin = createAdminClient();
  const { data: chave } = await admin
    .from("assinatura_webhook_chaves")
    .select("organization_id, segredo_sha256, ativo")
    .eq("path_token", token)
    .maybeSingle();
  const c = chave as { organization_id: string; segredo_sha256: string; ativo: boolean } | null;
  if (!c || !c.ativo) return fail("not_found", "Not found.", 404, { requestId });

  const recusar = async (codigo: string, motivo: string, status: number, leadId?: string | null) => {
    await registrarRecusaPeloSupabase(admin, {
      organizationId: c.organization_id,
      tipo: "assinatura_recusada",
      ferramenta: "webhook_assinatura",
      codigo,
      ...(leadId ? { leadId } : {}),
      motivo,
    });
    return fail(codigo, motivo, status, { requestId });
  };

  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_DA_ASSINATURA), c.segredo_sha256)) {
    return recusar("segredo_invalido", "Aviso de assinatura com segredo inválido: ignorado.", 401);
  }

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return recusar("payload_invalido", "Aviso de assinatura com formato inválido: ignorado.", 422);
  }
  const corpo = parsed.data;

  // O negócio tem de ser DESTA organização — a do token. Um id de outra
  // organização é ignorado e registrado, nunca aplicado.
  const { data: lead } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", c.organization_id)
    .eq("id", corpo.lead_id)
    .maybeSingle();
  if (!lead) {
    return recusar("negocio_de_outra_organizacao", "Aviso de assinatura para um negócio que não é desta organização: ignorado.", 404);
  }

  const data = corpo.data_assinatura ?? new Date().toISOString().slice(0, 10);
  if (!dataDeAssinaturaValida(data)) {
    return recusar("data_invalida", "Aviso de assinatura com data inválida ou no futuro: ignorado.", 422, corpo.lead_id);
  }

  try {
    const r = await confirmarAssinatura(
      admin,
      {
        organization_id: c.organization_id,
        actor: { type: "webhook_source", id: "assinatura" },
        requestId,
      },
      {
        leadId: corpo.lead_id,
        dataAssinatura: data,
        origem: "provedor",
        registradoPorUserId: null,
        provedor: corpo.provedor ?? null,
        documentoId: corpo.documento_id ?? null,
      },
    );
    void audit({
      action: "lead.signature_confirmed",
      actorUserId: null,
      organizationId: c.organization_id,
      resourceType: "crm_lead",
      resourceId: corpo.lead_id,
      requestId,
      metadata: { origem: "provedor", data_assinatura: data, provedor: corpo.provedor ?? null, ja_estava: r.jaEstava },
    });
    return ok({ aplicado: true, ja_estava: r.jaEstava }, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      // Ex.: o funil exige campo no ganho. Nada mudou; a equipe vê na aba.
      return recusar(err.code, `Assinatura recebida, mas o negócio não fechou: ${err.message}`, err.status, corpo.lead_id);
    }
    throw err;
  }
}
