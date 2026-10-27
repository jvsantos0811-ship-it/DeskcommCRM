/**
 * Onde o PDF do contrato mora e como ele se chama (fork, migration 9008).
 *
 * DOIS lugares, de propósito:
 *
 *   - `contratos/<org>/<contrato>.pdf` (e `<contrato>-assinado.pdf`) — o
 *     ORIGINAL do escritório, privado, lido só pelo servidor. Plano (sem
 *     subpasta) para a Zona de perigo esvaziar a pasta da organização com a
 *     mesma listagem que já usa para `propostas`.
 *   - `whatsapp-media/<org>/<conversa>/contrato-<id>/<Nome_legivel>.pdf` — a
 *     CÓPIA que sai ao cliente. É o caminho que o envio de mídia da conversa
 *     aceita (`isMediaPathOwnedBy`), e é o último segmento que vira o nome do
 *     arquivo no WhatsApp. Morar ali também faz a cópia seguir as regras de
 *     toda mídia da conversa: o reenvio de uma mensagem que ficou na fila
 *     reassina o arquivo, o anexo abre pelo fio, e a anonimização do contato
 *     a apaga junto com as outras mídias.
 */

export const BUCKET_DOS_CONTRATOS = "contratos";

export function caminhoDoOriginal(orgId: string, contratoId: string): string {
  return `${orgId}/${contratoId}.pdf`;
}

export function caminhoDoAssinado(orgId: string, contratoId: string): string {
  return `${orgId}/${contratoId}-assinado.pdf`;
}

/**
 * O nome que o cliente vê no WhatsApp: o título do contrato, legível e seguro
 * como chave de Storage.
 *
 * O Storage recusa chave fora de ASCII (`Invalid key`), então o acento sai
 * (`Honorários` → `Honorarios`), e tudo o que não for letra, número, ponto,
 * hífen ou parêntese vira `_`. Nunca vazio: sem nada legível, `Contrato.pdf`.
 */
export function nomeDoArquivoParaOCliente(titulo: string): string {
  const base = titulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\.pdf$/i, "")
    .replace(/[^A-Za-z0-9.()-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/_?-_?/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80)
    .replace(/[._-]+$/g, "");
  return `${base || "Contrato"}.pdf`;
}

export function caminhoDaCopiaNaConversa(
  orgId: string,
  conversationId: string,
  contratoId: string,
  nomeDoArquivo: string,
): string {
  return `${orgId}/${conversationId}/contrato-${contratoId}/${nomeDoArquivo}`;
}

/** Os 5 bytes de todo PDF. O `type` do navegador é declaração, não prova. */
export function pareceUmPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}
