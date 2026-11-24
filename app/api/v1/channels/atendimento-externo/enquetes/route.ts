/**
 * GET /api/v1/channels/atendimento-externo/enquetes — a chave, o campo do voto,
 *     os NOMES de campo vistos no último POST e as enquetes cadastradas.
 * PUT /api/v1/channels/atendimento-externo/enquetes — grava tudo de uma vez
 *     (chave, campo e a lista de enquetes; enquete fora da lista é apagada, e os
 *     votos dela vão junto).
 *
 * PC-050: quem votou na enquete do grupo vira conversa com a IA. A tela vive no
 * canal de atendimento externo (Conexões); só admin, como o resto da conexão.
 * Desligado por padrão: sem a chave, a entrada do canal se comporta como antes.
 * Nada de lead aqui: só nomes de campo e o texto das enquetes.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  CAMPO_DO_VOTO,
  enqueteSchema,
  lerConfigDaEnquete,
  lerEnquetes,
} from "@/lib/channels/atendimento-externo/enquete";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECURSO = "enquetes_do_grupo";

const corpoSchema = z.strictObject({
  ligada: z.boolean(),
  campo_do_voto: z.string().trim().regex(CAMPO_DO_VOTO).nullable(),
  enquetes: z.array(enqueteSchema).max(30),
});

export async function GET(): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  try {
    const [config, enquetes] = await Promise.all([
      lerConfigDaEnquete(admin, authz.org.orgId),
      lerEnquetes(admin, authz.org.orgId),
    ]);
    return ok(
      {
        ligada: config?.ligada ?? false,
        campo_do_voto: config?.campoDoVoto ?? null,
        campos_vistos: config?.camposVistos ?? [],
        enquetes: enquetes.map(({ codigo, pergunta, opcoes, ativa }) => ({ codigo, pergunta, opcoes, ativa })),
      },
      { requestId },
    );
  } catch {
    return fail("internal_error", "Não foi possível ler as enquetes.", 500, { requestId });
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;

  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", "Enquetes inválidas.", 400, { requestId, details: corpo.error.flatten() });
  }
  const codigos = corpo.data.enquetes.map((e) => e.codigo);
  if (new Set(codigos).size !== codigos.length) {
    return fail("validation_failed", "Duas enquetes com o mesmo código.", 400, { requestId });
  }
  if (corpo.data.ligada && !corpo.data.campo_do_voto) {
    return fail("validation_failed", "Para ligar, escolha o campo de onde vem o voto.", 400, { requestId });
  }

  const orgId = authz.org.orgId;
  const admin = createAdminClient();

  const { error: erroConfig } = await admin
    .from("enquetes_config")
    .upsert({ organization_id: orgId, ligada: corpo.data.ligada, campo_do_voto: corpo.data.campo_do_voto }, { onConflict: "organization_id" });
  if (erroConfig) return fail("internal_error", "Não foi possível salvar a configuração.", 500, { requestId });

  if (corpo.data.enquetes.length > 0) {
    const { error } = await admin.from("enquetes_do_grupo").upsert(
      corpo.data.enquetes.map((e) => ({ organization_id: orgId, codigo: e.codigo, pergunta: e.pergunta, opcoes: e.opcoes, ativa: e.ativa })),
      { onConflict: "organization_id,codigo" },
    );
    if (error) return fail("internal_error", "Não foi possível salvar as enquetes.", 500, { requestId });
  }
  // Enquete que saiu da lista é apagada (os votos dela vão junto, em cascata).
  let apagar = admin.from("enquetes_do_grupo").delete().eq("organization_id", orgId);
  if (codigos.length > 0) apagar = apagar.not("codigo", "in", `(${codigos.map((c) => `"${c}"`).join(",")})`);
  const { error: erroApagar } = await apagar;
  if (erroApagar) return fail("internal_error", "Não foi possível tirar as enquetes removidas.", 500, { requestId });

  void audit({
    action: "channel.enquetes_salvas",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    // Só a forma: o texto das enquetes é do escritório e fica na tabela.
    metadata: { ligada: corpo.data.ligada, campo_do_voto: corpo.data.campo_do_voto, enquetes: codigos.length },
  });
  return ok({ salvo: true }, { requestId });
}
