/**
 * POST /api/v1/leads/[id]/contracts/do-modelo — gera o contrato do negócio
 * pelo modelo aprovado (PC-030, itens 2 e 3). Corpo opcional: `{ modelo_id }`;
 * sem ele, vale o modelo do interesse do negócio. Nasce em `rascunho`, com o
 * modelo e a versão; quem envia é o "Enviar ao cliente" de sempre.
 *
 * Faltando dado, responde 422 `faltam_dados` com a lista do que perguntar
 * (campo, rótulo e frase) — a mesma resposta que a IA recebe.
 *
 * Rota de SESSÃO (`agent`+): fora de `lib/auth/public-paths.ts`.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { gerarContratoDoModelo } from "@/lib/contratos/gerar-do-modelo";
import { paraATela } from "@/lib/contratos/servidor";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const corpoSchema = z.object({ modelo_id: z.uuid().optional() }).strict();

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_contracts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id: leadId } = await ctx.params;
  if (!z.uuid().safeParse(leadId).success) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  const parsed = corpoSchema.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return fail("validation_failed", t("Modelo inválido."), 422, { requestId });

  const admin = createAdminClient();
  try {
    const r = await gerarContratoDoModelo(admin, {
      orgId: authz.org.orgId,
      leadId,
      modeloId: parsed.data.modelo_id ?? null,
      origem: "pessoa",
      actor: { type: "user", id: authz.user.id },
      userId: authz.user.id,
    });
    if (!r.ok) {
      if (r.codigo === "negocio_nao_encontrado") return fail("not_found", t(r.mensagem), 404, { requestId });
      return fail(r.codigo, t(r.mensagem), 422, {
        requestId,
        ...(r.codigo === "faltam_dados"
          ? { details: { faltas: r.faltas.map((f) => ({ campo: f.campo, motivo: f.motivo, rotulo: f.rotulo, frase: f.frase })) } }
          : {}),
      });
    }
    void audit({
      action: "contract.created",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "crm_contracts",
      resourceId: r.contrato.id,
      requestId,
      metadata: { lead_id: leadId, modelo_id: r.modelo.id, modelo_versao: r.modelo.versao, origem: "modelo" },
    });
    const [contrato] = await paraATela(admin, authz.org.orgId, [r.contrato]);
    return ok(contrato, { requestId, status: 201 });
  } catch (err) {
    logger.error("contracts.do_modelo_failed", {
      organizationId: authz.org.orgId,
      erro: err instanceof Error ? err.message.slice(0, 200) : "erro",
    });
    return fail("internal_error", t("Não consegui gerar o contrato agora. Tente de novo."), 500, { requestId });
  }
}
