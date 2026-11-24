import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * /api/v1/agenda/sequencia — a sequência depois de marcar de cada tipo de
 * atendimento (PC-052 parte 3). Ver `lib/agenda/sequencia.ts`.
 *
 *   GET   — a chave e a configuração de cada tipo. Qualquer membro.
 *   PATCH — `{ tipo_id, ligada, config }`. Manager ou acima. Quem salva manda a
 *           configuração inteira: não há meio-termo entre "o que a tela mostrou"
 *           e "o que ficou gravado".
 *
 * Organização sempre da sessão; o tipo é filtrado por ela.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { lerSequencia, sequenciaEntrada, sequenciaParaGravar } from "@/lib/agenda/sequencia";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const RECURSO = "calendar_event_types";

const patchSchema = z
  .object({
    tipo_id: z.string().uuid(),
    ligada: z.boolean(),
    config: sequenciaEntrada,
  })
  .strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { data, error } = await createAdminClient()
    .from("calendar_event_types")
    .select("id, name, is_active, post_booking_sequence_enabled, post_booking_sequence")
    .eq("organization_id", authz.org.orgId)
    .order("is_active", { ascending: false })
    .order("name");
  if (error) {
    logger.error("[agenda/sequencia] leitura falhou", { detail: error.message, requestId });
    return fail("internal_error", t("Não foi possível ler a sequência dos tipos de atendimento."), 500, {
      requestId,
    });
  }
  return ok(
    (data ?? []).map((linha) => {
      const c = lerSequencia(linha.post_booking_sequence);
      return {
        tipo_id: linha.id as string,
        nome: linha.name as string,
        ativo: linha.is_active as boolean,
        ligada: linha.post_booking_sequence_enabled === true,
        config: {
          aquecimento: { ativo: c.aquecimento.ativo, hora: c.aquecimento.hora, texto: c.aquecimento.texto },
          confirmacao: {
            ativo: c.confirmacao.ativo,
            corte: c.confirmacao.corte,
            hora_vespera: c.confirmacao.horaVespera,
            hora_do_dia: c.confirmacao.horaDoDia,
            texto_vespera: c.confirmacao.textoVespera,
            texto_do_dia: c.confirmacao.textoDoDia,
          },
        },
      };
    }),
    { requestId },
  );
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const lido = patchSchema.safeParse(await req.json().catch(() => null));
  if (!lido.success) {
    return fail("validation_failed", t("Confira os horários (hh:mm) e o tamanho dos textos."), 422, {
      requestId,
      details: { campos: lido.error.issues.map((i) => i.path.join(".")) },
    });
  }

  const { data, error } = await createAdminClient()
    .from("calendar_event_types")
    .update({
      post_booking_sequence_enabled: lido.data.ligada,
      post_booking_sequence: sequenciaParaGravar(lido.data.config),
    })
    .eq("id", lido.data.tipo_id)
    .eq("organization_id", authz.org.orgId)
    .select("id")
    .maybeSingle();
  if (error) {
    logger.error("[agenda/sequencia] gravação falhou", { detail: error.message, requestId });
    return fail("internal_error", t("Não foi possível salvar a sequência."), 500, { requestId });
  }
  if (!data) return fail("not_found", t("Tipo de agendamento não encontrado."), 404, { requestId });

  void audit({
    action: "agenda.sequencia_alterada",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "calendar_event_types",
    resourceId: lido.data.tipo_id,
    requestId,
    metadata: {
      ligada: lido.data.ligada,
      aquecimento: lido.data.config.aquecimento.ativo,
      confirmacao: lido.data.config.confirmacao.ativo,
    },
  });
  return ok({ tipo_id: lido.data.tipo_id, ligada: lido.data.ligada }, { requestId });
}
