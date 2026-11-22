/**
 * O link do chat DENTRO da plataforma de atendimento (ChatGuru, PC-047) — a
 * parte que a Inbox lê para mostrar "Abrir em …".
 *
 * Sem import de servidor de propósito: o cabeçalho da conversa é componente de
 * cliente, e este é o único pedaço do canal que ele precisa.
 *
 * O link só vale se for https e do domínio da plataforma. Vem do POST dela e
 * vira `href` na tela de quem atende: aceitar qualquer URL seria deixar quem
 * conhece o segredo da entrada plantar um link para onde quisesse na Inbox.
 */

/** Chave de `conversations.metadata` com o link do chat na plataforma. */
export const CHAVE_DO_LINK_EXTERNO = "link_externo";

/** O link conferido (https, domínio da plataforma), ou `null`. */
export function linkDoChatConferido(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return null;
    if (u.hostname !== "chatguru.app" && !u.hostname.endsWith(".chatguru.app")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** O link guardado na conversa, conferido de novo na leitura (o jsonb aceita qualquer coisa). */
export function linkExternoDaConversa(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  return linkDoChatConferido((metadata as Record<string, unknown>)[CHAVE_DO_LINK_EXTERNO]);
}
