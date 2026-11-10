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
 *   assinado  → alguém da equipe marcou que o cliente assinou (ou o serviço
 *               de assinatura avisou);
 *   recusado  → o cliente não vai assinar (marcado ou recusado no serviço);
 *   expirado  → o prazo do pedido no serviço de assinatura venceu (PC-030);
 *   cancelado → a equipe desistiu deste documento (fica no histórico).
 *
 * `assinado`, `recusado`, `expirado` e `cancelado` são FINAIS: um contrato
 * novo é outro arquivo, e reabrir apagaria a história do que o cliente
 * recebeu. "Visualizado" não é status: é a data em que o cliente abriu o link
 * (`crm_contracts.visualizado_em`), e o contrato segue `enviado`.
 */
export const STATUS_DO_CONTRATO = ["rascunho", "enviado", "assinado", "recusado", "expirado", "cancelado"] as const;
export type StatusDoContrato = (typeof STATUS_DO_CONTRATO)[number];

/**
 * Quem colhe a assinatura. `manual`: o PDF vai pelo WhatsApp como está e uma
 * pessoa marca o desfecho. Os serviços de assinatura eletrônica (PC-030)
 * entram UM POR VEZ, cada um só depois de passar nos critérios com a conta de
 * teste dele: aqui, no CHECK da coluna (migration nova) e no registro de
 * `lib/contratos/assinatura/registro.ts` — nos três, ou o par acima reprova.
 * Ordem combinada: ZapSign → Clicksign → D4Sign → Autentique.
 */
export const PROVEDORES_DE_ASSINATURA = ["manual", "zapsign"] as const;
export type ProvedorDeAssinaturaId = (typeof PROVEDORES_DE_ASSINATURA)[number];

/** Os serviços de assinatura eletrônica (todo provedor menos o `manual`). */
export const PROVEDORES_ELETRONICOS = PROVEDORES_DE_ASSINATURA.filter(
  (p): p is Exclude<ProvedorDeAssinaturaId, "manual"> => p !== "manual",
);
export type ProvedorEletronicoId = Exclude<ProvedorDeAssinaturaId, "manual">;

/** O nome do serviço como a tela e a linha do tempo mostram. */
export const NOME_DO_PROVEDOR: Record<ProvedorDeAssinaturaId, string> = {
  manual: "Envio manual",
  zapsign: "ZapSign",
};

export function ehProvedorEletronico(id: string): id is ProvedorEletronicoId {
  return (PROVEDORES_ELETRONICOS as readonly string[]).includes(id);
}

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
  return status === "assinado" || status === "recusado" || status === "expirado" || status === "cancelado";
}

/** Limite do arquivo: o mesmo do bucket `contratos` (20 MB). */
export const TAMANHO_MAXIMO_DO_CONTRATO = 20 * 1024 * 1024;
