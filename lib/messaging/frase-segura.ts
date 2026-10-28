/**
 * A FRASE SEGURA — o que o cliente recebe quando uma trava barra a mensagem
 * inteira da IA e o turno terminaria em silêncio (PC-002b, item 2).
 *
 * ## Por que existe
 *
 * Medido em 28/10/2026 (AUD-002, caso AD4): um lead com benefício acabando
 * escreveu, a IA abriu o caso e escreveu "a equipe assume às 8h" na MESMA
 * resposta, a trava de promessa de humano não viu o caso e derrubou a
 * mensagem — e o lead ficou mudo, com prazo correndo. Uma trava existe para
 * impedir a frase errada, nunca para trocar a frase errada por silêncio.
 *
 * ## A regra
 *
 * Quando o turno de RESPOSTA termina sem nenhuma mensagem entregue, depois de
 * a IA ter TENTADO responder e uma trava de CONTEÚDO ter barrado, o sistema:
 *  1. abre um caso para a equipe (ou um aviso na Central, se casos estão
 *     desligados no agente) com o texto barrado e o motivo;
 *  2. manda ao cliente esta frase, pela MESMA cadeia de travas — opt-out,
 *     LGPD e janela continuam valendo;
 *  3. registra o bloqueio na aba Execuções do agente.
 *
 * As travas que NÃO acionam a frase são as que dizem "não fale com esta
 * pessoa agora": opt-out/contato passado à equipe (`stop`), LGPD, janela de
 * envio e ritmo (`pacing`, `messaging_window`). Nelas o silêncio é a decisão
 * certa, e mandar outra frase seria desobedecer à própria trava.
 *
 * ## Configuração
 *
 * Por organização, em `organizations.settings.frase_segura` (texto). Vazio ou
 * ausente = a frase padrão do idioma da organização. A tela fica em
 * Configurações › Distribuição de atendimento.
 *
 * O texto padrão segue a OAB (Provimento 205/2021): não promete resultado,
 * prazo nem quem vai atender — só confirma que a mensagem chegou.
 */
import { z } from "zod";

export const FRASE_SEGURA_PADRAO_PT = "Recebi sua mensagem e já estou cuidando disso, um instante.";
export const FRASE_SEGURA_PADRAO_ES = "Recibí tu mensaje y ya me estoy ocupando de esto, un momento.";

/** O teto do texto: uma frase curta de WhatsApp, não um parágrafo. */
export const FRASE_SEGURA_MAX = 300;

export const fraseSeguraEntradaSchema = z
  .object({
    frase: z
      .string()
      .max(FRASE_SEGURA_MAX)
      // Vazio é permitido e quer dizer "use a padrão".
      .transform((s) => s.replace(/\s+/g, " ").trim()),
  })
  .strict();

/** A frase padrão do idioma da organização (`organizations.locale`). */
export function fraseSeguraPadrao(locale: string | null | undefined): string {
  return (locale ?? "").toLowerCase().startsWith("es") ? FRASE_SEGURA_PADRAO_ES : FRASE_SEGURA_PADRAO_PT;
}

/** A frase configurada (ou `null` se a organização não escolheu nenhuma). */
export function fraseSeguraConfigurada(settings: unknown): string | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const v = (settings as Record<string, unknown>).frase_segura;
  if (typeof v !== "string") return null;
  const limpa = v.replace(/\s+/g, " ").trim().slice(0, FRASE_SEGURA_MAX);
  return limpa === "" ? null : limpa;
}

/** A frase que vale para a organização: a escolhida, ou a padrão do idioma. */
export function fraseSeguraDaOrg(settings: unknown, locale: string | null | undefined): string {
  return fraseSeguraConfigurada(settings) ?? fraseSeguraPadrao(locale);
}

/**
 * As travas cujo veto é "não fale com esta pessoa agora". Quando uma delas
 * barrou, a frase segura NÃO sai — o silêncio é a decisão da própria trava.
 */
export const TRAVAS_QUE_CALAM = new Set(["stop", "lgpd", "pacing", "messaging_window"]);

export interface VetoDoTurno {
  /** O nome da trava (`case_promise`, `clinical_claim`, `stop`…). */
  trava: string;
  /** O código do veto (`case_promise_without_case`…). */
  codigo: string;
  /** A frase da trava (o ensino que voltou ao modelo). */
  motivo: string;
  /** O texto que a IA tentou mandar e foi barrado. */
  texto: string;
}

/**
 * A rede entra? — a decisão, separada de quem a executa (para se poder
 * afirmar sobre ela sem montar um turno inteiro).
 *
 * Só turno que RESPONDE a quem escreveu; só quando nada saiu; só quando o
 * modelo tentou e foi barrado; nunca quando uma trava "que cala" barrou
 * qualquer tentativa; nunca em turno descartado como obsoleto, passado à
 * equipe ou parado pelo teto de envios (esses têm o próprio desfecho).
 */
export function fraseSeguraDeveSair(t: {
  turnoDeResposta: boolean;
  enviadas: number;
  vetos: readonly VetoDoTurno[];
  turnoDescartado: boolean;
  passouParaAEquipe: boolean;
  capDeEnvio: boolean;
  optedOut: boolean;
}): boolean {
  if (!t.turnoDeResposta || t.enviadas > 0 || t.vetos.length === 0) return false;
  if (t.turnoDescartado || t.passouParaAEquipe || t.capDeEnvio || t.optedOut) return false;
  return !t.vetos.some((v) => TRAVAS_QUE_CALAM.has(v.trava));
}

/** O texto do caso/aviso para a equipe: o que foi barrado e por quê. */
export function resumoDoBloqueio(vetos: readonly VetoDoTurno[]): { resumo: string; motivo: string } {
  const ultimo = vetos[vetos.length - 1]!;
  return {
    resumo:
      "A IA tentou responder e a mensagem foi barrada por uma trava. O cliente recebeu a frase segura. " +
      `Texto barrado: "${ultimo.texto.slice(0, 1500)}"`,
    motivo: `Trava "${ultimo.trava}" (${ultimo.codigo}): ${ultimo.motivo}`.slice(0, 1000),
  };
}
