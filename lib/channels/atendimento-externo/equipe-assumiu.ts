/**
 * A EQUIPE ASSUMIU DENTRO DA PLATAFORMA (PC-057).
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * No canal em que a IA atende DENTRO de outra plataforma de atendimento
 * (ChatGuru, PC-047), a equipe responde o cliente LÁ, e a plataforma só manda
 * ao CRM as mensagens do cliente. O CRM não via a pessoa entrar: a IA seguia
 * respondendo por cima dela, e o follow-up seguia cobrando quem já estava
 * sendo atendido. O PC-029 (`lib/escalacao/equipe-assumiu.ts`) resolvia isso
 * para o CRM e para o celular, nunca para este canal.
 *
 * ─── O sinal ───────────────────────────────────────────────────────────────
 *
 * A equipe executa, no chat, um diálogo da plataforma (ex.: "IA: equipe
 * assumiu") que faz duas coisas, nesta ordem:
 *
 *   1. grava no `campo_da_ia` o MESMO `valor_ao_passar` que o CRM grava quando a
 *      IA passa o atendimento — isso já faz a plataforma parar de entregar as
 *      mensagens seguintes ao CRM;
 *   2. faz o "POST PARA URL" para a entrada deste canal.
 *
 * Esse POST carrega `campos_personalizados.<campo_da_ia> = <valor_ao_passar>`.
 * Com a chave da conexão ligada (`equipe_assumiu_pela_plataforma`), é ele que
 * diz "a equipe assumiu" — e o CRM aplica o mesmo efeito do PC-029: a IA cala de
 * forma durável, o contato fica só humano, as mensagens agendadas caem, os
 * follow-ups seguem a política de passagem de cada fluxo e o card vai para a
 * "Etapa quando a equipe assume".
 *
 * ─── O que NÃO acontece ────────────────────────────────────────────────────
 *
 *  - O POST do sinal NÃO vira mensagem: o `texto_mensagem` dele é a última
 *    mensagem do chat (do cliente ou da própria equipe), e gravá-lo duplicaria
 *    ou atribuiria ao cliente o que a equipe escreveu. A IA também não roda.
 *  - Chave desligada (padrão), conexão sem `campo_da_ia` ou com o valor vazio:
 *    nada muda, o POST é lido como sempre.
 *  - Contato ou conversa que o CRM não conhece (cliente antigo, que nunca
 *    passou pela IA): nada é criado. O sinal é reconhecido e descartado.
 *
 * A organização e a sessão vêm de quem chama (o token do caminho e o segredo
 * da conexão), nunca do corpo. Nunca lança: sem conseguir ler a conexão, o
 * POST segue o caminho de sempre; reconhecido o sinal, uma falha depois disso
 * devolve `nao_aplicado` e o POST continua NÃO virando mensagem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { equipeAssumiuRespondendo } from "@/lib/escalacao/equipe-assumiu";
import { logger } from "@/lib/logger";

import { encontrarContatoPorTelefone } from "../contato-por-telefone";
import { lerConfigDoAtendimentoExterno, type ConfigDoAtendimentoExterno } from "./config";
import { valorDoCampo } from "./enquete";

const sem = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();

/**
 * O POST é o sinal de "a equipe assumiu"? Pura.
 *
 * Exige a chave ligada E um `campo_da_ia` com `valor_ao_passar` preenchido: sem
 * valor, qualquer chat com o campo vazio seria lido como "assumido".
 * Compara sem acento e sem caixa, como a enquete compara a opção.
 */
export function ehSinalDeEquipeAssumiu(
  corpo: Record<string, unknown> | null,
  config: Pick<ConfigDoAtendimentoExterno, "campoDaIa" | "equipeAssumiuPelaPlataforma">,
): boolean {
  if (!corpo || !config.equipeAssumiuPelaPlataforma || !config.campoDaIa) return false;
  const esperado = sem(config.campoDaIa.valorAoPassar ?? "");
  if (!esperado) return false;
  const valor = valorDoCampo(corpo, `campos_personalizados.${config.campoDaIa.nome}`);
  return valor !== null && sem(valor) === esperado;
}

export type DesfechoDoSinalDaEquipe =
  /** Não era o sinal (ou a chave está desligada): o POST segue o caminho de sempre. */
  | { reconhecido: false }
  /** Era o sinal. `status` diz o que aconteceu; o POST não vira mensagem. */
  | {
      reconhecido: true;
      status: "aplicado" | "ja_assumida" | "sem_contato" | "sem_conversa" | "nao_aplicado";
      cardMovidoPara?: string | null;
    };

function textoDo(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Lê a configuração da conexão. Ilegível ou ausente = vazia (o sinal fica desligado). */
async function configDaConexao(
  admin: SupabaseClient,
  orgId: string,
  channelSessionId: string,
): Promise<ConfigDoAtendimentoExterno | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("chatguru_config")
    .eq("organization_id", orgId)
    .eq("id", channelSessionId)
    .maybeSingle();
  if (error || !data) return null;
  return lerConfigDoAtendimentoExterno((data as { chatguru_config: unknown }).chatguru_config);
}

/** A conversa (não de grupo) mais recente do contato NESTE número. */
async function conversaDoContatoNoNumero(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
  channelSessionId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("channel_session_id", channelSessionId)
    .eq("is_group", false)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { id: string }).id;
}

export async function tratarEquipeAssumiuDoPost(
  admin: SupabaseClient,
  input: {
    orgId: string;
    channelSessionId: string;
    corpo: Record<string, unknown> | null;
    requestId?: string;
  },
): Promise<DesfechoDoSinalDaEquipe> {
  // Sem campos personalizados no corpo não há sinal possível: nem lê a conexão.
  if (!input.corpo || input.corpo.campos_personalizados == null) return { reconhecido: false };
  let config: ConfigDoAtendimentoExterno | null = null;
  try {
    config = await configDaConexao(admin, input.orgId, input.channelSessionId);
  } catch {
    config = null;
  }
  // Sem configuração legível, não há como saber se era o sinal: o POST segue.
  if (!config || !ehSinalDeEquipeAssumiu(input.corpo, config)) return { reconhecido: false };

  // Daqui para baixo o POST JÁ é o sinal: falhar não o transforma em mensagem.
  try {
    const celular = textoDo(input.corpo.celular);
    const contato = celular ? await encontrarContatoPorTelefone(admin, input.orgId, celular) : null;
    if (!contato) return { reconhecido: true, status: "sem_contato" };

    const conversationId = await conversaDoContatoNoNumero(
      admin,
      input.orgId,
      contato.id,
      input.channelSessionId,
    );
    if (!conversationId) return { reconhecido: true, status: "sem_conversa" };

    const r = await equipeAssumiuRespondendo(admin, {
      organizationId: input.orgId,
      conversationId,
      origem: "plataforma",
      userId: null,
      requestId: input.requestId,
    });
    if (r.aplicado) return { reconhecido: true, status: "aplicado", cardMovidoPara: r.cardMovidoPara ?? null };
    if (r.motivo === "ja_assumida") return { reconhecido: true, status: "ja_assumida" };
    return { reconhecido: true, status: "nao_aplicado" };
  } catch (err) {
    logger.warn("[atendimento-externo] sinal de equipe assumiu não aplicado", {
      organization_id: input.orgId,
      channel_session_id: input.channelSessionId,
      detalhe: err instanceof Error ? err.message.slice(0, 160) : "erro",
    });
    return { reconhecido: true, status: "nao_aplicado" };
  }
}
