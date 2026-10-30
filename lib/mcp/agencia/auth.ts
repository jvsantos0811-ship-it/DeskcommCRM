/**
 * Autenticação das portas da agência.
 *
 * Em cima da validação de sempre (`validateBearerToken`: formato `dsk_`, hash,
 * revogada, expirada, teto de tentativas), esta porta exige, A CADA CHAMADA:
 *
 *   1. o escopo da porta (`agencia:leitura` só abre a Leitura; `agencia:admin`
 *      só abre a Admin) — chave de uma porta nunca abre a outra;
 *   2. a origem dentro de `api_tokens.ips_permitidos` (falha fechada);
 *   3. quem criou a chave ainda ser platform admin `full` ATIVO — tirar o grant
 *      de alguém desliga na hora as chaves que ele criou.
 *
 * O banco (migration 9014) já impede a chave de nascer sem isso; a rota confere
 * de novo porque o mundo muda depois do INSERT.
 */
import { McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import type { Role } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

import { ipEstaNaLista } from "./ip-permitido";
import { PORTAS_DA_AGENCIA, type PortaDaAgencia } from "./portas";

export interface ChaveDaAgenciaValidada {
  porta: PortaDaAgencia;
  apiTokenId: string;
  /** Organização onde a chave está guardada (aparece na tela de Chaves de API dela). */
  organizacaoDaChave: string;
  criadaPor: string;
}

/** Papel com que as ferramentas rodam em cada porta. */
export const PAPEL_DA_PORTA: Record<PortaDaAgencia, Role> = {
  // Leitura: o suficiente para toda ferramenta de leitura (todas pedem `agent`).
  leitura: "agent",
  // Admin: configuração da org (etapas, regras, webhooks pedem `manager`).
  admin: "manager",
};

export async function validarChaveDaAgencia(
  headers: Headers,
  porta: PortaDaAgencia,
  ip: string | null,
): Promise<ChaveDaAgenciaValidada> {
  // A organização onde a chave mora pode estar suspensa sem que isso diga nada
  // sobre as outras: a suspensão é conferida por organização, a cada chamada.
  const auth = await validateBearerToken(headers.get("authorization"), {
    permiteOrgSuspensa: true,
    aceitaChaveDaAgencia: true,
  });

  const definicao = PORTAS_DA_AGENCIA[porta];
  if (!auth.scopes.includes(definicao.escopo)) {
    // Mesma resposta para "chave comum" e "chave da outra porta": não diz qual existe.
    throw new McpAuthError(-32002, 403, "This key does not open this port.");
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_tokens")
    .select("ips_permitidos, created_by")
    .eq("organization_id", auth.organizationId)
    .eq("id", auth.apiTokenId)
    .maybeSingle();
  if (error || !data) {
    throw new McpAuthError(-32603, 500, "Key lookup failed.");
  }

  const ips = Array.isArray(data.ips_permitidos) ? (data.ips_permitidos as string[]) : [];
  if (!ipEstaNaLista(ip, ips)) {
    throw new McpAuthError(-32002, 403, "Origin not allowed for this key.", "origem_nao_permitida");
  }

  const { data: grant, error: grantErr } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", data.created_by)
    .eq("scope", "full")
    .is("revoked_at", null)
    .maybeSingle();
  if (grantErr) {
    throw new McpAuthError(-32603, 500, "Key lookup failed.");
  }
  if (!grant) {
    throw new McpAuthError(-32002, 403, "The owner who created this key no longer administers the installation.");
  }

  return {
    porta,
    apiTokenId: auth.apiTokenId,
    organizacaoDaChave: auth.organizationId,
    criadaPor: data.created_by as string,
  };
}
