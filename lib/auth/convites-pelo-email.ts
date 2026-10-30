import type { SupabaseClient } from "@supabase/supabase-js";

import type { InvitePayload } from "@/lib/auth/invite-token";
import type { InterfaceSettings } from "@/lib/navigation/interface";

/**
 * O CONVITE ACHADO PELO E-MAIL, para quem chegou sem o link.
 *
 * O convite só reconhecia a pessoa pelo token que viaja no link do e-mail. Quem
 * entrava por outro caminho — o caso medido em produção é "Entrar com Google"
 * numa instalação `so_convite` — chegava ao `/auth/callback` sem token, e a rota
 * fazia o que faz com qualquer desconhecido: recusava e mandava para
 * `/login?error=cadastro_por_convite`. O convite pendente, válido e para aquele
 * e-mail exato estava em `team_invites` o tempo todo; ninguém olhava.
 *
 * O que torna seguro olhar por e-mail (e não só pelo token):
 *
 * - **O e-mail precisa estar PROVADO pelo provedor de auth** (`email_confirmed_at`):
 *   o Google, ou o clique no link de confirmação. Sem prova, nada é procurado —
 *   ver `emailComprovado`. É a mesma autoridade que `decidirConviteDoSignup` usa
 *   ("o e-mail que o provedor de auth confirmou").
 * - **Só depois do login**, nunca numa tela pública: ninguém descobre quem foi
 *   convidado digitando endereços.
 * - **Só convite vivo**: não aceito, não cancelado na tela de Equipe e dentro do
 *   prazo da própria linha.
 * - **Nada entra sem clique.** Esta função só ACHA; quem vira membro é o botão
 *   "Aceitar" de `/convites`, porque a pessoa pode ter convite de mais de um
 *   escritório e precisa saber onde está entrando.
 */

export interface ConvitePendente {
  id: string;
  organization_id: string;
  nome_da_organizacao: string;
  role: string;
  interface_settings: InterfaceSettings | null;
  invited_by: string | null;
  inviter_name: string | null;
  last_sent_at: string;
  expires_at: string;
}

interface UsuarioDoProvedor {
  email?: string | null;
  email_confirmed_at?: string | null;
}

/** O e-mail que o provedor de auth comprovou, normalizado — ou `null` sem prova. */
export function emailComprovado(user: UsuarioDoProvedor | null | undefined): string | null {
  if (!user?.email_confirmed_at) return null;
  const email = (user.email ?? "").trim().toLowerCase();
  return email === "" ? null : email;
}

interface LinhaDoConvite {
  id: string;
  organization_id: string;
  role: string;
  interface_settings: InterfaceSettings | null;
  invited_by: string | null;
  inviter_name: string | null;
  last_sent_at: string;
  expires_at: string;
  organizations: { display_name: string | null; status: string | null } | null;
}

/**
 * Convites vivos para um e-mail JÁ comprovado (ver `emailComprovado`).
 *
 * `team_invites.email` é gravado em minúsculas (`lib/team/convites.ts`) e há um
 * índice único por `(organization_id, lower(email))` para o pendente — por isso
 * `eq` com o e-mail normalizado, nunca `ilike`: `_` é comum em e-mail e seria
 * curinga ali.
 *
 * Lança quando não consegue LER: quem chama decide o que fazer com a falha, e
 * "não consegui ler" não pode virar "não há convite" em silêncio.
 */
export async function convitesPendentesPeloEmail(
  admin: SupabaseClient,
  email: string,
  agora: Date = new Date(),
): Promise<ConvitePendente[]> {
  const { data, error } = await admin
    .from("team_invites")
    .select(
      "id, organization_id, role, interface_settings, invited_by, inviter_name, last_sent_at, expires_at, organizations(display_name, status)",
    )
    .eq("email", email.trim().toLowerCase())
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", agora.toISOString())
    .order("last_sent_at", { ascending: false });
  if (error) throw new Error(`convites_pelo_email: ${error.message}`);

  return ((data ?? []) as unknown as LinhaDoConvite[])
    // Escritório suspenso, anonimizado ou arquivado não recebe gente nova.
    .filter((linha) => (linha.organizations?.status ?? "active") === "active")
    .map((linha) => ({
      id: linha.id,
      organization_id: linha.organization_id,
      nome_da_organizacao: linha.organizations?.display_name?.trim() || "",
      role: linha.role,
      interface_settings: linha.interface_settings,
      invited_by: linha.invited_by,
      inviter_name: linha.inviter_name,
      last_sent_at: linha.last_sent_at,
      expires_at: linha.expires_at,
    }));
}

/**
 * O mesmo pacote que o token assinado carregaria, montado a partir da LINHA.
 *
 * Organização, papel e convidador saem de `team_invites` (gravada pelo servidor
 * na emissão), nunca de quem pede o aceite. A data de emissão é a do último
 * envio, que é a do token mais novo — é ela que `fn_accept_team_invite` compara
 * com uma revogação de acesso anterior.
 */
export function payloadDoConvitePendente(convite: ConvitePendente, email: string): InvitePayload {
  return {
    invite_id: convite.id,
    email,
    organization_id: convite.organization_id,
    role: convite.role,
    exp: Math.floor(new Date(convite.expires_at).getTime() / 1000),
    iat: Math.floor(new Date(convite.last_sent_at).getTime() / 1000),
    ...(convite.invited_by ? { invited_by: convite.invited_by } : {}),
    ...(convite.interface_settings ? { interface_settings: convite.interface_settings } : {}),
  };
}

/**
 * Para as rotas de entrada: há convite esperando por esta pessoa?
 *
 * Falha FECHADA para o lado de hoje: se a leitura cair, responde `false` e a
 * rota segue exatamente o caminho que já seguia (a recusa, ou a abertura de
 * empresa). Nunca abre nada novo por causa de um tropeço de leitura.
 */
export async function temConvitePendente(
  admin: SupabaseClient,
  user: UsuarioDoProvedor | null | undefined,
): Promise<boolean> {
  const email = emailComprovado(user);
  if (!email) return false;
  try {
    return (await convitesPendentesPeloEmail(admin, email)).length > 0;
  } catch {
    return false;
  }
}
