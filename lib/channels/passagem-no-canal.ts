/**
 * O lado do CANAL de uma conversa que mora dentro de outra plataforma de
 * atendimento (PC-047): a passagem para a equipe e as ações da IA lá dentro.
 *
 * A passagem é decidida e gravada no CRM (`performHumanHandoff`: trava no
 * contato, conversa fora do automático, aviso na Central). Na maioria dos canais
 * isso basta, porque a conversa só existe aqui. No canal em que ela mora DENTRO
 * de outra plataforma, o chat continua marcado como "da IA" até alguém dizer o
 * contrário — a equipe não vê que é a vez dela, e a plataforma continua
 * entregando cada mensagem para cá.
 *
 * Este módulo faz a outra metade sem perguntar QUAL canal é: lê a sessão da
 * conversa, pede o adapter e usa o que ele souber fazer
 * (`aoPassarParaAEquipe`, `acoesDoAtendimento`). Canal que não sabe responde
 * "nada a fazer".
 *
 * ─── Nunca derruba quem chama ───────────────────────────────────────────────
 *
 * A passagem no CRM já aconteceu quando `avisarCanalDaPassagem` roda. Falha
 * aqui vira desfecho `falhou` (o chamador registra no log), nunca exceção: e há
 * teto de tempo — a plataforma lenta não segura o turno.
 */
import { getAdapter } from "./index";
import { transportaMensagem } from "./capabilities";
import { resolveSessionRef, type ChannelSessionRef } from "./session-ref";
import type { AcoesDoAtendimento, ChannelAdapter, ChannelProvider } from "./types";

/** O mínimo de um pool/cliente pg — para não amarrar este módulo ao motor. */
export interface ConsultaPg {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

export type DesfechoDaPassagemNoCanal =
  | { desfecho: "sem_acao" }
  | { desfecho: "feito" }
  | { desfecho: "falhou"; motivo: string };

const TEMPO_LIMITE_MS = 15_000;

interface LinhaDaConversa {
  provider: string;
  waha_session_name: string | null;
  meta_phone_number_id: string | null;
  zernio_account_id: string | null;
  datafy_phone_number_id: string | null;
  chatguru_phone_id: string | null;
  provider_conversation_id: string | null;
  phone_number: string | null;
  is_group: boolean;
}

interface CanalDaConversa {
  adapter: ChannelAdapter;
  sessionRef: string;
  recipient: string | null;
}

/**
 * O adapter, o `sessionRef` e o endereço do chat desta conversa — tudo escopado
 * pela organização. `null` quando a conversa não existe ou o canal não é de
 * mensagem. O endereço prefere `provider_conversation_id` (o número como a
 * plataforma o tem) ao derivado do contato.
 */
async function canalDaConversa(
  db: ConsultaPg,
  organizationId: string,
  conversationId: string,
): Promise<CanalDaConversa | null> {
  const { rows } = await db.query(
    `select cs.provider, cs.waha_session_name, cs.meta_phone_number_id, cs.zernio_account_id,
            cs.datafy_phone_number_id, cs.chatguru_phone_id,
            c.provider_conversation_id, ct.phone_number, c.is_group
       from conversations c
       join channel_sessions cs on cs.id = c.channel_session_id and cs.organization_id = c.organization_id
       join contacts ct on ct.id = c.contact_id and ct.organization_id = c.organization_id
      where c.organization_id = $1 and c.id = $2`,
    [organizationId, conversationId],
  );
  const linha = rows[0] as LinhaDaConversa | undefined;
  if (!linha || !transportaMensagem(linha.provider)) return null;

  const adapter = getAdapter(linha.provider as ChannelProvider);
  const recipient =
    linha.provider_conversation_id ??
    adapter.resolveRecipient({
      isGroup: linha.is_group,
      groupChatId: null,
      phoneNumber: linha.phone_number,
      waIdentity: null,
    });
  return { adapter, sessionRef: resolveSessionRef(linha as unknown as ChannelSessionRef), recipient };
}

async function comTeto<T>(promessa: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(new Error("tempo_esgotado")), TEMPO_LIMITE_MS);
  });
  try {
    return await Promise.race([promessa, limite]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Devolve o chat à equipe na plataforma do canal, quando o canal souber.
 *
 * `nota` é o texto curto que a equipe lê lá (o resumo da passagem), ou `null`.
 */
export async function avisarCanalDaPassagem(
  db: ConsultaPg,
  input: { organizationId: string; conversationId: string; nota: string | null },
): Promise<DesfechoDaPassagemNoCanal> {
  try {
    const canal = await canalDaConversa(db, input.organizationId, input.conversationId);
    if (!canal?.adapter.aoPassarParaAEquipe) return { desfecho: "sem_acao" };
    if (!canal.recipient) return { desfecho: "falhou", motivo: "conversa_sem_endereco_no_canal" };
    await comTeto(
      canal.adapter.aoPassarParaAEquipe({
        organizationId: input.organizationId,
        sessionRef: canal.sessionRef,
        recipient: canal.recipient,
        nota: input.nota,
      }),
    );
    return { desfecho: "feito" };
  } catch (err) {
    const motivo = err instanceof Error ? err.message : "erro_desconhecido";
    return { desfecho: "falhou", motivo: motivo.slice(0, 300) };
  }
}

/**
 * As ações que a IA pode executar na plataforma do canal NESTE turno, já
 * amarradas ao chat da conversa. `null` = nada a oferecer (canal que não sabe,
 * sem credencial, conversa sem endereço, ou a consulta falhou — ferramenta
 * faltando é melhor que turno derrubado).
 */
export async function acoesDoAtendimentoNoTurno(
  db: ConsultaPg,
  input: { organizationId: string; conversationId: string },
): Promise<AcoesDoAtendimento | null> {
  try {
    const canal = await canalDaConversa(db, input.organizationId, input.conversationId);
    if (!canal?.adapter.acoesDoAtendimento || !canal.recipient) return null;
    return await comTeto(
      canal.adapter.acoesDoAtendimento({
        organizationId: input.organizationId,
        sessionRef: canal.sessionRef,
        recipient: canal.recipient,
      }),
    );
  } catch {
    return null;
  }
}
