/**
 * O VOCABULÁRIO DO CONTRATO DO NEGÓCIO (fork, migration 9008).
 *
 * Fonte única dos dois conjuntos que o banco amarra com CHECK em
 * `crm_contracts`: o par banco × TypeScript é cobrado por
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts`, que lê ESTES
 * símbolos (nunca uma cópia).
 *
 * O ciclo de vida, na linguagem de quem usa:
 *
 *   rascunho  → o PDF do escritório foi anexado ao negócio, ainda não saiu;
 *   enviado   → saiu pelo WhatsApp e espera a assinatura do cliente;
 *   assinado  → alguém da equipe marcou que o cliente assinou;
 *   recusado  → alguém marcou que o cliente não vai assinar;
 *   cancelado → a equipe desistiu deste documento (fica no histórico).
 *
 * `assinado`, `recusado` e `cancelado` são FINAIS: um contrato novo é outro
 * arquivo, e reabrir apagaria a história do que o cliente recebeu.
 */
export const STATUS_DO_CONTRATO = ["rascunho", "enviado", "assinado", "recusado", "cancelado"] as const;
export type StatusDoContrato = (typeof STATUS_DO_CONTRATO)[number];

/**
 * Quem colhe a assinatura. Hoje só `manual`: o PDF vai pelo WhatsApp como está
 * e uma pessoa marca o desfecho. Um provedor de assinatura eletrônica entra
 * aqui, no CHECK da coluna (migration nova) e no registro de
 * `lib/contratos/provedores.ts` — nos três, ou o par acima reprova.
 */
export const PROVEDORES_DE_ASSINATURA = ["manual"] as const;
export type ProvedorDeAssinaturaId = (typeof PROVEDORES_DE_ASSINATURA)[number];

/** O desfecho que uma pessoa marca. */
export const DESFECHOS_DO_CONTRATO = ["assinado", "recusado", "cancelado"] as const;
export type DesfechoDoContrato = (typeof DESFECHOS_DO_CONTRATO)[number];

/** De onde se pode enviar: o rascunho, ou de novo quando o cliente pede outra via. */
export function podeEnviar(status: StatusDoContrato): boolean {
  return status === "rascunho" || status === "enviado";
}

/**
 * As transições de desfecho. Assinar e recusar pedem que o contrato tenha
 * SAÍDO (não se assina o que o cliente nunca recebeu); cancelar vale para o
 * que ainda não terminou.
 */
export function podeDecidir(status: StatusDoContrato, desfecho: DesfechoDoContrato): boolean {
  if (desfecho === "cancelado") return status === "rascunho" || status === "enviado";
  return status === "enviado";
}

export function ehFinal(status: StatusDoContrato): boolean {
  return status === "assinado" || status === "recusado" || status === "cancelado";
}

/** Limite do arquivo: o mesmo do bucket `contratos` (20 MB). */
export const TAMANHO_MAXIMO_DO_CONTRATO = 20 * 1024 * 1024;
