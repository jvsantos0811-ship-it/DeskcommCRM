/**
 * O FUNIL DE CADA NÚMERO — leitura e gravação para a tela e para a porta Admin.
 *
 * Cada conexão (`channel_sessions`) decide se a conversa nova que chega por ela
 * abre card no funil e em qual funil/etapa (migration 9025). Quem APLICA a
 * regra é `garantirLeadDaConversa` (`lib/leads/nascimento-do-lead.ts`); este
 * arquivo é a porta de quem CONFIGURA:
 *
 *   - `retratoDoFunilDoNumero` — o que a tela e a porta Admin mostram: o
 *     ajuste, ONDE os cards nascem hoje (perguntado a `destinoDoNumero`, a
 *     mesma função que o nascimento usa — a tela não reimplementa a regra) e o
 *     aviso quando o funil escolhido foi arquivado;
 *   - `gravarFunilDoNumero` — confere que funil e etapa são da MESMA empresa,
 *     estão abertos e combinam entre si, e grava. A FK composta da 9025 já
 *     recusa funil de outra empresa; a conferência aqui é para devolver uma
 *     frase que a pessoa entende em vez de um erro de banco.
 *
 * Um lugar só para as duas portas (tela e porta Admin do Operador): se a regra
 * de validação morasse em cada uma, a primeira correção faria as duas
 * divergirem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  destinoDoNumero,
  type AvisoDoFunilDoNumero,
  type FunilDoNumero,
} from "@/lib/leads/nascimento-do-lead";

/** O ajuste como as rotas o recebem e devolvem (snake_case, contrato da API). */
export interface AjusteDoFunilDoNumero {
  abre_card: boolean;
  /** NULL = funil padrão da empresa. */
  funil_id: string | null;
  /** NULL = primeira etapa aberta do funil. */
  etapa_id: string | null;
}

export interface EtapaEscolhivel {
  id: string;
  nome: string;
}

export interface FunilEscolhivel {
  id: string;
  nome: string;
  /** É o funil padrão da empresa. */
  padrao: boolean;
  /** Etapas abertas (sem ganho, perda nem arquivada), na ordem do funil. */
  etapas: EtapaEscolhivel[];
}

export interface RetratoDoFunilDoNumero extends AjusteDoFunilDoNumero {
  /** Onde os cards novos deste número nascem HOJE. `null` com `abre_card = false` ou sem funil padrão. */
  destino: {
    funil_id: string;
    funil_nome: string;
    etapa_id: string;
    etapa_nome: string;
    /** O destino é o funil padrão da empresa (por escolha ou por conserto). */
    padrao: boolean;
  } | null;
  /** Por que o destino não é o que foi escolhido. `null` quando é. */
  aviso: AvisoDoFunilDoNumero | "sem_funil_padrao" | null;
  /** Funis não arquivados da empresa, para escolher. */
  funis: FunilEscolhivel[];
}

export type FalhaAoGravar =
  | { codigo: "nao_encontrado"; mensagem: string }
  | { codigo: "funil_invalido"; mensagem: string }
  | { codigo: "etapa_invalida"; mensagem: string }
  | { codigo: "erro"; mensagem: string };

function paraAjuste(f: FunilDoNumero): AjusteDoFunilDoNumero {
  return { abre_card: f.abreCard, funil_id: f.funilId, etapa_id: f.etapaId };
}

function deAjuste(a: AjusteDoFunilDoNumero): FunilDoNumero {
  return {
    abreCard: a.abre_card,
    funilId: a.funil_id,
    // Etapa sem funil não tem significado: "primeira etapa do funil padrão" é o padrão.
    etapaId: a.funil_id ? a.etapa_id : null,
  };
}

/** A linha do número, ou `null` quando não existe (ou está arquivado) NESTA empresa. */
async function lerLinha(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<FunilDoNumero | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, abre_card, funil_de_entrada_id, etapa_de_entrada_id")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const linha = data as { abre_card: boolean | null; funil_de_entrada_id: string | null; etapa_de_entrada_id: string | null };
  return {
    abreCard: linha.abre_card !== false,
    funilId: linha.funil_de_entrada_id ?? null,
    etapaId: linha.funil_de_entrada_id ? (linha.etapa_de_entrada_id ?? null) : null,
  };
}

/** Funis não arquivados da empresa, com as etapas abertas de cada um. */
export async function funisEscolhiveis(db: SupabaseClient, organizationId: string): Promise<FunilEscolhivel[]> {
  const { data: funis, error } = await db
    .from("crm_pipelines")
    .select("id, name, is_default, position")
    .eq("organization_id", organizationId)
    .eq("is_archived", false)
    .order("position", { ascending: true });
  if (error) throw new Error(error.message);
  const lista = (funis ?? []) as Array<{ id: string; name: string; is_default: boolean }>;
  if (lista.length === 0) return [];

  const { data: etapas, error: erroEtapas } = await db
    .from("crm_stages")
    .select("id, name, pipeline_id, position")
    .eq("organization_id", organizationId)
    .in(
      "pipeline_id",
      lista.map((f) => f.id),
    )
    .eq("is_archived", false)
    .eq("is_won", false)
    .eq("is_lost", false)
    .order("position", { ascending: true });
  if (erroEtapas) throw new Error(erroEtapas.message);
  const porFunil = new Map<string, EtapaEscolhivel[]>();
  for (const e of (etapas ?? []) as Array<{ id: string; name: string; pipeline_id: string }>) {
    const l = porFunil.get(e.pipeline_id) ?? [];
    l.push({ id: e.id, nome: e.name });
    porFunil.set(e.pipeline_id, l);
  }
  return lista.map((f) => ({ id: f.id, nome: f.name, padrao: f.is_default === true, etapas: porFunil.get(f.id) ?? [] }));
}

/** Onde os cards nascem com este ajuste, com nome de funil e etapa. */
async function destinoComNomes(
  db: SupabaseClient,
  organizationId: string,
  ajuste: FunilDoNumero,
): Promise<Pick<RetratoDoFunilDoNumero, "destino" | "aviso">> {
  if (!ajuste.abreCard) return { destino: null, aviso: null };
  const d = await destinoDoNumero(db, organizationId, ajuste);
  if ("erro" in d) return { destino: null, aviso: d.aviso ?? "sem_funil_padrao" };
  const [{ data: funil }, { data: etapa }] = await Promise.all([
    db.from("crm_pipelines").select("name").eq("organization_id", organizationId).eq("id", d.pipelineId).maybeSingle(),
    db.from("crm_stages").select("name").eq("organization_id", organizationId).eq("id", d.stageId).maybeSingle(),
  ]);
  return {
    destino: {
      funil_id: d.pipelineId,
      funil_nome: ((funil as { name?: string } | null)?.name ?? "") as string,
      etapa_id: d.stageId,
      etapa_nome: ((etapa as { name?: string } | null)?.name ?? "") as string,
      padrao: !d.doNumero,
    },
    aviso: d.aviso,
  };
}

/**
 * O retrato completo do número: ajuste, destino de hoje, aviso e opções.
 * `null` quando o número não existe nesta empresa (ou foi arquivado).
 */
export async function retratoDoFunilDoNumero(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<RetratoDoFunilDoNumero | null> {
  const ajuste = await lerLinha(db, organizationId, channelSessionId);
  if (!ajuste) return null;
  const [funis, destino] = await Promise.all([
    funisEscolhiveis(db, organizationId),
    destinoComNomes(db, organizationId, ajuste),
  ]);
  return { ...paraAjuste(ajuste), ...destino, funis };
}

/**
 * Confere e grava o ajuste. Funil: da empresa e não arquivado. Etapa: só com
 * funil, do MESMO funil, aberta (sem ganho, perda nem arquivada). Com
 * `abre_card = false`, funil e etapa ficam guardados como vieram (conferidos do
 * mesmo jeito), para quem religar o número não ter de escolher de novo.
 */
export async function gravarFunilDoNumero(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
  pedido: AjusteDoFunilDoNumero,
): Promise<{ ok: true; antes: AjusteDoFunilDoNumero; depois: AjusteDoFunilDoNumero } | ({ ok: false } & FalhaAoGravar)> {
  let antes: FunilDoNumero | null;
  try {
    antes = await lerLinha(db, organizationId, channelSessionId);
  } catch (err) {
    return { ok: false, codigo: "erro", mensagem: err instanceof Error ? err.message.slice(0, 160) : "desconhecido" };
  }
  if (!antes) return { ok: false, codigo: "nao_encontrado", mensagem: "Número não encontrado nesta empresa." };

  const novo = deAjuste(pedido);

  if (novo.funilId) {
    const { data: funil, error } = await db
      .from("crm_pipelines")
      .select("id, is_archived")
      .eq("organization_id", organizationId)
      .eq("id", novo.funilId)
      .maybeSingle();
    if (error) return { ok: false, codigo: "erro", mensagem: error.message.slice(0, 160) };
    if (!funil || (funil as { is_archived: boolean }).is_archived) {
      return { ok: false, codigo: "funil_invalido", mensagem: "Escolha um funil desta empresa que não esteja arquivado." };
    }
  }
  if (novo.etapaId) {
    const { data: etapa, error } = await db
      .from("crm_stages")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("pipeline_id", novo.funilId!)
      .eq("id", novo.etapaId)
      .eq("is_archived", false)
      .eq("is_won", false)
      .eq("is_lost", false)
      .maybeSingle();
    if (error) return { ok: false, codigo: "erro", mensagem: error.message.slice(0, 160) };
    if (!etapa) {
      return {
        ok: false,
        codigo: "etapa_invalida",
        mensagem: "Escolha uma etapa aberta do funil escolhido (não vale etapa de ganho, de perda ou arquivada).",
      };
    }
  }

  const { data: gravado, error } = await db
    .from("channel_sessions")
    .update({
      abre_card: novo.abreCard,
      funil_de_entrada_id: novo.funilId,
      etapa_de_entrada_id: novo.etapaId,
    })
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, codigo: "erro", mensagem: error.message.slice(0, 160) };
  if (!gravado) return { ok: false, codigo: "nao_encontrado", mensagem: "Número não encontrado nesta empresa." };
  return { ok: true, antes: paraAjuste(antes), depois: paraAjuste(novo) };
}

/** Uma linha da lista de números da empresa, para a porta Admin. */
export interface NumeroComFunil extends RetratoDoFunilDoNumero {
  id: string;
  nome: string | null;
  telefone: string | null;
  situacao: string;
}

/**
 * Os números (conexões não arquivadas) da empresa, cada um com o seu ajuste e
 * o destino de hoje. As opções de funil vêm uma vez só, fora da lista.
 */
export async function numerosComFunil(
  db: SupabaseClient,
  organizationId: string,
): Promise<{ numeros: Array<Omit<NumeroComFunil, "funis">>; funis: FunilEscolhivel[] }> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, display_name, phone_number, status, abre_card, funil_de_entrada_id, etapa_de_entrada_id")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const linhas = (data ?? []) as Array<{
    id: string;
    display_name: string | null;
    phone_number: string | null;
    status: string;
    abre_card: boolean | null;
    funil_de_entrada_id: string | null;
    etapa_de_entrada_id: string | null;
  }>;
  const funis = await funisEscolhiveis(db, organizationId);
  const numeros = await Promise.all(
    linhas.map(async (l) => {
      const ajuste: FunilDoNumero = {
        abreCard: l.abre_card !== false,
        funilId: l.funil_de_entrada_id ?? null,
        etapaId: l.funil_de_entrada_id ? (l.etapa_de_entrada_id ?? null) : null,
      };
      return {
        id: l.id,
        nome: l.display_name,
        telefone: l.phone_number,
        situacao: l.status,
        ...paraAjuste(ajuste),
        ...(await destinoComNomes(db, organizationId, ajuste)),
      };
    }),
  );
  return { numeros, funis };
}

