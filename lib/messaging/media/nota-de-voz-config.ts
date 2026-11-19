/**
 * PC-043 — a chave "nota de voz no formato do WhatsApp", por organização.
 *
 * Mora em `organizations.settings.nota_de_voz` (`{ formato_whatsapp: boolean }`).
 * Ausente, inválida ou qualquer coisa que não seja `formato_whatsapp: true` =
 * DESLIGADA, que é o comportamento de antes: a gravação do browser só troca de
 * container (`voice-transcode.ts`). Ligada, a rota de upload reencoda a nota de
 * voz no formato que o WhatsApp usa antes de guardar.
 *
 * Arquivo puro (sem `node:*`): a tela de Configurações › Atendimento lê daqui
 * sem puxar o ffmpeg para o servidor da página.
 */
import { z } from "zod";

/** O corpo que a tela grava em `PATCH /api/v1/settings/nota-de-voz`. */
export const notaDeVozSchema = z.strictObject({ formato_whatsapp: z.boolean() });

export type ConfigNotaDeVoz = z.infer<typeof notaDeVozSchema>;

/** Lê a chave do `settings` da organização. Nunca lança. */
export function notaDeVozNoFormatoWhatsapp(settings: unknown): boolean {
  const chave = (settings as { nota_de_voz?: unknown } | null | undefined)?.nota_de_voz;
  return (chave as { formato_whatsapp?: unknown } | null | undefined)?.formato_whatsapp === true;
}
