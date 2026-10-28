/**
 * POST /api/v1/leads/:id/assinatura-confirmada (manager+) — PC-003, item 3 (b).
 *
 * Uma pessoa com papel GERENTE registra que o contrato foi assinado, com a data.
 * Efeito (em `lib/leads/assinatura-confirmada.ts`): o negócio vai para a etapa
 * de ganho, ganha a tag `contrato-assinado`, e a assinatura fica registrada com
 * a data e quem registrou. A IA não tem como chegar aqui: é rota de sessão com
 * papel gerente, sem ferramenta MCP correspondente.
 *
 * O botão "Ganhar" de sempre continua existindo para quem já o usa — o pedido
 * manda não mudar o comportamento de pessoas na tela.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { confirmarAssinatura, dataDeAssinaturaValida } from "@/lib/leads/assinatura-confirmada";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corpoSchema = z
  .object({
    data_assinatura: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;
  if (!UUID_RX.test(leadId)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("manager", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !dataDeAssinaturaValida(parsed.data.data_assinatura)) {
    return fail("validation_failed", t("Informe a data da assinatura (não pode ser no futuro)."), 422, {
      requestId,
    });
  }

  try {
    const r = await confirmarAssinatura(
      createAdminClient(),
      {
        organization_id: authz.org.orgId,
        actor: { type: "user", id: authz.user.id },
        requestId,
        idioma: authz.user.idioma,
      },
      {
        leadId,
        dataAssinatura: parsed.data.data_assinatura,
        origem: "pessoa",
        registradoPorUserId: authz.user.id,
      },
    );
    void audit({
      action: "lead.signature_confirmed",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "crm_lead",
      resourceId: leadId,
      requestId,
      metadata: { origem: "pessoa", data_assinatura: parsed.data.data_assinatura, ja_estava: r.jaEstava },
    });
    return ok(r.lead, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
