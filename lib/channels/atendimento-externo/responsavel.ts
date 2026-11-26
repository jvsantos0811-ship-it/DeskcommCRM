/**
 * O RESPONSÁVEL PELO CHAT NA PLATAFORMA decide se a IA fala.
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * No canal em que a IA atende DENTRO de outra plataforma de atendimento
 * (ChatGuru, PC-047), a equipe responde o cliente LÁ. O sinal do PC-058
 * (`equipe-assumiu.ts`) depende de alguém executar um diálogo ao assumir: quem
 * esquece, deixa a IA falando por cima. E a plataforma não tem aviso de
 * "mensagem enviada pela equipe" — não há webhook disso.
 *
 * ─── O sinal que já vinha em todo POST ─────────────────────────────────────
 *
 * Cada "POST PARA URL" traz `responsavel_email` e `responsavel_nome`: quem é o
 * responsável pelo chat AGORA (medido na Samantha em 26/11/2026: o valor muda
 * no meio da conversa quando a equipe assume). O chat que a IA atende fica num
 * SETOR, sem pessoa responsável. Então, com `ia_so_sem_responsavel` ligado na
 * conexão:
 *
 *   - responsável PREENCHIDO = alguém da equipe está com o chat. O CRM aplica o
 *     mesmo efeito do PC-058 (a IA cala de forma durável, o contato fica só
 *     humano, agendadas caem, follow-up pausa, card vai para a etapa da equipe)
 *     ANTES de gravar a mensagem — que é gravada normalmente, porque é do
 *     cliente — e marca a conversa: foi a REGRA que calou;
 *   - responsável VAZIO numa conversa que a REGRA calou = o chat voltou ao setor
 *     (ex.: o diálogo do follow-up devolve ao setor da IA quando o cliente
 *     responde). A IA volta, pelo mesmo caminho do botão "Devolver"
 *     (`devolverAtendimentoAoAgente`, que respeita o "sempre humano").
 *
 * ─── O que NÃO acontece ────────────────────────────────────────────────────
 *
 *  - Responsável vazio numa conversa calada por OUTRO motivo (a IA passou para
 *    a equipe, alguém respondeu pelo CRM, "sempre humano"): nada muda. Só se
 *    desfaz o EPISÓDIO que esta regra começou: a marca guarda o
 *    `last_handoff_at` dele, e outro silêncio por cima (ou uma resposta de
 *    pessoa pelo CRM depois dele) a invalida.
 *  - Contato novo com responsável já preenchido: a IA cala, mas o negócio
 *    nasce depois (`aplicarEfeitosPosEntrada`), na etapa de entrada — o card
 *    não anda para a etapa da equipe nesse primeiro POST.
 *  - Chave desligada (padrão): o responsável é ignorado, como antes.
 *  - O nome e o e-mail do responsável não vão para log nem para o banco.
 *
 * Nunca lança: decidir a IA não pode derrubar a mensagem do cliente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { equipeAssumiuRespondendo } from "@/lib/escalacao/equipe-assumiu";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import { logger } from "@/lib/logger";

import { lerConfigDoAtendimentoExterno } from "./config";

/** Marca na conversa: foi a regra do responsável que calou a IA. */
export const MARCA_CALADA_PELO_RESPONSAVEL = "ia_calada_pelo_responsavel_da_plataforma";

function texto(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** O chat tem uma pessoa responsável na plataforma? Pura. */
export function temResponsavel(corpo: Record<string, unknown> | null): boolean {
  if (!corpo) return false;
  return texto(corpo.responsavel_email) !== null || texto(corpo.responsavel_nome) !== null;
}

export type DesfechoDoResponsavel =
  | "desligado"
  | "calou"
  | "ja_calada"
  | "devolveu"
  | "segue"
  | "nao_aplicado";

interface Conversa {
  metadata: Record<string, unknown>;
  caladaDeVez: boolean;
  lastHandoffAt: string | null;
  updatedAt: string | null;
}

async function lerConversa(
  admin: SupabaseClient,
  orgId: string,
  conversationId: string,
): Promise<Conversa | null> {
  const { data, error } = await admin
    .from("conversations")
    .select("metadata, bot_silenced_until, last_handoff_at, updated_at")
    .eq("organization_id", orgId)
    .eq("id", conversationId)
    .maybeSingle();
  if (error || !data) return null;
  const c = data as {
    metadata: Record<string, unknown> | null;
    bot_silenced_until: string | null;
    last_handoff_at: string | null;
    updated_at: string | null;
  };
  return {
    metadata: c.metadata ?? {},
    caladaDeVez: c.bot_silenced_until === "infinity",
    lastHandoffAt: c.last_handoff_at ?? null,
    updatedAt: c.updated_at ?? null,
  };
}

/** O episódio que a regra calou: o `last_handoff_at` gravado no momento. */
function episodioMarcado(metadata: Record<string, unknown>): string | null {
  const m = metadata[MARCA_CALADA_PELO_RESPONSAVEL];
  if (m && typeof m === "object" && typeof (m as { desde?: unknown }).desde === "string") {
    return (m as { desde: string }).desde;
  }
  return null;
}

/**
 * Grava (ou tira) a marca sem apagar o que outro POST escreveu no `metadata`
 * ao mesmo tempo: trava pelo `updated_at` lido, com uma nova tentativa.
 */
async function gravarMarca(
  admin: SupabaseClient,
  orgId: string,
  conversationId: string,
  desde: string | null,
): Promise<void> {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const atual = await lerConversa(admin, orgId, conversationId);
    if (!atual) return;
    const proximo = { ...atual.metadata };
    if (desde) proximo[MARCA_CALADA_PELO_RESPONSAVEL] = { desde };
    else delete proximo[MARCA_CALADA_PELO_RESPONSAVEL];
    let q = admin
      .from("conversations")
      .update({ metadata: proximo })
      .eq("organization_id", orgId)
      .eq("id", conversationId);
    if (atual.updatedAt) q = q.eq("updated_at", atual.updatedAt);
    const { data, error } = await q.select("id");
    if (!error && Array.isArray(data) && data.length > 0) return;
  }
}

/** Alguém da equipe escreveu pelo CRM depois que a regra calou? */
async function pessoaRespondeuPeloCrmDesde(
  admin: SupabaseClient,
  orgId: string,
  conversationId: string,
  desde: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("messages")
    .select("id")
    .eq("organization_id", orgId)
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .not("sent_by_user_id", "is", null)
    .gte("created_at", desde)
    .limit(1)
    .maybeSingle();
  // Na dúvida, não devolve: calar por engano é melhor que falar por cima.
  return error !== null || data !== null;
}

/**
 * Aplica a regra numa conversa, ANTES de a mensagem do cliente ser gravada.
 * A organização e a conexão vêm de quem chama (token e segredo), nunca do corpo.
 */
export async function aplicarRegraDoResponsavel(
  admin: SupabaseClient,
  input: {
    orgId: string;
    channelSessionId: string;
    conversationId: string;
    corpo: Record<string, unknown> | null;
    ligado: boolean;
    requestId?: string;
  },
): Promise<DesfechoDoResponsavel> {
  if (!input.ligado) return "desligado";
  try {
    const conversa = await lerConversa(admin, input.orgId, input.conversationId);
    if (!conversa) return "nao_aplicado";

    if (temResponsavel(input.corpo)) {
      const jaEstavaCalada = conversa.caladaDeVez;
      const r = await equipeAssumiuRespondendo(admin, {
        organizationId: input.orgId,
        conversationId: input.conversationId,
        origem: "plataforma",
        userId: null,
        requestId: input.requestId,
      });
      if (r.aplicado) {
        // Só é "da regra" o silêncio que ELA começou. Calada antes por outro
        // motivo (passagem da IA, sempre humano), o vazio depois não a solta.
        if (!jaEstavaCalada) {
          const depois = await lerConversa(admin, input.orgId, input.conversationId);
          if (depois?.lastHandoffAt) {
            await gravarMarca(admin, input.orgId, input.conversationId, depois.lastHandoffAt);
          }
        }
        return "calou";
      }
      return r.motivo === "ja_assumida" ? "ja_calada" : "nao_aplicado";
    }

    // Sem responsável: só desfaz o episódio que ESTA regra começou.
    const desde = episodioMarcado(conversa.metadata);
    if (!desde) return "segue";
    const mesmoEpisodio = conversa.caladaDeVez && conversa.lastHandoffAt === desde;
    if (!mesmoEpisodio || (await pessoaRespondeuPeloCrmDesde(admin, input.orgId, input.conversationId, desde))) {
      // Outro silêncio por cima (devolvida pela tela e passada de novo, ou uma
      // pessoa respondeu pelo CRM): a marca sobrou. Limpa e não devolve.
      await gravarMarca(admin, input.orgId, input.conversationId, null);
      return "segue";
    }
    const d = await devolverAtendimentoAoAgente(
      {
        supabase: admin,
        organizationId: input.orgId,
        actor: { type: "webhook_source", id: input.channelSessionId },
        requestId: input.requestId ?? "atendimento-externo-responsavel",
      },
      // A mensagem do cliente entra logo depois e acorda a IA por si: acordar
      // aqui responderia à mensagem ANTERIOR.
      { conversationId: input.conversationId, acordarIa: false },
    );
    if (!d.ok) return "nao_aplicado";
    await gravarMarca(admin, input.orgId, input.conversationId, null);
    return "devolveu";
  } catch (err) {
    logger.warn("[atendimento-externo] regra do responsável não aplicada", {
      organization_id: input.orgId,
      channel_session_id: input.channelSessionId,
      detalhe: err instanceof Error ? err.message.slice(0, 160) : "erro",
    });
    return "nao_aplicado";
  }
}

/** A chave da conexão está ligada? Falha de leitura = desligada (o de antes). */
export async function regraDoResponsavelLigada(
  admin: SupabaseClient,
  orgId: string,
  channelSessionId: string,
): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from("channel_sessions")
      .select("chatguru_config")
      .eq("organization_id", orgId)
      .eq("id", channelSessionId)
      .maybeSingle();
    if (error || !data) return false;
    return lerConfigDoAtendimentoExterno((data as { chatguru_config: unknown }).chatguru_config)
      .iaSoSemResponsavel;
  } catch {
    return false;
  }
}
