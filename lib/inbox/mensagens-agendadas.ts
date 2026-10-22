/**
 * Mensagem agendada: as regras puras, sem I/O (testadas em
 * `tests/unit/mensagens-agendadas.test.ts`).
 *
 * Moram aqui, e não na rota, porque a rota que CRIA e o cron que ENVIA leem as
 * mesmas fronteiras: o que a tela aceita agendar e o que o cron aceita mandar
 * não podem divergir.
 */

/** O texto cabe numa mensagem de WhatsApp — o mesmo teto de `sendMessageSchema`. */
export const TEXTO_MAXIMO = 4096;

/** Antecedência mínima: abaixo disso é "enviar agora", e o botão de enviar já existe. */
export const ANTECEDENCIA_MINIMA_MS = 60 * 1000;

/**
 * Antecedência máxima. Agendar para daqui a meses é plano, não recado — e uma
 * conversa parada tanto tempo provavelmente mudou de dono, de etapa ou de
 * assunto. 60 dias cobre "te mando no começo do mês que vem" com folga.
 */
export const ANTECEDENCIA_MAXIMA_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Quanto tempo uma linha pode ficar em `sending` antes de o cron concluir que
 * o envio anterior morreu no meio. Passado isso ela vira `failed` — NUNCA volta
 * para a fila: reenviar às cegas pode mandar em dobro, e mensagem duplicada ao
 * cliente é pior que um aviso de falha ao atendente (a mesma régua do
 * `recover-stuck-messages`).
 */
export const ENVIO_TRAVADO_MS = 10 * 60 * 1000;

export type EstadoDoAgendamento = "scheduled" | "sending" | "sent" | "failed" | "cancelled";

export interface MensagemAgendada {
  id: string;
  organization_id: string;
  conversation_id: string;
  body: string;
  send_at: string;
  status: EstadoDoAgendamento;
  created_by_user_id: string | null;
  message_id: string | null;
  error: string | null;
  sent_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export const COLUNAS_DO_AGENDAMENTO =
  "id, organization_id, conversation_id, body, send_at, status, created_by_user_id, message_id, error, sent_at, cancelled_at, created_at";

/**
 * Por que este agendamento não pode ser criado — ou `null` se pode.
 *
 * Recebe o `t` de quem chama (a rota passa o do idioma da sessão; a tela, o
 * `useT()`), e cada frase passa por ele como LITERAL: a cerca de i18n reprova
 * `t(variavel)`, porque frase montada em runtime não está em dicionário nenhum.
 */
export function motivoParaRecusarAgendamento(
  texto: string,
  quando: Date,
  agora: Date = new Date(),
  t: (frase: string) => string = (frase) => frase,
): string | null {
  const limpo = texto.trim();
  if (limpo.length === 0) return t("Escreva a mensagem antes de agendar.");
  if (limpo.length > TEXTO_MAXIMO) {
    return t("A mensagem passou de {max} caracteres: divida em duas.").replace("{max}", String(TEXTO_MAXIMO));
  }
  if (Number.isNaN(quando.getTime())) return t("Data ou hora inválida.");
  const diferenca = quando.getTime() - agora.getTime();
  if (diferenca < ANTECEDENCIA_MINIMA_MS) {
    return t("Escolha um horário pelo menos 1 minuto no futuro. Para mandar agora, use Enviar.");
  }
  if (diferenca > ANTECEDENCIA_MAXIMA_MS) {
    return t("Dá para agendar com até 60 dias de antecedência.");
  }
  return null;
}

/** Só o que ainda não saiu pode ser cancelado. */
export function podeCancelar(status: EstadoDoAgendamento): boolean {
  return status === "scheduled";
}

/**
 * O texto da nota interna que avisa, no próprio fio da conversa, que um
 * agendamento não saiu — o lugar onde o atendente vai olhar.
 */
export function notaDeFalha(corpo: string, motivo: string): string {
  const trecho = corpo.trim().replace(/\s+/g, " ");
  const curto = trecho.length > 120 ? `${trecho.slice(0, 117)}…` : trecho;
  return `Mensagem agendada NÃO foi enviada: ${motivo}\n\nTexto: "${curto}"`;
}
