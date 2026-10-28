/**
 * A porta da importação do histórico para quem está FORA de `lib/channels/`.
 *
 * A rota e o cron não nomeiam o provedor (`lint:channels`): perguntam aqui se
 * a conexão guarda histórico importável e pedem a rodada. Hoje só o canal
 * intermediado guarda (coexistência); um segundo provedor com a mesma
 * capacidade entra neste arquivo, sem mudar quem chama.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export { importacoesPendentes, rodarImportacao } from "./zernio/importar-historico";

export interface ConexaoParaImportar {
  /** A conexão existe nesta organização. */
  existe: boolean;
  /** E guarda histórico que dá para importar. */
  disponivel: boolean;
}

export async function conexaoParaImportar(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<ConexaoParaImportar> {
  const { data } = await admin
    .from("channel_sessions")
    .select("id, provider, zernio_account_id")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .maybeSingle();
  const linha = data as { provider: string; zernio_account_id: string | null } | null;
  if (!linha) return { existe: false, disponivel: false };
  return { existe: true, disponivel: linha.provider === "zernio" && Boolean(linha.zernio_account_id) };
}
