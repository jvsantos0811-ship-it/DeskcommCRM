/**
 * O segredo do aviso de assinatura (PC-003, item 3 (a)) — guardado só como
 * hash SHA-256 em `assinatura_webhook_chaves`, conferido em tempo constante.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** O cabeçalho em que o provedor manda o segredo. */
export const HEADER_SEGREDO_DA_ASSINATURA = "x-assinatura-segredo";

/** SHA-256 em hex — o que a tabela guarda no lugar do segredo. */
export function hashDoSegredo(segredo: string): string {
  return createHash("sha256").update(segredo, "utf8").digest("hex");
}

/** Compara o segredo recebido com o hash gravado, em tempo constante. */
export function segredoConfere(segredo: string | null, hashGravado: string): boolean {
  if (!segredo) return false;
  const a = Buffer.from(hashDoSegredo(segredo), "hex");
  const b = Buffer.from(hashGravado, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
