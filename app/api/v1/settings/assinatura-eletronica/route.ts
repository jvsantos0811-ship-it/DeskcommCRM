/**
 * GET /api/v1/settings/assinatura-eletronica — a conta do serviço de
 *     assinatura eletrônica desta organização, como a tela mostra (sem a
 *     chave: só os 4 últimos caracteres). Gerente ou dono.
 * PUT /api/v1/settings/assinatura-eletronica — grava serviço, ambiente, chave
 *     (opcional: sem ela fica a guardada), aprovação da equipe e prazo. A chave
 *     é testada no serviço ANTES de gravar, e o aviso (webhook) é cadastrado
 *     com segredo novo (`lib/contratos/assinatura/configurar.ts`).
 *
 * PC-030, item 1: "credenciais por organização, guardadas como segredo,
 * cadastradas numa tela de Configurações › Integrações › Assinatura
 * eletrônica (só dono ou gerente)".
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { contaParaATela, lerLinhaDaConta } from "@/lib/contratos/assinatura/conta";
import { salvarContaDeAssinatura } from "@/lib/contratos/assinatura/configurar";
import { NOME_DO_PROVEDOR, PROVEDORES_ELETRONICOS } from "@/lib/contratos/vocabulario";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z
  .object({
    provedor: z.enum(PROVEDORES_ELETRONICOS as unknown as [string, ...string[]]),
    ambiente: z.enum(["teste", "producao"]),
    chave: z.string().trim().min(8).max(500).optional(),
    aprovacao_da_equipe: z.boolean(),
    prazo_para_assinar_dias: z.number().int().min(1).max(60),
    ativo: z.boolean(),
  })
  .strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "assinatura_eletronica" });
  if (!authz.ok) return authz.response;
  const linha = await lerLinhaDaConta(createAdminClient(), authz.org.orgId);
  return ok(
    {
      conta: linha ? contaParaATela(linha) : null,
      servicos: PROVEDORES_ELETRONICOS.map((id) => ({ id, nome: NOME_DO_PROVEDOR[id] })),
    },
    { requestId },
  );
}

export async function PUT(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "assinatura_eletronica" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Confira os campos da assinatura eletrônica."), 422, { requestId });
  }
  const entrada = parsed.data as z.infer<typeof corpoSchema> & { provedor: (typeof PROVEDORES_ELETRONICOS)[number] };

  const r = await salvarContaDeAssinatura(createAdminClient(), {
    orgId: authz.org.orgId,
    userId: authz.user.id,
    entrada,
    baseUrl: env.NEXT_PUBLIC_APP_URL,
  });
  if (!r.ok) {
    const status = r.codigo === "servico_fora" ? 503 : r.codigo === "erro" ? 500 : 422;
    return fail(r.codigo === "erro" ? "internal_error" : r.codigo, t(r.mensagem), status, { requestId });
  }

  void audit({
    action: "settings.assinatura_eletronica_atualizada",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: {
      provedor: entrada.provedor,
      ambiente: entrada.ambiente,
      trocou_chave: r.trocouChave,
      aprovacao_da_equipe: entrada.aprovacao_da_equipe,
      prazo_para_assinar_dias: entrada.prazo_para_assinar_dias,
      ativo: entrada.ativo,
      aviso: r.aviso,
    },
  });
  return ok({ conta: r.conta, aviso: r.aviso }, { requestId });
}
