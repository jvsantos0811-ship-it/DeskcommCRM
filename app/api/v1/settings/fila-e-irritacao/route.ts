/**
 * GET   /api/v1/settings/fila-e-irritacao — frase da fila vazia + ação da irritação (PC-002b, itens 6 e 7).
 * PATCH /api/v1/settings/fila-e-irritacao — grava (manager+).
 *
 * - `frase_da_fila` (`organizations.settings.frase_da_fila`): o que o lead
 *   ouve quando a IA o passa para a equipe e ninguém pode assumir agora. Vazio
 *   = a frase padrão do aviso. Regra em `lib/escalacao/aviso-ao-lead.ts`.
 * - `irritacao` (`organizations.settings.irritacao`): "anotar" (padrão) só
 *   registra no histórico; "passar" passa para a equipe. Regra em
 *   `lib/escalacao/irritacao.ts`.
 *
 * Mesma forma de `settings/frase-segura`: merge NÃO destrutivo do jsonb, e
 * leitura que falhou PARA a gravação.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { fraseDaFilaDaOrg } from "@/lib/escalacao/aviso-ao-lead";
import { acaoDaIrritacao, filaEIrritacaoEntradaSchema } from "@/lib/escalacao/irritacao";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function lerSettings(orgId: string) {
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (error) return { error };
  const linha = data as { settings?: Record<string, unknown> | null } | null;
  return { settings: (linha?.settings ?? {}) as Record<string, unknown> };
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "queue_and_irritation" });
  if (!authz.ok) return authz.response;

  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });
  return ok(
    { frase_da_fila: fraseDaFilaDaOrg(lido.settings) ?? "", irritacao: acaoDaIrritacao(lido.settings) },
    { requestId },
  );
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "queue_and_irritation" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = filaEIrritacaoEntradaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { frase_da_fila, irritacao } = parsed.data;

  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });

  // Vazio / padrão apagam a chave: vale o comportamento de fábrica.
  const { frase_da_fila: _f, irritacao: _i, ...resto } = lido.settings;
  const settings: Record<string, unknown> = { ...resto };
  if (frase_da_fila !== "") settings.frase_da_fila = frase_da_fila;
  if (irritacao === "passar") settings.irritacao = "passar";

  const { error } = await createAdminClient()
    .from("organizations")
    .update({ settings })
    .eq("id", authz.org.orgId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "settings.queue_and_irritation_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { frase_da_fila_personalizada: frase_da_fila !== "", irritacao },
  });

  return ok({ frase_da_fila, irritacao }, { requestId });
}
