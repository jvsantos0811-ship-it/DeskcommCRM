/**
 * Grava uma linha de `recusas_da_ia` pelo cliente do PostgREST (rotas e
 * ferramentas MCP). Mesma forma de linha do worker (`linhaDaRecusa`). Nunca
 * lança: o registro não pode derrubar a recusa que ele descreve.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { linhaDaRecusa, type RecusaDaIa } from "@/lib/ai/recusas-da-ia";

export async function registrarRecusaPeloSupabase(supabase: SupabaseClient, r: RecusaDaIa): Promise<void> {
  try {
    await supabase.from("recusas_da_ia").insert(linhaDaRecusa(r));
  } catch {
    /* melhor-esforço — ver lib/agent-engine/agent/recusas.ts */
  }
}
