/**
 * GET /api/v1/leads/lost?dias=90 — os negócios PERDIDOS do período, para a tela
 * de Recuperação (`/app/recuperacao`).
 *
 * Lê pelo client de RLS do usuário: o recorte de visibilidade do funil
 * (`visibility_mode` — o atendente em "só os seus" vê só os dele) vale aqui
 * exatamente como no quadro. Organização vem da sessão; o período é uma lista
 * fechada (`PERIODOS_EM_DIAS`).
 *
 * Para cada negócio devolve também:
 * - a conversa mais recente do contato, para o botão "Ver conversa";
 * - se já existe um negócio retomado a partir dele (`retomado_de_lead_id`),
 *   para a tela não oferecer "Retomar" duas vezes sem avisar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { traduzir } from "@/lib/i18n/dicionario";
import { LIMITE_DA_LISTA, periodoValido, type NegocioPerdido } from "@/lib/leads/recuperacao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface Linha {
  id: string;
  title: string;
  value_cents: number | null;
  currency: string | null;
  lost_reason: string | null;
  closed_at: string;
  pipeline_id: string;
  owner_user_id: string | null;
  contact_id: string | null;
  pipeline: { name: string | null } | null;
  contact: { name: string | null; display_name: string | null } | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const dias = periodoValido(req.nextUrl.searchParams.get("dias"));
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("crm_leads")
    .select(
      "id, title, value_cents, currency, lost_reason, closed_at, pipeline_id, owner_user_id, contact_id, pipeline:crm_pipelines(name), contact:contacts(name, display_name)",
    )
    .eq("organization_id", orgId)
    .eq("status", "lost")
    .gte("closed_at", desde)
    .order("closed_at", { ascending: false })
    .limit(LIMITE_DA_LISTA);
  if (error) {
    return fail("internal_error", t("Não foi possível carregar os negócios perdidos."), 500, { requestId });
  }
  const linhas = (data ?? []) as unknown as Linha[];
  const ids = linhas.map((l) => l.id);
  const contatos = [...new Set(linhas.map((l) => l.contact_id).filter((c): c is string => !!c))];

  const [retomadas, conversas] = await Promise.all([
    ids.length
      ? supabase.from("crm_leads").select("retomado_de_lead_id").eq("organization_id", orgId).in("retomado_de_lead_id", ids)
      : Promise.resolve({ data: [] as Array<{ retomado_de_lead_id: string | null }> }),
    contatos.length
      ? supabase
          .from("conversations")
          .select("id, contact_id, last_message_at")
          .eq("organization_id", orgId)
          .in("contact_id", contatos)
          .order("last_message_at", { ascending: false, nullsFirst: false })
      : Promise.resolve({ data: [] as Array<{ id: string; contact_id: string | null }> }),
  ]);

  const jaRetomados = new Set(
    ((retomadas.data ?? []) as Array<{ retomado_de_lead_id: string | null }>)
      .map((r) => r.retomado_de_lead_id)
      .filter((v): v is string => !!v),
  );
  const conversaDoContato = new Map<string, string>();
  for (const c of (conversas.data ?? []) as Array<{ id: string; contact_id: string | null }>) {
    if (c.contact_id && !conversaDoContato.has(c.contact_id)) conversaDoContato.set(c.contact_id, c.id);
  }

  const negocios: NegocioPerdido[] = linhas.map((l) => ({
    id: l.id,
    title: l.title,
    value_cents: l.value_cents,
    currency: l.currency,
    lost_reason: l.lost_reason,
    closed_at: l.closed_at,
    pipeline_id: l.pipeline_id,
    pipeline_nome: l.pipeline?.name ?? null,
    owner_user_id: l.owner_user_id,
    contact_id: l.contact_id,
    contato_nome: nomeDoContato(l.contact),
    conversa_id: l.contact_id ? (conversaDoContato.get(l.contact_id) ?? null) : null,
    retomado: jaRetomados.has(l.id),
  }));

  return ok({ dias, negocios, truncado: linhas.length >= LIMITE_DA_LISTA }, { requestId });
}
