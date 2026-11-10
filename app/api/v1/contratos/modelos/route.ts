/**
 * GET  /api/v1/contratos/modelos — os modelos de contrato da organização
 *      (qualquer papel: o card mostra "Gerar pelo modelo").
 * POST /api/v1/contratos/modelos — cria um modelo (gerente ou dono). Nasce SEM
 *      aprovação: a IA e o card só usam depois que o advogado aprova.
 *
 * PC-030, item 2.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { criarModelo, listarModelos, modeloNovoSchema } from "@/lib/contratos/modelos-servidor";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "contrato_modelos" });
  if (!authz.ok) return authz.response;
  return ok(await listarModelos(createAdminClient(), authz.org.orgId), { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "contrato_modelos" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const parsed = modeloNovoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dê um nome ao modelo e escreva o texto do contrato (pelo menos 20 caracteres)."), 422, {
      requestId,
    });
  }
  const modelo = await criarModelo(createAdminClient(), authz.org.orgId, authz.user.id, parsed.data);
  void audit({
    action: "contrato_modelo.criado",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "contrato_modelos",
    resourceId: modelo.id,
    requestId,
    metadata: { nome: modelo.nome, interesse: modelo.interesse, versao: modelo.versao },
  });
  return ok(modelo, { requestId, status: 201 });
}
