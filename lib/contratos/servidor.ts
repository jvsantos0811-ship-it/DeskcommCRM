/**
 * Leitura do contrato pelo servidor (fork, migration 9008).
 *
 * Todas as rotas de contrato escrevem e leem com o client de service role, que
 * ignora RLS — por isso TODA consulta daqui leva `organization_id`, e o valor
 * vem sempre da sessão (`requireRole`), nunca do corpo da requisição.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { provedorDeAssinatura } from "@/lib/contratos/provedores";
import type { ContratoDoNegocio, EntregaDoContrato } from "@/lib/contratos/tipos";
import type { ProvedorDeAssinaturaId, StatusDoContrato } from "@/lib/contratos/vocabulario";

export const COLUNAS_DO_CONTRATO =
  "id, organization_id, lead_id, contact_id, conversation_id, titulo, arquivo_path, arquivo_nome, arquivo_bytes, " +
  "status, provedor_assinatura, provedor_documento_id, link_assinatura, assinado_path, message_id, " +
  "ultima_falha_envio, motivo, enviado_em, enviado_por_user_id, decidido_em, decidido_por_user_id, created_at";

export interface LinhaDoContrato {
  id: string;
  organization_id: string;
  lead_id: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  titulo: string;
  arquivo_path: string | null;
  arquivo_nome: string | null;
  arquivo_bytes: number | null;
  status: StatusDoContrato;
  provedor_assinatura: ProvedorDeAssinaturaId;
  provedor_documento_id: string | null;
  link_assinatura: string | null;
  assinado_path: string | null;
  message_id: string | null;
  ultima_falha_envio: string | null;
  motivo: string | null;
  enviado_em: string | null;
  enviado_por_user_id: string | null;
  decidido_em: string | null;
  decidido_por_user_id: string | null;
  created_at: string;
}

export async function carregarContrato(
  admin: SupabaseClient,
  orgId: string,
  id: string,
): Promise<LinhaDoContrato | null> {
  const { data } = await admin
    .from("crm_contracts")
    .select(COLUNAS_DO_CONTRATO)
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  return (data as LinhaDoContrato | null) ?? null;
}

const ENTREGAS = new Set<EntregaDoContrato>(["queued", "sending", "sent", "delivered", "read", "failed"]);

/** O status de entrega de cada mensagem de envio, lido da própria mensagem. */
async function lerEntregas(
  admin: SupabaseClient,
  orgId: string,
  ids: string[],
): Promise<Map<string, { status: EntregaDoContrato; erro: string | null }>> {
  const mapa = new Map<string, { status: EntregaDoContrato; erro: string | null }>();
  if (ids.length === 0) return mapa;
  const { data } = await admin
    .from("messages")
    .select("id, status, error_message")
    .eq("organization_id", orgId)
    .in("id", ids);
  for (const m of (data ?? []) as Array<{ id: string; status: string; error_message: string | null }>) {
    if (ENTREGAS.has(m.status as EntregaDoContrato)) {
      mapa.set(m.id, { status: m.status as EntregaDoContrato, erro: m.error_message });
    }
  }
  return mapa;
}

export async function paraATela(
  admin: SupabaseClient,
  orgId: string,
  linhas: LinhaDoContrato[],
): Promise<ContratoDoNegocio[]> {
  const entregas = await lerEntregas(
    admin,
    orgId,
    linhas.map((l) => l.message_id).filter((id): id is string => !!id),
  );
  return linhas.map((l) => ({
    id: l.id,
    lead_id: l.lead_id,
    titulo: l.titulo,
    status: l.status,
    arquivo_nome: l.arquivo_nome,
    arquivo_bytes: l.arquivo_bytes,
    tem_arquivo: !!l.arquivo_path,
    tem_assinado: !!l.assinado_path,
    provedor_assinatura: l.provedor_assinatura,
    desfecho_por_pessoa: provedorDeAssinatura(l.provedor_assinatura).desfechoPorPessoa,
    link_assinatura: l.link_assinatura,
    enviado_em: l.enviado_em,
    decidido_em: l.decidido_em,
    motivo: l.motivo,
    ultima_falha_envio: l.ultima_falha_envio,
    created_at: l.created_at,
    entrega: l.message_id ? (entregas.get(l.message_id) ?? null) : null,
  }));
}
