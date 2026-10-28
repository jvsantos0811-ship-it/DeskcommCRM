/**
 * GANHO SÓ POR ASSINATURA CONFIRMADA (PC-003, item 3).
 *
 * O ganho de um negócio é o contrato assinado — e só duas coisas dizem isso:
 *  (a) o aviso `contrato.assinado` de um provedor de assinatura eletrônica,
 *      validado pelo segredo da organização (`/api/v1/webhooks/assinatura/:token`);
 *  (b) uma pessoa com papel GERENTE clicando "Assinatura confirmada" no negócio,
 *      com a data da assinatura.
 * A IA nunca chega aqui (ver `lib/leads/trava-da-ia.ts`).
 *
 * O efeito é o mesmo nas duas origens, e mora numa função só para não haver
 * duas réguas para o mesmo ganho:
 *  1. o negócio vai para a etapa de ganho do funil ("Fechado") pela MESMA
 *     função do botão de ganhar (`encerraDemanda`), com a régua de campos do
 *     funil valendo;
 *  2. ganha a tag `contrato-assinado`;
 *  3. uma linha em `crm_assinaturas_confirmadas` guarda a data, a origem e
 *     quem registrou — é dela que a métrica de contratos assinados lê;
 *  4. a linha do tempo conta o que aconteceu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { encerraDemanda } from "@/lib/leads/encerramento";

export const TAG_CONTRATO_ASSINADO = "contrato-assinado";

export interface ConfirmacaoDeAssinatura {
  leadId: string;
  /** AAAA-MM-DD — o dia em que o contrato foi assinado. */
  dataAssinatura: string;
  origem: "pessoa" | "provedor";
  registradoPorUserId: string | null;
  provedor?: string | null;
  documentoId?: string | null;
}

/** AAAA-MM-DD válida e não no futuro (com um dia de folga para fuso). */
export function dataDeAssinaturaValida(data: string, agora: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return false;
  const d = new Date(`${data}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== data) return false;
  return d.getTime() <= agora.getTime() + 36 * 3600 * 1000;
}

/**
 * Aplica a assinatura confirmada. `admin` é o cliente de serviço — o chamador
 * já resolveu a organização de fonte confiável (sessão ou segredo do aviso), e
 * `ctx.organization_id` filtra TODA leitura e escrita aqui.
 */
export async function confirmarAssinatura(
  admin: SupabaseClient,
  ctx: HandlerCtx,
  c: ConfirmacaoDeAssinatura,
): Promise<{ lead: Record<string, unknown>; jaEstava: boolean; registroId: string | null }> {
  const quem = c.origem === "pessoa" ? "pela equipe" : `pelo serviço de assinatura${c.provedor ? ` (${c.provedor})` : ""}`;
  const dataLegivel = c.dataAssinatura.split("-").reverse().join("/");
  const { lead, jaEstava } = await encerraDemanda(admin, ctx, {
    leadId: c.leadId,
    desfecho: "won",
    motivo: null,
    razaoNaTimeline: `Contrato assinado em ${dataLegivel} — confirmado ${quem}`,
    payloadNaTimeline: {
      assinatura: {
        data: c.dataAssinatura,
        origem: c.origem,
        registrado_por_user_id: c.registradoPorUserId,
        ...(c.provedor ? { provedor: c.provedor } : {}),
      },
    },
  });

  // A tag: lida e regravada sem duplicar. Falha aqui não desfaz o ganho (que já
  // é verdade no banco) — fica no erro devolvido ao chamador pelo log dele.
  const tags = Array.isArray((lead as { tags?: unknown }).tags)
    ? ((lead as { tags: unknown[] }).tags.filter((x) => typeof x === "string") as string[])
    : [];
  if (!tags.includes(TAG_CONTRATO_ASSINADO)) {
    const { data: comTag } = await admin
      .from("crm_leads")
      .update({ tags: [...tags, TAG_CONTRATO_ASSINADO] })
      .eq("organization_id", ctx.organization_id)
      .eq("id", c.leadId)
      .select("*")
      .maybeSingle();
    if (comTag) Object.assign(lead, comTag);
  }

  const { data: registro } = await admin
    .from("crm_assinaturas_confirmadas")
    .insert({
      organization_id: ctx.organization_id,
      lead_id: c.leadId,
      data_assinatura: c.dataAssinatura,
      origem: c.origem,
      registrado_por_user_id: c.registradoPorUserId,
      provedor: c.provedor ?? null,
      documento_id: c.documentoId ?? null,
    })
    .select("id")
    .maybeSingle();

  return { lead, jaEstava, registroId: (registro as { id?: string } | null)?.id ?? null };
}
