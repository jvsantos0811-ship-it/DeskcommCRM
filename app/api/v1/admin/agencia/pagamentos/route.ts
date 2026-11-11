/**
 * POST /api/v1/admin/agencia/pagamentos — lança um pagamento à mão no painel
 * da agência (PC-028): data, valor, forma e observação, com quem lançou.
 *
 * Só se acrescenta (não há editar nem apagar pela tela: o histórico é a prova).
 * Mensalidade paga empurra o próximo vencimento um mês (quando ele está
 * cadastrado e o pagamento cobre o vencimento atual); implantação marca a
 * implantação como paga. Não cobra ninguém. Auditoria `agencia.pagamento_lancado`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { limparCacheDaAgencia } from "@/lib/agencia/ler";
import { umMesDepois } from "@/lib/agencia/painel";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  organization_id: z.string().uuid(),
  tipo: z.enum(["mensalidade", "implantacao", "outro"]).default("mensalidade"),
  pago_em: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valor_cents: z.number().int().min(1).max(1e10),
  forma: z.enum(["pix", "boleto", "cartao", "transferencia", "dinheiro", "outro"]),
  observacao: z.string().trim().max(500).nullable().optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdminEscrita>>;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success)
    return fail("validation_failed", "Pagamento inválido", 400, {
      requestId,
      details: corpo.error.flatten(),
    });
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agencia_pagamentos")
    .insert({
      organization_id: corpo.data.organization_id,
      tipo: corpo.data.tipo,
      pago_em: corpo.data.pago_em,
      valor_cents: corpo.data.valor_cents,
      forma: corpo.data.forma,
      observacao: corpo.data.observacao ?? null,
      lancado_por: adminCtx.user.id,
    })
    .select("*")
    .single();
  if (error || !data)
    return fail("internal_error", "Não foi possível lançar o pagamento", 500, { requestId });

  const { data: cadastro } = await admin
    .from("agencia_clientes")
    .select("proximo_vencimento, implantacao_paga")
    .eq("organization_id", corpo.data.organization_id)
    .maybeSingle();
  const c = cadastro as { proximo_vencimento: string | null; implantacao_paga: boolean } | null;
  if (corpo.data.tipo === "mensalidade" && c?.proximo_vencimento) {
    await admin
      .from("agencia_clientes")
      .update({
        proximo_vencimento: umMesDepois(c.proximo_vencimento),
        updated_by: adminCtx.user.id,
      })
      .eq("organization_id", corpo.data.organization_id);
  } else if (corpo.data.tipo === "implantacao") {
    await admin.from("agencia_clientes").upsert(
      {
        organization_id: corpo.data.organization_id,
        implantacao_paga: true,
        updated_by: adminCtx.user.id,
      },
      { onConflict: "organization_id" },
    );
  }
  limparCacheDaAgencia();
  void audit({
    action: "agencia.pagamento_lancado",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: corpo.data.organization_id,
    resourceType: "agencia_pagamento",
    resourceId: (data as { id: string }).id,
    requestId,
    metadata: corpo.data,
  });
  return ok(data, { status: 201, requestId });
}
