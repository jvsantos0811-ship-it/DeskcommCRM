/**
 * VÍDEO DE AQUECIMENTO (PC-045, parte 2): um vídeo por organização, enviado
 * uma vez por compromisso logo depois da confirmação do agendamento.
 *
 * Decisão do João (22/11/2026): configurado por ORGANIZAÇÃO e fácil de trocar.
 * O arquivo mora no bucket privado de mídia, em `<org>/aquecimento/<uuid>.mp4`,
 * e sobe DIRETO do navegador para o Storage por um link assinado (o corpo de
 * requisição do app tem teto de 10 MB, abaixo do limite de 16 MB do WhatsApp);
 * na hora de enviar ele é COPIADO para a pasta da conversa — a regra de posse
 * do envio (`isMediaPathOwnedBy`) só aceita mídia da própria conversa — e sai
 * pelo caminho de toda mídia. Sem vídeo cadastrado = como antes.
 */
import { randomId } from "@/lib/random-id";

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
  return `${orgId}/aquecimento/${randomId()}.${mime === "video/3gpp" ? "3gp" : "mp4"}`;
}

/** O caminho é mesmo desta organização, na pasta do aquecimento? */
export function videoPertenceAOrg(caminho: string, orgId: string): boolean {
  const prefixo = `${orgId}/aquecimento/`;
  if (!caminho.startsWith(prefixo)) return false;
  const resto = caminho.slice(prefixo.length);
  return /^[A-Za-z0-9._-]{1,120}$/.test(resto) && !resto.includes("..");
}

/**
 * A cópia para a conversa, nomeada pelo ARQUIVO DE ORIGEM: a mesma conversa
 * guarda uma cópia só de cada vídeo (dois agendamentos do mesmo contato não
 * duplicam 16 MB no Storage); trocar o vídeo gera nome novo.
 */
export function caminhoNaConversa(orgId: string, conversationId: string, origem: string): string {
  const arquivo = origem.slice(origem.lastIndexOf("/") + 1);
  return `${orgId}/${conversationId}/aquecimento-${arquivo}`;
}

/** Marcas (bytes 8-11 da caixa `ftyp`) de mp4/3gp que o WhatsApp toca. `.mov` (`qt  `) e `.heic` ficam fora. */
const MARCAS_ACEITAS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "3gp4", "3gp5", "3gp6", "3g2a", "dash", "msnv"]);

/**
 * Pura: os primeiros bytes são de um arquivo mp4/3gp (caixa `ftyp` do ISO BMFF,
 * com marca de mp4/3gp)? O tipo que o navegador declara vem da extensão; isto
 * confere o conteúdo. O codec (H.264 x HEVC) não é conferido aqui.
 */
export function cabecalhoDeMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp") return false;
  return MARCAS_ACEITAS.has(String.fromCharCode(...bytes.slice(8, 12)));
}

/**
 * Pura: dos arquivos da pasta do aquecimento, quais são lixo (não são o vídeo
 * atual e têm mais de 2 h — upload que nunca foi confirmado, recusa que não
 * conseguiu apagar, troca cujo antigo ficou). As 2 h protegem um envio em curso.
 */
export function orfaosDoAquecimento(
  arquivos: readonly { name: string; created_at: string | null }[],
  atual: string | null,
  agora: Date,
): string[] {
  const limite = agora.getTime() - 2 * 60 * 60 * 1000;
  return arquivos
    .filter((a) => a.name !== atual && a.created_at !== null && new Date(a.created_at).getTime() < limite)
    .map((a) => a.name);
}
