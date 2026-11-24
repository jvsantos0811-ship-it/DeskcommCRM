/**
 * VÍDEO DE AQUECIMENTO (PC-045, parte 2): um vídeo por organização, enviado
 * uma vez por compromisso logo depois da confirmação do agendamento.
 *
 * Decisão do João (22/11/2026): configurado por ORGANIZAÇÃO e fácil de trocar.
 * O arquivo mora no bucket privado de mídia, em `<org>/aquecimento/<uuid>.mp4`;
 * na hora de enviar ele é COPIADO para a pasta da conversa — a regra de posse
 * do envio (`isMediaPathOwnedBy`) só aceita mídia da própria conversa — e sai
 * pelo caminho de toda mídia. Sem vídeo cadastrado = como antes.
 */
import { randomUUID } from "node:crypto";

/** Limite do WhatsApp para vídeo: 16 MB. */
export const VIDEO_MAX_BYTES = 16 * 1024 * 1024;
/** Formatos que o WhatsApp aceita como vídeo (H.264 + AAC num mp4; 3gp). */
export const VIDEO_MIMES = ["video/mp4", "video/3gpp"] as const;
export type MimeDoVideo = (typeof VIDEO_MIMES)[number];
export const TEXTO_MAX = 500;
export const BUCKET_DO_VIDEO = "whatsapp-media";

export type RecusaDoVideo = "formato" | "tamanho" | "vazio";

/** Pura: o arquivo serve? A recusa vai para a tela com o motivo. */
export function conferirVideo(arquivo: { type: string; size: number }): RecusaDoVideo | null {
  if (arquivo.size <= 0) return "vazio";
  if (!(VIDEO_MIMES as readonly string[]).includes(arquivo.type)) return "formato";
  if (arquivo.size > VIDEO_MAX_BYTES) return "tamanho";
  return null;
}

/** Onde o vídeo da organização mora. Nome novo a cada troca: o antigo some depois. */
export function caminhoDoVideo(orgId: string, mime: MimeDoVideo): string {
  return `${orgId}/aquecimento/${randomUUID()}.${mime === "video/3gpp" ? "3gp" : "mp4"}`;
}

/** O caminho é mesmo desta organização, na pasta do aquecimento? */
export function videoPertenceAOrg(caminho: string, orgId: string): boolean {
  const prefixo = `${orgId}/aquecimento/`;
  if (!caminho.startsWith(prefixo)) return false;
  const resto = caminho.slice(prefixo.length);
  return /^[A-Za-z0-9._-]{1,120}$/.test(resto) && !resto.includes("..");
}

/** A cópia para a conversa: um arquivo por compromisso. */
export function caminhoNaConversa(orgId: string, conversationId: string, appointmentId: string, origem: string): string {
  const ext = origem.endsWith(".3gp") ? "3gp" : "mp4";
  return `${orgId}/${conversationId}/aquecimento-${appointmentId}.${ext}`;
}
