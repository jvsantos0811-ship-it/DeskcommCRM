/**
 * PUT /api/v1/admin/bateria-do-leitor/padrao — o MODELO PADRÃO do Leitor da
 * conversa, da instalação (PM-027; decisão do dono de 06/11: "o Leitor deve
 * ligar nas organizações que já existem e ligar sozinho nas próximas e nas
 * novas"). Só o dono da plataforma, com escrita.
 *
 * Corpo: `{ modelo, reserva }`. Só modelos APROVADOS na bateria (a mesma régua do
 * cartão da empresa: 100% nos casos que bloqueiam; reserva diferente do
 * principal). `modelo: null` tira o padrão: quem o seguia para de ler.
 *
 * Quando o padrão passa a valer (não havia e agora há), toda organização que o
 * segue começa a ler AGORA (`ativo_desde`; nada antes é lido — sem carga
 * inicial, §3), e cada uma fica registrada na auditoria
 * (`leitor.ligado_pelo_padrao`, com o `ligado_em`). Trocar o modelo não relê
 * nada: só as leituras seguintes usam o novo. A escolha do padrão é registrada
 * como `leitor.padrao_definido` (antes e depois).
 */
import { requireSupportWrite } from "@/lib/impersonate/support";

import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { ultimaRodadaPorModelo } from "@/lib/dados/leitor/bateria-admin";
import { gravarPadraoDoLeitor, organizacoesQueSeguemOPadrao, recusaDoPadrao, type RecusaDoPadrao } from "@/lib/dados/leitor/padrao";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const modelo = z.object({ provider: z.string().trim().min(1).max(40), model_id: z.string().trim().min(1).max(120) });
const corpoSchema = z.strictObject({
  modelo: modelo.nullable(),
  reserva: modelo.nullable().optional(),
});

const MENSAGEM: Record<RecusaDoPadrao, string> = {
  modelo_nao_aprovado: "Este modelo não acertou 100% da bateria e não pode ser o padrão.",
  reserva_igual: "A reserva precisa ser um modelo diferente do principal.",
  reserva_nao_aprovada: "O modelo de reserva também precisa ter acertado 100% da bateria.",
};

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Invalid request body", 400, { requestId });
  const escolha = { modelo: parsed.data.modelo, reserva: parsed.data.modelo ? (parsed.data.reserva ?? null) : null };

  const admin = createAdminClient();
  try {
    if (escolha.modelo) {
      const recusa = recusaDoPadrao(await ultimaRodadaPorModelo(admin), escolha.modelo, escolha.reserva);
      if (recusa) return fail("validation_failed", MENSAGEM[recusa], 422, { requestId, details: { codigo: recusa } });
    }
    const agora = new Date();
    const { antes, depois } = await gravarPadraoDoLeitor(admin, escolha, agora, adminCtx.user.id);
    await audit({
      action: "leitor.padrao_definido",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: null,
      resourceType: "platform_config",
      requestId,
      metadata: {
        antes: antes ? { modelo: antes.modelo, reserva: antes.reserva, ativo_desde: antes.ativo_desde } : null,
        depois: depois ? { modelo: depois.modelo, reserva: depois.reserva, ativo_desde: depois.ativo_desde } : null,
      },
    });

    // O padrão PASSOU A VALER agora: cada organização que o segue começa a ler daqui.
    let passaramALer = 0;
    if (!antes && depois) {
      const seguem = await organizacoesQueSeguemOPadrao(admin, depois);
      passaramALer = seguem.length;
      for (const o of seguem) {
        await audit({
          action: "leitor.ligado_pelo_padrao",
          actorUserId: adminCtx.user.id,
          actingAsPlatformAdmin: true,
          bypassedRls: true,
          organizationId: o.id,
          resourceType: "organization",
          resourceId: o.id,
          requestId,
          metadata: { ligado_em: o.ligado_em, modelo: depois.modelo, reserva: depois.reserva, quando: "padrao_definido" },
        });
      }
    }
    return ok({ padrao: depois, passaramALer }, { requestId });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "Write failed", 500, { requestId });
  }
}
