/**
 * MONTAR E GRAVAR O RETRATO DE UMA ORGANIZAÇÃO — v3 §8.
 *
 * Três caminhos usam este arquivo, com o MESMO código:
 *
 *  - o cron das 06:00 (`app/api/v1/cron/dados-retrato`), com o cliente de
 *    serviço e o `organization_id` de `fn_dados_orgs_sem_retrato`;
 *  - o "Atualizar agora" e a gravação de um valor no catálogo, com o cliente de
 *    serviço e o `organization_id` da SESSÃO (nunca do corpo);
 *  - a conta ao vivo do atendente em "só os seus" (`montarRetratoDaOrg` com o
 *    cliente da sessão: a RLS entrega só os leads dele, e nada é gravado).
 *
 * Toda consulta filtra `organization_id` explicitamente — com o cliente de
 * serviço a RLS não se aplica, e é esse filtro que isola as empresas.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { PESOS_DA_NOTA } from "@/lib/dados/qualidade";
import {
  montarRetrato,
  VERSAO_DA_REGRA,
  type ConteudoDoRetrato,
  type EtapaDoFunil,
  type LinhaDoRetrato,
  type TipoDoCatalogo,
} from "@/lib/dados/retrato";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

/** O PostgREST corta em `max_rows` (1000) sem avisar: a leitura vai por páginas. */
const LINHAS_POR_PAGINA = 1000;
/** Teto de segurança: 50 mil leads no universo do painel. */
const PAGINAS_NO_MAXIMO = 50;

export type OrigemDoRetrato = "cron" | "manual" | "catalogo";

export class ErroDoRetrato extends Error {
  constructor(
    readonly etapa: string,
    mensagem: string,
  ) {
    super(`${etapa}: ${mensagem}`);
    this.name = "ErroDoRetrato";
  }
}

/** Os leads do universo do painel, todos, página por página. */
export async function lerLinhasDoRetrato(db: SupabaseClient, orgId: string): Promise<LinhaDoRetrato[]> {
  const todas: LinhaDoRetrato[] = [];
  for (let pagina = 0; pagina < PAGINAS_NO_MAXIMO; pagina += 1) {
    const de = pagina * LINHAS_POR_PAGINA;
    const { data, error } = await db
      .rpc("fn_dados_leads_do_retrato", {
        p_org: orgId,
        p_chance_de_qualificado: PESOS_DA_NOTA.chanceMinimaDaEtapa,
      })
      .range(de, de + LINHAS_POR_PAGINA - 1);
    if (error) throw new ErroDoRetrato("leads", error.message);
    const linhas = (data ?? []) as LinhaDoRetrato[];
    todas.push(...linhas);
    if (linhas.length < LINHAS_POR_PAGINA) break;
  }
  return todas;
}

export interface ContextoDaOrg {
  fuso: string;
  moeda: string;
  pipelineId: string | null;
  etapas: EtapaDoFunil[];
  tipos: TipoDoCatalogo[];
}

/** Fuso, moeda, funil padrão com as etapas e os tipos de lead da organização. */
export async function contextoDaOrg(db: SupabaseClient, orgId: string): Promise<ContextoDaOrg> {
  const [org, funil, tipos, moeda] = await Promise.all([
    db.from("organizations").select("timezone").eq("id", orgId).maybeSingle(),
    db.from("crm_pipelines").select("id").eq("organization_id", orgId).eq("is_default", true).limit(1).maybeSingle(),
    db
      .from("catalog_products")
      .select("nome, preco_cents")
      .eq("organization_id", orgId)
      .eq("tipo_de_lead", true)
      .eq("ativo", true)
      .order("nome"),
    moedaDaOrganizacao(db, orgId),
  ]);
  if (funil.error) throw new ErroDoRetrato("funil", funil.error.message);
  if (tipos.error) throw new ErroDoRetrato("tipos", tipos.error.message);
  const pipelineId = (funil.data as { id?: string } | null)?.id ?? null;

  let etapas: EtapaDoFunil[] = [];
  if (pipelineId) {
    const { data, error } = await db
      .from("crm_stages")
      .select("id, name, position")
      .eq("organization_id", orgId)
      .eq("pipeline_id", pipelineId)
      .eq("is_archived", false)
      .order("position");
    if (error) throw new ErroDoRetrato("etapas", error.message);
    etapas = ((data ?? []) as Array<{ id: string; name: string; position: number | string }>).map((s) => ({
      id: s.id,
      nome: s.name,
      posicao: Number(s.position),
    }));
  }

  return {
    fuso: fusoUtilizavel((org.data as { timezone?: string | null } | null)?.timezone),
    moeda,
    pipelineId,
    etapas,
    tipos: ((tipos.data ?? []) as Array<{ nome: string; preco_cents: number | string | null }>).map((t) => ({
      nome: t.nome,
      preco_cents: t.preco_cents === null || t.preco_cents === undefined ? null : Number(t.preco_cents),
    })),
  };
}

/** O retrato montado (sem gravar). Com o cliente da sessão, só o que a RLS deixa ver. */
export async function montarRetratoDaOrg(
  db: SupabaseClient,
  orgId: string,
  agora: Date,
): Promise<ConteudoDoRetrato & { fuso: string }> {
  const [ctx, linhas] = await Promise.all([contextoDaOrg(db, orgId), lerLinhasDoRetrato(db, orgId)]);
  const conteudo = montarRetrato({
    linhas,
    agora,
    fuso: ctx.fuso,
    pipelineId: ctx.pipelineId,
    moeda: ctx.moeda,
    tipos: ctx.tipos,
    etapas: ctx.etapas,
  });
  return { ...conteudo, fuso: ctx.fuso };
}

export interface ResultadoDaGravacao {
  dia: string;
  geradoEm: string;
  gravado: boolean;
  /** gravado | ja_existe (o cron achou o do dia) | recente ("Atualizar agora" antes dos 30 min). */
  motivo: "gravado" | "ja_existe" | "recente";
  proximoEm: string | null;
  apagados: number;
  leads: number;
}

interface LinhaDaGravacao {
  retrato_dia: string;
  retrato_gerado_em: string;
  gravado: boolean;
  motivo: string;
  proximo_em: string | null;
  apagados: number;
}

/**
 * Monta e grava o retrato do dia da organização. SÓ com o cliente de serviço
 * (a função de gravar não roda para `authenticated`). O dia, o intervalo de 30
 * minutos e a limpeza de 90 dias são decididos pelo banco.
 */
export async function gerarRetratoDaOrg(
  admin: SupabaseClient,
  orgId: string,
  origem: OrigemDoRetrato,
  opts: { soSeFaltar?: boolean; agora?: Date } = {},
): Promise<ResultadoDaGravacao> {
  const agora = opts.agora ?? new Date();
  const c = await montarRetratoDaOrg(admin, orgId, agora);
  const { data, error } = await admin.rpc("fn_dados_gravar_retrato", {
    p_org: orgId,
    p_origem: origem,
    p_versao_regra: VERSAO_DA_REGRA,
    p_resumo: c.resumo,
    p_leads: c.leads,
    p_por_dia: c.por_dia,
    p_funil: c.funil,
    p_por_etapa: c.por_etapa,
    p_motivos: c.motivos,
    p_so_se_faltar: opts.soSeFaltar ?? false,
  });
  if (error) throw new ErroDoRetrato("gravar", error.message);
  const linha = (Array.isArray(data) ? data[0] : data) as LinhaDaGravacao | undefined;
  if (!linha) throw new ErroDoRetrato("gravar", "a função não devolveu linha");
  const motivo = linha.motivo === "ja_existe" || linha.motivo === "recente" ? linha.motivo : "gravado";
  return {
    dia: linha.retrato_dia,
    geradoEm: linha.retrato_gerado_em,
    gravado: Boolean(linha.gravado),
    motivo,
    proximoEm: linha.proximo_em,
    apagados: Number(linha.apagados ?? 0),
    leads: c.leads.length,
  };
}

/**
 * O valor de um tipo de lead mudou: refaz o retrato do dia para a aba Dinheiro
 * mudar na hora (v3 §7 — "preencher um valor no catálogo muda a aba Dinheiro na
 * hora"). Não passa pelo limite de 30 minutos do "Atualizar agora": é efeito de
 * um cadastro do gerente, não um pedido de recálculo. NUNCA lança — o catálogo
 * já foi salvo, e um retrato que falhou não pode virar erro na tela do catálogo;
 * o painel segue com o retrato anterior e o cron/"Atualizar agora" refazem.
 */
export async function refazerRetratoPeloCatalogo(
  admin: SupabaseClient,
  orgId: string,
  registrar: (r: ResultadoDaGravacao) => Promise<void>,
  falhou: (e: unknown) => void,
): Promise<void> {
  try {
    const r = await gerarRetratoDaOrg(admin, orgId, "catalogo");
    if (r.gravado) await registrar(r);
  } catch (e) {
    falhou(e);
  }
}
