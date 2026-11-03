/**
 * GET   /api/v1/settings/conversa — as regras da IA na conversa (Configurações › IA).
 * PATCH /api/v1/settings/conversa — grava (manager+).
 *
 * Pacote Conversa. Mora em `organizations.settings.conversa`:
 *  - `repeticao` (PC-018): a trava de repetição entre respostas e no follow-up —
 *    ligada, janela (mensagens/horas) e os limiares de texto e de pergunta.
 *    Ausente = ligada com o padrão (`AJUSTES_PADRAO_DE_REPETICAO`).
 *
 * Mesma forma de `settings/frase-segura`: merge NÃO destrutivo do jsonb, e a
 * leitura que falhou PARA a gravação (tratá-la como `{}` regravaria o settings
 * inteiro só com esta chave).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  AJUSTES_PADRAO_DE_REPETICAO,
  ajustesDeRepeticaoSchema,
  ajustesParaGravar,
  lerAjustesDeRepeticao,
} from "@/lib/agent-engine/agent/repeticao-entre-respostas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const entradaSchema = z.strictObject({
  repeticao: ajustesDeRepeticaoSchema.optional(),
});

async function lerSettings(orgId: string) {
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (error) return { error };
  return { settings: ((data as { settings?: Record<string, unknown> | null } | null)?.settings ?? {}) as Record<string, unknown> };
}

function resposta(settings: Record<string, unknown>) {
  return {
    repeticao: ajustesParaGravar(lerAjustesDeRepeticao(settings)),
    padrao: { repeticao: ajustesParaGravar({ ...AJUSTES_PADRAO_DE_REPETICAO }) },
  };
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_settings" });
  if (!authz.ok) return authz.response;
  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });
  return ok(resposta(lido.settings), { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_settings" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = entradaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });

  const conversaAtual = (lido.settings.conversa ?? {}) as Record<string, unknown>;
  const conversa = {
    ...conversaAtual,
    ...(parsed.data.repeticao !== undefined ? { repeticao: parsed.data.repeticao } : {}),
  };
  const settings = { ...lido.settings, conversa };

  // Cliente admin: a RLS de `organizations` só deixa platform admin escrever.
  const { error } = await createAdminClient()
    .from("organizations")
    .update({ settings })
    .eq("id", authz.org.orgId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "settings.conversa_atualizada",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { chaves: Object.keys(parsed.data) },
  });

  return ok(resposta(settings), { requestId });
}
