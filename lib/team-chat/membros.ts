import type { SupabaseClient } from "@supabase/supabase-js";

import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export interface MembroDoChat {
  user_id: string;
  role: string;
  nome: string | null;
}

/**
 * Os membros ATIVOS da organização, com nome — quem pode receber uma conversa
 * direta. `admin` é o client de service role: a RLS de `user_organizations`
 * só mostra o próprio vínculo a quem não é gestor, e o chat precisa da equipe
 * inteira. O filtro de `organization_id` vem de quem chama, de fonte confiável.
 */
export async function membrosAtivos(admin: SupabaseClient, orgId: string): Promise<MembroDoChat[]> {
  const { data } = await admin
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", orgId)
    .is("revoked_at", null)
    .order("created_at", { ascending: true });
  const linhas = (data ?? []) as Array<{ user_id: string; role: string }>;
  const nomes = await nomesDosAtendentes(linhas.map((l) => l.user_id));
  return linhas.map((l) => ({ ...l, nome: nomes.get(l.user_id) ?? null }));
}
