import type { SupabaseClient } from "@supabase/supabase-js";

import { capabilitiesOf, transportaMensagem } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";
import { canalAceitaTextoLivreAgora } from "@/lib/channels/janela";
import { canaisComRoteiro, type UsoForaDaJanela } from "@/lib/channels/roteiro-fora-da-janela";

export interface CanalDoLembrete {
  id: string;
  provider: string | null;
  status: string;
  archived_at: string | null;
  metadata?: { disabled?: boolean } | null;
  lastInboundAt: string | null;
}

export type MotivoSemRemetente =
  | "falha_ao_ler_remetente"
  | "conversa_do_compromisso_invalida"
  | "canal_indicado_indisponivel"
  | "canal_fora_da_janela_24h"
  | "sem_canal"
  | "remetente_ambiguo";
/**
 * `foraDaJanela` = o canal só serve porque há como falar fora da janela de 24 h:
 * texto livre não sai. `via` diz como — `modelo`: o MODELO da Meta do tipo
 * (PC-045); `roteiro`: o diálogo que a conexão escolheu para este uso (PC-052).
 */
export type RemetenteDoLembrete =
  | { canal: CanalDoLembrete; motivo: null; foraDaJanela?: boolean; via?: "modelo" | "roteiro" }
  | { canal: null; motivo: MotivoSemRemetente };

/**
 * Provedor que manda modelo aprovado da Meta fora da janela de 24 h — a régua
 * é a capacidade do canal (`requiresTemplates`), não uma lista de nomes.
 */
export function mandaModeloDaMeta(provider: string | null): boolean {
  if (!provider || !transportaMensagem(provider)) return false;
  try {
    return capabilitiesOf(provider as ChannelProvider).requiresTemplates === true;
  } catch {
    return false;
  }
}

/** Um vínculo é autoridade, não preferência: indisponível nunca libera outro número. */
export function decidirRemetenteDoLembrete(
  canais: CanalDoLembrete[],
  canalIndicadoId: string | null,
  agora: Date,
  /** PC-045: o tipo tem modelo da Meta — canal oficial fora da janela serve. */
  comModeloDaMeta = false,
  /** PC-052: conexões com diálogo escolhido para este uso — servem fora da janela. */
  comRoteiro: ReadonlySet<string> = new Set(),
): RemetenteDoLembrete {
  const decisao = decidirSoTextoLivre(canais, canalIndicadoId, agora);
  if (
    decisao.canal ||
    decisao.motivo !== "canal_fora_da_janela_24h" ||
    (!comModeloDaMeta && comRoteiro.size === 0)
  ) {
    return decisao;
  }
  // Fora da janela: só o canal que tem COMO falar fora dela, e com a MESMA régua
  // de antes — o indicado não libera outro número, e no automático só um elegível.
  const pormodelo = (c: CanalDoLembrete) => comModeloDaMeta && mandaModeloDaMeta(c.provider);
  const operante = (c: CanalDoLembrete) =>
    c.status === "WORKING" &&
    !c.archived_at &&
    c.metadata?.disabled !== true &&
    transportaMensagem(c.provider) &&
    (pormodelo(c) || comRoteiro.has(c.id));
  const via = (c: CanalDoLembrete): "modelo" | "roteiro" => (pormodelo(c) ? "modelo" : "roteiro");
  if (canalIndicadoId) {
    const canal = canais.find((c) => c.id === canalIndicadoId);
    return canal && operante(canal)
      ? { canal, motivo: null, foraDaJanela: true, via: via(canal) }
      : { canal: null, motivo: "canal_fora_da_janela_24h" };
  }
  const candidatos = canais.filter(operante);
  if (candidatos.length > 1) return { canal: null, motivo: "remetente_ambiguo" };
  const unico = candidatos[0];
  return unico
    ? { canal: unico, motivo: null, foraDaJanela: true, via: via(unico) }
    : { canal: null, motivo: "canal_fora_da_janela_24h" };
}

function decidirSoTextoLivre(
  canais: CanalDoLembrete[],
  canalIndicadoId: string | null,
  agora: Date,
): RemetenteDoLembrete {
  const operante = (c: CanalDoLembrete) =>
    c.status === "WORKING" &&
    !c.archived_at &&
    c.metadata?.disabled !== true &&
    transportaMensagem(c.provider);
  if (canalIndicadoId) {
    const canal = canais.find((c) => c.id === canalIndicadoId);
    if (!canal || !operante(canal)) return { canal: null, motivo: "canal_indicado_indisponivel" };
    return canalAceitaTextoLivreAgora(canal.provider, canal.lastInboundAt, agora)
      ? { canal, motivo: null }
      : { canal: null, motivo: "canal_fora_da_janela_24h" };
  }
  const candidatos = canais
    .filter(operante)
    .filter((c) => canalAceitaTextoLivreAgora(c.provider, c.lastInboundAt, agora));
  if (candidatos.length > 1) return { canal: null, motivo: "remetente_ambiguo" };
  const unico = candidatos[0];
  if (candidatos.length === 1 && unico) return { canal: unico, motivo: null };
  return { canal: null, motivo: canais.some(operante) ? "canal_fora_da_janela_24h" : "sem_canal" };
}

/** Leitura sempre recortada à organização E ao contato da reserva. Falha não é ausência. */
export async function resolverRemetenteDoLembrete(
  admin: SupabaseClient,
  compromisso: { organization_id: string; contact_id: string; conversation_id?: string | null },
  canalDoTipoId: string | null,
  agora: Date,
  comModeloDaMeta = false,
  /** PC-052: o uso cujo diálogo de conexão serve fora da janela (ex.: `lembrete`). */
  usoDoRoteiro: UsoForaDaJanela | null = null,
): Promise<RemetenteDoLembrete> {
  const org = compromisso.organization_id;
  let indicado = canalDoTipoId;
  if (!indicado && compromisso.conversation_id) {
    const { data, error } = await admin
      .from("conversations")
      .select("channel_session_id")
      .eq("id", compromisso.conversation_id)
      .eq("organization_id", org)
      .eq("contact_id", compromisso.contact_id)
      .maybeSingle();
    if (error) return { canal: null, motivo: "falha_ao_ler_remetente" };
    if (!data?.channel_session_id)
      return { canal: null, motivo: "conversa_do_compromisso_invalida" };
    indicado = data.channel_session_id;
  }
  // O automático lê os candidatos e confere a contagem total: uma lista
  // truncada não pode provar que só existe um remetente.
  let query = admin
    .from("channel_sessions")
    .select("id, provider, status, archived_at, metadata", { count: "exact" })
    .eq("organization_id", org);
  if (indicado) query = query.eq("id", indicado);
  else query = query.eq("status", "WORKING").is("archived_at", null);
  const { data, error, count } = await query;
  if (error) return { canal: null, motivo: "falha_ao_ler_remetente" };
  // PostgREST pode cortar por max_rows. Lista parcial nunca prova remetente único.
  if (!indicado && count != null && count > (data?.length ?? 0)) {
    return { canal: null, motivo: "remetente_ambiguo" };
  }
  const canais: CanalDoLembrete[] = (data ?? []).map((c) => ({ ...c, lastInboundAt: null }));
  const restritos = canais.filter(
    (c) => transportaMensagem(c.provider) && !canalAceitaTextoLivreAgora(c.provider, null, agora),
  );
  if (restritos.length) {
    const { data: conversas, error: erro } = await admin
      .from("conversations")
      .select("channel_session_id, last_inbound_at")
      .eq("organization_id", org)
      .eq("contact_id", compromisso.contact_id)
      .in(
        "channel_session_id",
        restritos.map((c) => c.id),
      );
    if (erro) return { canal: null, motivo: "falha_ao_ler_remetente" };
    for (const conversa of conversas ?? []) {
      const canal = canais.find((c) => c.id === conversa.channel_session_id);
      if (
        canal &&
        conversa.last_inbound_at &&
        (!canal.lastInboundAt || conversa.last_inbound_at > canal.lastInboundAt)
      ) {
        canal.lastInboundAt = conversa.last_inbound_at;
      }
    }
  }
  const primeira = decidirRemetenteDoLembrete(canais, indicado, agora, comModeloDaMeta);
  if (primeira.canal || primeira.motivo !== "canal_fora_da_janela_24h" || !usoDoRoteiro) return primeira;
  // Só pergunta pelos diálogos quando a janela fechou — a leitura extra é do
  // caso raro, não de toda rodada.
  const comRoteiro = await canaisComRoteiro(admin, org, canais, usoDoRoteiro);
  return decidirRemetenteDoLembrete(canais, indicado, agora, comModeloDaMeta, comRoteiro);
}
