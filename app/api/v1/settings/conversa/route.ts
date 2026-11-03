/**
 * GET   /api/v1/settings/conversa — as regras da IA na conversa (Configurações › IA).
 * PATCH /api/v1/settings/conversa — grava (manager+).
 *
 * Pacote Conversa. Mora em `organizations.settings.conversa`:
 *  - `repeticao` (PC-018): a trava de repetição entre respostas e no follow-up —
 *    ligada, janela (mensagens/horas) e os limiares de texto e de pergunta.
 *    Ausente = ligada com o padrão (`AJUSTES_PADRAO_DE_REPETICAO`).
 *  - `frases_proibidas` (PC-022): a lista de frases barradas antes de a
 *    mensagem da IA sair. Ausente = a lista padrão (`FRASES_PADRAO`). Só o
 *    ADMIN edita a lista (manager vê). O GET traz também a contagem das últimas
 *    4 semanas por frase (`frases_proibidas_na_semana`).
 *  - `sem_fonte` (PC-020): a conferência "sem fonte, não afirma" — `decidindo`
 *    (padrão: veta e o modelo reescreve), `observando` (só registra) ou
 *    `desligada`.
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
import {
  FRASES_PADRAO,
  frasesProibidasSchema,
  lerFrasesProibidas,
} from "@/lib/agent-engine/agent/frases-proibidas";
import { roleAtLeast } from "@/lib/auth/types";
import {
  ajustesSemFonteSchema,
  ESTADO_PADRAO_SEM_FONTE,
  lerEstadoSemFonte,
} from "@/lib/agent-engine/guardrails/sem-fonte";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const entradaSchema = z.strictObject({
  repeticao: ajustesDeRepeticaoSchema.optional(),
  frases_proibidas: frasesProibidasSchema.optional(),
  sem_fonte: ajustesSemFonteSchema.optional(),
});

interface ContagemDaFrase {
  frase: string;
  semana: string;
  barradas: number;
  removidas: number;
  enviadas: number;
}

/** As últimas 4 semanas de contagem por frase (a tela mostra a semana atual e as anteriores). */
async function lerContagem(orgId: string): Promise<ContagemDaFrase[]> {
  const desde = new Date(Date.now() - 28 * 24 * 3600_000).toISOString().slice(0, 10);
  const { data } = await createAdminClient()
    .from("frases_proibidas_na_semana")
    .select("frase, semana, barradas, removidas, enviadas")
    .eq("organization_id", orgId)
    .gte("semana", desde)
    .order("semana", { ascending: false })
    .limit(400);
  return (data ?? []) as ContagemDaFrase[];
}

async function lerSettings(orgId: string) {
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (error) return { error };
  return { settings: ((data as { settings?: Record<string, unknown> | null } | null)?.settings ?? {}) as Record<string, unknown> };
}

function resposta(settings: Record<string, unknown>, contagem: ContagemDaFrase[]) {
  return {
    repeticao: ajustesParaGravar(lerAjustesDeRepeticao(settings)),
    frases_proibidas: { lista: lerFrasesProibidas(settings) },
    sem_fonte: { estado: lerEstadoSemFonte(settings) },
    contagem_das_frases: contagem,
    padrao: {
      sem_fonte: { estado: ESTADO_PADRAO_SEM_FONTE },
      repeticao: ajustesParaGravar({ ...AJUSTES_PADRAO_DE_REPETICAO }),
      frases_proibidas: { lista: [...FRASES_PADRAO] },
    },
  };
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_settings" });
  if (!authz.ok) return authz.response;
  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });
  return ok(resposta(lido.settings, await lerContagem(authz.org.orgId)), { requestId });
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

  // A lista de frases é decisão de quem administra a empresa (PC-022). Escopo
  // sobre o papel que o `requireRole` acima já resolveu (com o portão de MFA).
  if (parsed.data.frases_proibidas !== undefined && !roleAtLeast(authz.org.role, "admin")) {
    return fail("forbidden", t("Só o administrador da empresa muda as frases proibidas."), 403, { requestId });
  }

  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });

  const conversaAtual = (lido.settings.conversa ?? {}) as Record<string, unknown>;
  const conversa = {
    ...conversaAtual,
    ...(parsed.data.repeticao !== undefined ? { repeticao: parsed.data.repeticao } : {}),
    ...(parsed.data.frases_proibidas !== undefined ? { frases_proibidas: parsed.data.frases_proibidas } : {}),
    ...(parsed.data.sem_fonte !== undefined ? { sem_fonte: parsed.data.sem_fonte } : {}),
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

  return ok(resposta(settings, await lerContagem(authz.org.orgId)), { requestId });
}
