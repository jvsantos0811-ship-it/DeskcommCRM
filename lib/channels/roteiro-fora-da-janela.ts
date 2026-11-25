/**
 * O ROTEIRO FORA DA JANELA (PC-052 parte 3).
 *
 * Fora da janela de 24 h do cliente, o canal que atende DENTRO de outra
 * plataforma de atendimento não deixa o CRM mandar texto livre — e também não
 * deixa mandar modelo da Meta pela API. O caminho que a plataforma oferece é
 * executar um DIÁLOGO da conta, que manda o modelo aprovado dela. O operador
 * escolhe, na tela da conexão, um diálogo POR USO (a confirmação da véspera, a do
 * dia, o lembrete); quem envia pede pelo uso, nunca por um id.
 *
 * Este módulo é a borda: quem chama (o cron de lembrete, o da sequência depois de
 * marcar) não sabe nem pergunta qual plataforma é. Ele responde duas perguntas:
 *
 *  - `canaisComRoteiro` — destas conexões, quais têm diálogo para este uso? É o
 *    que deixa a escolha do remetente aceitar a conexão com a janela fechada.
 *  - `enviarRoteiroForaDaJanela` — executa o diálogo do uso no chat da conversa.
 *
 * Falha de leitura é "nenhum roteiro" (fail-closed): na dúvida, não manda.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { chamarApi } from "./atendimento-externo/api";
import {
  lerConfigDoAtendimentoExterno,
  USOS_FORA_DA_JANELA,
  type UsoForaDaJanela,
} from "./atendimento-externo/config";
import { resolverCredenciais } from "./atendimento-externo/credenciais";
import { CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO } from "./capabilities";

export { USOS_FORA_DA_JANELA, type UsoForaDaJanela };
export { falaPorRoteiro } from "./fala-por-roteiro";

function soDigitos(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

/**
 * Das conexões dadas, as que têm um diálogo escolhido para este uso. Só a
 * organização pedida; leitura que falha devolve vazio.
 */
export async function canaisComRoteiro(
  admin: SupabaseClient,
  organizationId: string,
  canais: ReadonlyArray<{ id: string; provider: string | null }>,
  uso: UsoForaDaJanela,
): Promise<Set<string>> {
  const ids = canais.filter((c) => c.provider === CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO).map((c) => c.id);
  if (ids.length === 0) return new Set();
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, chatguru_config")
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO)
    .in("id", ids);
  if (error) return new Set();
  const comRoteiro = new Set<string>();
  for (const linha of (data ?? []) as { id: string; chatguru_config: unknown }[]) {
    if (lerConfigDoAtendimentoExterno(linha.chatguru_config).roteirosForaDaJanela[uso]) comRoteiro.add(linha.id);
  }
  return comRoteiro;
}

export type DesfechoDoRoteiro =
  | { ok: true }
  /** `sem_roteiro`: a conexão não tem diálogo para o uso (ou não é deste tipo). */
  | { ok: false; motivo: "sem_roteiro" | "conversa_invalida" | "sem_credencial" | "sem_numero" | "falhou"; detalhe?: string };

/**
 * Executa, no chat desta conversa, o diálogo escolhido para o uso. A conversa,
 * a conexão e o contato são lidos DENTRO da organização pedida. Não lança: a
 * recusa da plataforma volta como `falhou`, com o motivo já sem dígitos longos
 * (o `chamarApi` mascara).
 */
export async function enviarRoteiroForaDaJanela(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; conversationId: string; uso: UsoForaDaJanela },
  deps: { fetch?: typeof fetch } = {},
): Promise<DesfechoDoRoteiro> {
  try {
    const { data: conversa, error: erroConversa } = await admin
      .from("conversations")
      .select("id, channel_session_id, provider_conversation_id, contact_id")
      .eq("organization_id", input.organizationId)
      .eq("id", input.conversationId)
      .maybeSingle();
    if (erroConversa || !conversa || conversa.channel_session_id !== input.channelSessionId) {
      return { ok: false, motivo: "conversa_invalida" };
    }
    const { data: sessao, error: erroSessao } = await admin
      .from("channel_sessions")
      .select("provider, chatguru_phone_id")
      .eq("organization_id", input.organizationId)
      .eq("id", input.channelSessionId)
      .maybeSingle();
    if (erroSessao || !sessao || sessao.provider !== CHANNEL_PROVIDER_ATENDIMENTO_EXTERNO || !sessao.chatguru_phone_id) {
      return { ok: false, motivo: "sem_roteiro" };
    }
    const creds = await resolverCredenciais(admin, {
      organizationId: input.organizationId,
      phoneId: sessao.chatguru_phone_id as string,
    });
    if (!creds) return { ok: false, motivo: "sem_credencial" };
    const dialogo = creds.config.roteirosForaDaJanela[input.uso];
    if (!dialogo) return { ok: false, motivo: "sem_roteiro" };

    let numero = soDigitos(conversa.provider_conversation_id as string | null);
    if (numero.length < 10 && conversa.contact_id) {
      const { data: contato } = await admin
        .from("contacts")
        .select("phone_number")
        .eq("organization_id", input.organizationId)
        .eq("id", conversa.contact_id)
        .maybeSingle();
      numero = soDigitos((contato as { phone_number?: string | null } | null)?.phone_number);
    }
    if (numero.length < 10) return { ok: false, motivo: "sem_numero" };

    await chamarApi(creds, "dialog_execute", { chat_number: numero, dialog_id: dialogo }, deps);
    return { ok: true };
  } catch (err) {
    return { ok: false, motivo: "falhou", detalhe: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}
