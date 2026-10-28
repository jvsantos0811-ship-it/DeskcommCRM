/**
 * A triagem dos negócios importados do histórico — antes de qualquer mensagem.
 *
 * A caixa de entrada de um escritório tem de tudo: cliente com processo em
 * andamento, gente que já disse não, fornecedor, família, spam — e quem parou
 * no meio da conversa, que é quem a recuperação procura. Mandar "ainda tem
 * interesse?" para cliente ativo ou para quem recusou é o erro que esta etapa
 * existe para evitar.
 *
 * Um modelo pequeno lê as ÚLTIMAS 7 mensagens de cada conversa (as duas
 * pontas, em ordem, com a data) e põe UMA etiqueta. Só `parou-no-meio` segue
 * para a recuperação; as outras ficam marcadas para a equipe decidir. Na
 * dúvida, a etiqueta mais cuidadosa ganha. O motivo, em uma frase, vai para a
 * linha do tempo do negócio — é por ali que a equipe confere por amostragem.
 *
 * O modelo não fala com ninguém: ele só etiqueta. Etiquetar não dispara regra
 * nem fluxo (o UPDATE de `tags` não emite evento no banco). A recuperação é
 * um gesto consciente do escritório, depois.
 *
 * Teto de gasto da organização respeitado (`podeGastarComIa`), e toda chamada
 * vira linha em `llm_calls`, com o custo, para aparecer em Uso de IA.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

import { podeGastarComIa } from "@/lib/ai/budget/pode-gastar";
import { computeCost } from "@/lib/ai/cost";
import { DEFAULT_CLASSIFIER_MODEL } from "@/lib/ai/gateway";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { registrarChamadaDeIa } from "@/lib/ai/usage/registrar-chamada";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";

import { trechoParaTriagem, type MensagemDoHistorico } from "./historico";

type Admin = SupabaseClient;

/** O id do ponto de IA (`lib/ai/pontos/registro.ts`). */
export const PONTO_DA_TRIAGEM = "triagem_de_historico";

export const CATEGORIAS = ["ja-cliente", "recusou", "parou-no-meio", "nao-e-lead"] as const;
export type Categoria = (typeof CATEGORIAS)[number];
/** Marca do negócio cuja triagem falhou: sai da fila da triagem e fica com a equipe. */
export const TAG_TRIAGEM_FALHOU = "triagem-falhou";
const JA_TRIADO = [...CATEGORIAS, TAG_TRIAGEM_FALHOU];

const LOTE = 20;
const TEMPO_LIMITE_MS = 20_000;

export const SISTEMA_DA_TRIAGEM = `Você classifica conversas antigas do WhatsApp de um escritório de advocacia, para decidir se a pessoa pode receber uma mensagem de retomada.

Você recebe as últimas mensagens da conversa, em ordem, com a data. CLIENTE é a pessoa; ESCRITÓRIO é a equipe do escritório. Escolha UMA categoria:

- ja-cliente: a pessoa já contratou o escritório ou tem caso ou processo em andamento (envia documentos para processo aberto, pergunta do andamento, audiência, perícia, pagamento já combinado).
- recusou: a pessoa disse que não quer, desistiu, escolheu outro escritório, achou caro, ou pediu para não receber mais mensagens.
- nao-e-lead: não é alguém procurando serviço jurídico — fornecedor, parceiro, colega, família, propaganda, spam, número errado, conversa pessoal.
- parou-no-meio: a pessoa procurou o escritório por um assunto jurídico, a conversa estava andando (dúvida, triagem, pedido de documento, agendamento) e parou sem contratar e sem recusar.

Regra de cuidado: na dúvida entre duas categorias, escolha a mais cuidadosa — ja-cliente, recusou ou nao-e-lead antes de parou-no-meio. É melhor deixar um contato para a equipe decidir do que mandar mensagem a quem não deveria.

Em "motivo", escreva uma frase curta (até 20 palavras) com a razão da escolha. Não copie dados pessoais (CPF, endereço, telefone, valores).`;

const esquema = z.object({
  categoria: z.enum(CATEGORIAS).describe("A categoria escolhida."),
  motivo: z.string().describe("Uma frase curta com a razão, sem dados pessoais."),
});

export interface Classificacao {
  categoria: Categoria;
  motivo: string;
  promptTokens: number;
  completionTokens: number;
}

export type Classificador = (model: LanguageModel, trecho: string) => Promise<Classificacao>;

export const classificarComModelo: Classificador = async (model, trecho) => {
  const r = await generateObject({
    model,
    schema: esquema,
    system: SISTEMA_DA_TRIAGEM,
    prompt: trecho,
    temperature: 0,
    maxOutputTokens: 300,
    abortSignal: AbortSignal.timeout(TEMPO_LIMITE_MS),
  });
  const usage = r.usage as { inputTokens?: number; outputTokens?: number } | undefined;
  return {
    categoria: r.object.categoria,
    motivo: r.object.motivo.replace(/\s+/g, " ").trim().slice(0, 200),
    promptTokens: usage?.inputTokens ?? 0,
    completionTokens: usage?.outputTokens ?? 0,
  };
};

interface LeadParaTriar {
  id: string;
  contact_id: string | null;
  tags: string[] | null;
  source_metadata: { conversation_id?: string } | null;
}

export interface ResultadoDaTriagem {
  contagens: Record<string, number>;
  /** Não sobrou nada para triar (ou não há como triar) — a importação pode concluir. */
  terminou: boolean;
}

async function etiquetar(admin: Admin, orgId: string, lead: LeadParaTriar, tag: string): Promise<void> {
  const tags = Array.from(new Set([...(lead.tags ?? []), tag]));
  const { error } = await admin.from("crm_leads").update({ tags }).eq("organization_id", orgId).eq("id", lead.id);
  if (error) throw new Error(`etiqueta_nao_gravada: ${error.message}`);
}

export async function triarLeadsImportados(
  admin: Admin,
  imp: { id: string; organization_id: string },
  orcamentoMs: number,
  deps: { agora: () => number },
  classificar: Classificador = classificarComModelo,
): Promise<ResultadoDaTriagem> {
  const inicio = deps.agora();
  const contagens: Record<string, number> = {};
  const somar = (k: string) => (contagens[k] = (contagens[k] ?? 0) + 1);

  const { data, error } = await admin
    .from("crm_leads")
    .select("id, contact_id, tags, source_metadata")
    .eq("organization_id", imp.organization_id)
    .eq("source", "importado_zernio")
    .eq("source_metadata->>importacao_id", imp.id)
    .eq("status", "open")
    .not("tags", "ov", `{${JA_TRIADO.join(",")}}`)
    .order("created_at", { ascending: true })
    .limit(LOTE);
  if (error) throw new Error(`triagem_leitura_falhou: ${error.message}`);
  const leads = (data ?? []) as LeadParaTriar[];
  if (leads.length === 0) return { contagens, terminou: true };

  const resolvido = await resolverModeloDoPonto(PONTO_DA_TRIAGEM, imp.organization_id, DEFAULT_CLASSIFIER_MODEL, {
    naFaltaUsarOPadraoDaOrganizacao: true,
  });
  if (!resolvido) {
    // Sem chave de IA: os negócios ficam com `lead-antigo` e a equipe decide.
    contagens.triagem_sem_ia = leads.length;
    return { contagens, terminou: true };
  }

  for (const lead of leads) {
    if (deps.agora() - inicio > orcamentoMs) break;

    const orcamento = await podeGastarComIa(imp.organization_id, PONTO_DA_TRIAGEM);
    if (!orcamento.pode) {
      contagens.triagem_parada_pelo_teto = 1;
      return { contagens, terminou: true };
    }

    const conversaId = lead.source_metadata?.conversation_id;
    const { data: msgs } = conversaId
      ? await admin
          .from("messages")
          .select("direction, sent_at, created_at, body, type")
          .eq("organization_id", imp.organization_id)
          .eq("conversation_id", conversaId)
          .neq("type", "reaction")
          .order("sent_at", { ascending: false, nullsFirst: false })
          .limit(7)
      : { data: [] };
    const linhas = ((msgs ?? []) as Array<{ direction: string; sent_at: string | null; created_at: string; body: string | null; type: string }>).map(
      (m) => ({
        direction: m.direction === "inbound" ? ("inbound" as const) : ("outbound" as const),
        sentAt: m.sent_at ?? m.created_at,
        body: m.body,
        type: m.type as MensagemDoHistorico["type"],
      }),
    );
    if (linhas.length === 0) {
      await etiquetar(admin, imp.organization_id, lead, TAG_TRIAGEM_FALHOU);
      somar("triagem_falhas");
      continue;
    }

    const t0 = Date.now();
    try {
      const c = await classificar(resolvido.model, trechoParaTriagem(linhas, 7));
      const custo = await computeCost({
        model: resolvido.modelId,
        promptTokens: c.promptTokens,
        completionTokens: c.completionTokens,
      });
      await registrarChamadaDeIa(admin as never, {
        organization_id: imp.organization_id,
        contact_id: lead.contact_id,
        purpose: "triagem_de_historico",
        model: resolvido.modelId,
        input_tokens: c.promptTokens,
        output_tokens: c.completionTokens,
        cost_cents: custo,
        latency_ms: Date.now() - t0,
      });
      await etiquetar(admin, imp.organization_id, lead, c.categoria);
      await emitLeadActivity(admin, {
        organizationId: imp.organization_id,
        leadId: lead.id,
        contactId: lead.contact_id,
        type: "note",
        sourceModule: "canal.importacao",
        sourceId: imp.id,
        actor: { type: "webhook_source", id: "triagem-de-historico" },
        reason: `Triagem da IA: ${c.categoria} — ${c.motivo}`,
        payload: { categoria: c.categoria, importacao_id: imp.id },
      });
      somar(`triagem_${c.categoria}`);
    } catch (err) {
      await registrarChamadaDeIa(admin as never, {
        organization_id: imp.organization_id,
        contact_id: lead.contact_id,
        purpose: "triagem_de_historico",
        model: resolvido.modelId,
        input_tokens: 0,
        output_tokens: 0,
        cost_cents: 0,
        latency_ms: Date.now() - t0,
        erro: { message: err instanceof Error ? err.message : String(err) },
      });
      await etiquetar(admin, imp.organization_id, lead, TAG_TRIAGEM_FALHOU);
      somar("triagem_falhas");
    }
  }
  return { contagens, terminou: false };
}
