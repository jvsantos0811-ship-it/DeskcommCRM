/**
 * O RODÍZIO de responsáveis de um tipo de atendimento (PC-052).
 *
 * ─── O que ele responde ────────────────────────────────────────────────────
 *
 * "Quem chamou não escolheu responsável. Em que ORDEM eu tento as pessoas da
 * lista?" A primeira da ordem é a DA VEZ; as seguintes são para quem a da vez
 * não tiver horário na janela pedida (decisão do dono do produto: sem vaga, a
 * vez passa adiante, para o lead não ficar sem horário).
 *
 * ─── A régua da vez ────────────────────────────────────────────────────────
 *
 * A vez é de quem vem DEPOIS de quem recebeu o compromisso mais recente deste
 * tipo (não cancelado). Não há contador guardado: a fonte é o próprio
 * histórico de compromissos, então nada fica dessincronizado quando alguém
 * cancela, remarca ou marca à mão pela tela.
 *
 * ─── Quem entra ────────────────────────────────────────────────────────────
 *
 * Só quem ainda é membro ativo da organização. A coluna é `uuid[]`, sem FK: a
 * rota valida na escrita, e esta leitura descarta na leitura quem saiu da
 * equipe depois. Lista vazia depois do filtro = sem rodízio (vale o
 * responsável padrão, como antes da coluna existir).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A ordem das tentativas, PURA: a lista começa logo depois de `ultimoDono`.
 * `ultimoDono` fora da lista (ou nulo) = começa do primeiro.
 */
export function ordemDaVez(lista: readonly string[], ultimoDono: string | null): string[] {
  const unicos = [...new Set(lista)];
  if (unicos.length === 0) return [];
  const i = ultimoDono ? unicos.indexOf(ultimoDono) : -1;
  if (i < 0) return unicos;
  return [...unicos.slice(i + 1), ...unicos.slice(0, i + 1)];
}

/** A lista do tipo, sem repetidos e sem vazio. Nulo/vazio = sem rodízio. */
export function listaDoRodizio(bruto: unknown): string[] {
  if (!Array.isArray(bruto)) return [];
  return [...new Set(bruto.filter((v): v is string => typeof v === "string" && v.length > 0))];
}

/**
 * A ordem do rodízio deste tipo, lida do banco. Devolve `[]` quando não há
 * rodízio a aplicar (lista vazia, ou ninguém da lista é mais membro).
 *
 * Erro de leitura NÃO derruba a marcação: cai na ordem da lista como está
 * gravada (filtrada pelos membros quando a leitura deles funcionou). Errar a
 * vez é recuperável; recusar o horário ao lead não é.
 */
export async function ordemDoRodizio(
  supabase: SupabaseClient,
  organizationId: string,
  eventTypeId: string,
  brutoDaLista: unknown,
): Promise<string[]> {
  const lista = listaDoRodizio(brutoDaLista);
  if (lista.length === 0) return [];

  const [{ data: membros, error: erroMembros }, { data: ultimo }] = await Promise.all([
    supabase
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", organizationId)
      .is("revoked_at", null)
      .in("user_id", lista),
    supabase
      .from("calendar_appointments")
      .select("owner_user_id")
      .eq("organization_id", organizationId)
      .eq("event_type_id", eventTypeId)
      .neq("status", "cancelled")
      .in("owner_user_id", lista)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const ativos = erroMembros
    ? lista
    : lista.filter((id) => (membros ?? []).some((m) => (m as { user_id: string }).user_id === id));
  const ultimoDono = (ultimo as { owner_user_id?: string | null } | null)?.owner_user_id ?? null;
  return ordemDaVez(ativos, ultimoDono);
}
