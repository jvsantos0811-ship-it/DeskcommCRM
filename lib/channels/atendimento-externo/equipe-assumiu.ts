/**
 * A EQUIPE ASSUMIU DENTRO DA PLATAFORMA (PC-058).
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
 *   1. grava no `campo_da_ia` o `valor_quando_equipe_assume` da conexão (ex.:
 *      `assumido`) — PRÓPRIO, diferente do `valor_ao_passar` que o CRM grava
 *      sozinho na passagem da IA (achado da revisão: com o mesmo valor, um
 *      diálogo de entrega sem a condição "campo ≠ valor" faria cada mensagem
 *      seguinte do lead ser lida como sinal e descartada);
 *   2. faz o "POST PARA URL" para a entrada deste canal.
 *
 * Esse POST carrega `campos_personalizados.<campo_da_ia> = <valor_quando_equipe_assume>`.
 *
 * Segunda forma (preferida quando preenchida): `variavel_quando_equipe_assume`.
 * O diálogo grava uma VARIÁVEL DE CONTEXTO (ex.: `LSIA = assumido`), e a
 * plataforma manda o contexto inteiro em todo POST, dentro de `bot_context`.
 * Medido no POST real do ChatGuru: `bot_context` é um objeto com as variáveis
 * do chat. Com a variável preenchida, o `campo_da_ia` não entra na conta.
 * Com esse valor preenchido na conexão, é ele que
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
 *  - Valor vazio (padrão), conexão sem `campo_da_ia`, ou valor igual ao da passagem:
 *    nada muda, o POST é lido como sempre.
 *  - O valor que FICOU gravado no chat depois do sinal: só a TRANSIÇÃO é
 *    sinal. O primeiro POST com o valor é consumido (marca na conversa); os
 *    seguintes com o mesmo valor são conversa normal. Um POST com outro valor
 *    rearma a transição.
 *    Limites aceitos: dois POSTs simultâneos com o valor podem ser lidos os dois
 *    como sinal (o efeito não duplica; o texto do segundo não é gravado); e,
 *    ao ligar a opção, um chat que já tinha o valor perde um POST.
 *  - Contato ou conversa que o CRM não conhece (cliente antigo, que nunca
 *    passou pela IA): nada é criado. O sinal é reconhecido e descartado — e,
 *    sem conversa onde guardar a marca, todo POST desse chat com o valor
 *    também é descartado até a fonte mudar de valor.
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

type ConfigDoSinal = Pick<
  ConfigDoAtendimentoExterno,
  "campoDaIa" | "valorQuandoEquipeAssume" | "variavelQuandoEquipeAssume"
>;

/**
 * O valor que a fonte do sinal traz neste POST, qualquer que seja. Pura.
 * `null` = sinal desligado, fonte ausente no POST, ou configuração que nunca
 * pode ser sinal (valor igual ao da passagem, pelo campo da IA).
 */
export function valorDaFonteDoSinal(corpo: Record<string, unknown> | null, config: ConfigDoSinal): string | null {
  if (!corpo) return null;
  const esperado = sem(config.valorQuandoEquipeAssume ?? "");
  if (!esperado) return null;
  if (config.variavelQuandoEquipeAssume) return valorDoContexto(corpo, config.variavelQuandoEquipeAssume);
  if (!config.campoDaIa) return null;
  if (esperado === sem(config.campoDaIa.valorAoPassar ?? "")) return null;
  return valorDoCampo(corpo, `campos_personalizados.${config.campoDaIa.nome}`);
}

/**
 * O POST TRAZ o valor de "a equipe assumiu"? Pura. Trazer não basta para ser
 * sinal: a variável (ou o campo) fica gravada no chat e chega em todo POST
 * seguinte. Quem decide se é a TRANSIÇÃO é `tratarEquipeAssumiuDoPost`.
 *
 * Pela variável de contexto, o `campo_da_ia` não entra na conta. Pelo campo,
 * exige `campo_da_ia` e um valor DIFERENTE do `valor_ao_passar` (a tela já
 * recusa igual; a regra não confia só nela). Compara sem acento e sem caixa.
 */
export function ehSinalDeEquipeAssumiu(corpo: Record<string, unknown> | null, config: ConfigDoSinal): boolean {
  const valor = valorDaFonteDoSinal(corpo, config);
  return valor !== null && sem(valor) === sem(config.valorQuandoEquipeAssume ?? "");
}

/** `bot_context` do POST: objeto, ou JSON em texto. Ilegível = sem contexto. */
function contextoDoPost(corpo: Record<string, unknown>): Record<string, unknown> {
  const bruto = corpo.bot_context;
  if (bruto && typeof bruto === "object" && !Array.isArray(bruto)) return bruto as Record<string, unknown>;
  if (typeof bruto === "string" && bruto.trim().startsWith("{")) {
    try {
      const p = JSON.parse(bruto) as unknown;
      if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
    } catch {
      // segue sem contexto
    }
  }
  return {};
}

/** Valor de uma variável de contexto do POST. Pura. */
export function valorDoContexto(corpo: Record<string, unknown>, nome: string): string | null {
  return textoDo(contextoDoPost(corpo)[nome]);
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
): Promise<{ id: string; metadata: Record<string, unknown> } | null> {
  const { data, error } = await admin
    .from("conversations")
    .select("id, metadata")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("channel_session_id", channelSessionId)
    .eq("is_group", false)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const linha = data as { id: string; metadata: unknown };
  const metadata =
    linha.metadata && typeof linha.metadata === "object" && !Array.isArray(linha.metadata)
      ? (linha.metadata as Record<string, unknown>)
      : {};
  return { id: linha.id, metadata };
}

/**
 * Marca, na conversa, que o valor de "a equipe assumiu" já foi CONSUMIDO
 * (`true`) ou que a fonte voltou a outro valor (`false`). É o que separa a
 * transição (sinal) do valor que ficou gravado no chat (conversa normal).
 * Mora só aqui: ninguém mais lê esta chave.
 */
const CHAVE_DO_SINAL_CONSUMIDO = "equipe_assumiu_na_plataforma_consumido";

async function marcarSinalConsumido(
  admin: SupabaseClient,
  orgId: string,
  conversa: { id: string; metadata: Record<string, unknown> },
  consumido: boolean,
): Promise<void> {
  const { error } = await admin
    .from("conversations")
    .update({ metadata: { ...conversa.metadata, [CHAVE_DO_SINAL_CONSUMIDO]: consumido } })
    .eq("organization_id", orgId)
    .eq("id", conversa.id);
  // Sem a marca, o próximo POST com o valor seria lido como sinal de novo: avisa.
  if (error) {
    logger.warn("[atendimento-externo] marca do sinal de equipe assumiu não gravada", {
      organization_id: orgId,
      consumido,
      detalhe: error.message.slice(0, 160),
    });
  }
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
  // Sem campos personalizados nem contexto no corpo não há sinal possível: nem lê a conexão.
  if (!input.corpo || (input.corpo.campos_personalizados == null && input.corpo.bot_context == null)) {
    return { reconhecido: false };
  }
  let config: ConfigDoAtendimentoExterno | null = null;
  try {
    config = await configDaConexao(admin, input.orgId, input.channelSessionId);
  } catch {
    config = null;
  }
  // Sem configuração legível, não há como saber se era o sinal: o POST segue.
  if (!config) return { reconhecido: false };
  const valor = valorDaFonteDoSinal(input.corpo, config);
  // Sinal desligado ou fonte ausente neste POST: o caminho de sempre, sem mais leitura.
  if (valor === null) return { reconhecido: false };
  const trazOValor = ehSinalDeEquipeAssumiu(input.corpo, config);

  // POST que traz OUTRO valor: nunca é sinal. Só rearma a transição se ela
  // tinha sido consumida. Qualquer falha aqui é silenciosa: o POST segue.
  if (!trazOValor) {
    try {
      const celular = textoDo(input.corpo.celular);
      const contato = celular ? await encontrarContatoPorTelefone(admin, input.orgId, celular) : null;
      const conversa = contato
        ? await conversaDoContatoNoNumero(admin, input.orgId, contato.id, input.channelSessionId)
        : null;
      if (conversa && conversa.metadata[CHAVE_DO_SINAL_CONSUMIDO] === true) {
        await marcarSinalConsumido(admin, input.orgId, conversa, false);
      }
    } catch {
      // o rearme fica para o próximo POST
    }
    return { reconhecido: false };
  }

  // Daqui para baixo o POST TRAZ o valor. Falhar não o transforma em mensagem.
  try {
    const celular = textoDo(input.corpo.celular);
    const contato = celular ? await encontrarContatoPorTelefone(admin, input.orgId, celular) : null;
    if (!contato) return { reconhecido: true, status: "sem_contato" };

    const conversa = await conversaDoContatoNoNumero(admin, input.orgId, contato.id, input.channelSessionId);
    if (!conversa) return { reconhecido: true, status: "sem_conversa" };

    // O valor continua gravado no chat desde o sinal anterior: este POST é uma
    // mensagem de verdade (do lead) e segue o caminho de sempre. Achado da
    // revisão independente: sem isto, toda mensagem seguinte sumiria do CRM e,
    // com a conversa retomada, a IA seria calada de novo a cada POST.
    if (conversa.metadata[CHAVE_DO_SINAL_CONSUMIDO] === true) return { reconhecido: false };
    const conversationId = conversa.id;

    const r = await equipeAssumiuRespondendo(admin, {
      organizationId: input.orgId,
      conversationId,
      origem: "plataforma",
      userId: null,
      requestId: input.requestId,
    });
    // A marca só depois do efeito: se ele falhar, o próximo POST com o valor
    // tenta de novo em vez de o sinal se perder.
    if (r.aplicado) {
      await marcarSinalConsumido(admin, input.orgId, conversa, true);
      return { reconhecido: true, status: "aplicado", cardMovidoPara: r.cardMovidoPara ?? null };
    }
    if (r.motivo === "ja_assumida") {
      await marcarSinalConsumido(admin, input.orgId, conversa, true);
      return { reconhecido: true, status: "ja_assumida" };
    }
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
