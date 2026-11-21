"use server";

/**
 * GRAVAR O MODELO DO EVENTO NA AGENDA (PC-044) — título com campos e nível da
 * descrição do compromisso no calendário. `null` apaga o modelo e a empresa
 * volta ao comportamento de sempre.
 *
 * Mesmo molde de `definirMeetAberto` (0648): client DA SESSÃO, porque é o
 * `auth.uid()` que faz `fn_definir_modelo_do_evento_agenda` reconferir papel,
 * suporte e MFA. O `organization_id` vem de `resolveActiveOrg`, nunca de
 * argumento.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { modeloDoEventoSchema, type ModeloDoEvento } from "@/lib/agenda/modelo-do-evento";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

const resultadoSchema = z.object({
  modelo: modeloDoEventoSchema.nullable(),
  mudou: z.boolean(),
});

export type ErroModeloDoEvento =
  | "invalido"
  | "sessao"
  | "somente_leitura"
  | "sem_empresa"
  | "sem_permissao"
  | "mfa"
  | "tente_de_novo"
  | "falha";

export type RespostaModeloDoEvento =
  | { ok: true; modelo: ModeloDoEvento | null; mudou: boolean }
  | { ok: false; erro: ErroModeloDoEvento };

export async function definirModeloDoEventoDaAgenda(
  modelo: ModeloDoEvento | null,
): Promise<RespostaModeloDoEvento> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = modeloDoEventoSchema.nullable().safeParse(modelo);
  if (!entrada.success) return { ok: false, erro: "invalido" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "sessao" };
  if (supportWriteError(user.support)) return { ok: false, erro: "somente_leitura" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "sem_empresa" };
  if (ROLE_RANK[org.role] < ROLE_RANK.manager) return { ok: false, erro: "sem_permissao" };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_definir_modelo_do_evento_agenda", {
    p_org: org.orgId,
    p_modelo: entrada.data,
  });

  if (error) {
    if (error.code === "42501") {
      return { ok: false, erro: error.message.includes("mfa_required") ? "mfa" : "sem_permissao" };
    }
    if (error.code === "22023") return { ok: false, erro: "invalido" };
    if (error.code === "55P03" || error.code === "40P01" || error.code === "40001") {
      return { ok: false, erro: "tente_de_novo" };
    }
    logger.error("[modelo-do-evento] a RPC falhou", {
      organization_id: org.orgId,
      code: error.code,
      error: error.message,
    });
    return { ok: false, erro: "falha" };
  }

  const resultado = resultadoSchema.safeParse(data);
  if (!resultado.success) {
    logger.error("[modelo-do-evento] a RPC devolveu um corpo inesperado", {
      organization_id: org.orgId,
    });
    return { ok: false, erro: "falha" };
  }

  if (resultado.data.mudou) {
    await audit({
      action: "agenda.modelo_do_evento_alterado",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "organization",
      resourceId: org.orgId,
      metadata: resultado.data,
    });
  }

  revalidatePath("/app", "layout");
  return { ok: true, ...resultado.data };
}
