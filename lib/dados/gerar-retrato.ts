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
import { lerFicha, type FichaDoLeitor } from "@/lib/dados/ficha";
import { alcanceDaOrg, funisLidos, posicaoNoAlcance, type FunilDaOrg } from "@/lib/dados/alcance-do-leitor";
import { painelPelaFicha } from "@/lib/dados/leitor/config";
import { PESOS_DA_NOTA } from "@/lib/dados/qualidade";
import {
  diaNoFuso,
  HORA_DO_RETRATO,
  montarRetrato,
  type ConteudoDoRetrato,
  type EtapaDoFunil,
  type LinhaDoRetrato,
  type TipoDoCatalogo,
} from "@/lib/dados/retrato";
import { REGUA_PELA_FICHA, REGUA_POR_MENSAGENS, type EntradaPelaFicha } from "@/lib/dados/retrato-pela-ficha";
import { partesNoFuso } from "@/lib/agenda/fuso";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

/** O PostgREST corta em `max_rows` (1000) sem avisar: a leitura vai por páginas. */
const LINHAS_POR_PAGINA = 1000;
/** Teto de segurança: 50 mil leads no universo do painel. */
const PAGINAS_NO_MAXIMO = 50;

/**
 * Quem pediu o retrato. `ficha` (PC-037 §3): uma ficha gravada ou corrigida
 * refaz o retrato do dia na organização com o painel pela ficha — no máximo um a
 * cada `MINUTOS_ENTRE_RECALCULOS_PELA_FICHA`, quem recusa é o banco (9034). O
 * CHECK de `crm_dados_retrato.origem` fala este vocabulário.
 */
export const ORIGENS_DO_RETRATO = ["cron", "manual", "catalogo", "ficha"] as const;
export type OrigemDoRetrato = (typeof ORIGENS_DO_RETRATO)[number];

/** O lote do recálculo pela ficha (PC-037 §3): no máximo 1 a cada 5 min por organização. */
export const MINUTOS_ENTRE_RECALCULOS_PELA_FICHA = 5;

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
  /** Régua v2: o painel conta pela ficha (`painelPelaFicha`). */
  pelaFicha: boolean;
  /** `organizations.settings` cru (o alcance do Leitor mora lá). */
  settings: unknown;
}

/** Fuso, moeda, funil padrão com as etapas e os tipos de lead da organização. */
export async function contextoDaOrg(db: SupabaseClient, orgId: string): Promise<ContextoDaOrg> {
  const [org, funil, tipos, moeda] = await Promise.all([
    db.from("organizations").select("timezone, settings").eq("id", orgId).maybeSingle(),
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

  const orgRow = org.data as { timezone?: string | null; settings?: unknown } | null;
  return {
    pelaFicha: painelPelaFicha(orgRow?.settings),
    settings: orgRow?.settings ?? null,
    fuso: fusoUtilizavel(orgRow?.timezone),
    moeda,
    pipelineId,
    etapas,
    tipos: ((tipos.data ?? []) as Array<{ nome: string; preco_cents: number | string | null }>).map((t) => ({
      nome: t.nome,
      preco_cents: t.preco_cents === null || t.preco_cents === undefined ? null : Number(t.preco_cents),
    })),
  };
}

/**
 * Régua v2: a ficha de cada lead (só as que passam no schema central) e os cards
 * duplicados — outro negócio COM POTENCIAL do mesmo contato (aberto, num funil
 * que o Leitor lê, sem marcador que desqualifica), criado antes. É a mesma régua
 * do Leitor (`negociosDoContato` + `fatosDoBanco`): o card no funil de clientes
 * ou num funil arquivado não faz ninguém virar duplicado. Página por página,
 * filtrando a organização.
 */
export async function lerEntradaPelaFicha(db: SupabaseClient, orgId: string, settings: unknown = null): Promise<EntradaPelaFicha> {
  const fichas = new Map<string, FichaDoLeitor>();
  for (let pagina = 0; pagina < PAGINAS_NO_MAXIMO; pagina += 1) {
    const de = pagina * LINHAS_POR_PAGINA;
    const { data, error } = await db
      .from("crm_lead_ficha")
      .select("lead_id, ficha")
      .eq("organization_id", orgId)
      .order("lead_id")
      .range(de, de + LINHAS_POR_PAGINA - 1);
    if (error) throw new ErroDoRetrato("fichas", error.message);
    const linhas = (data ?? []) as Array<{ lead_id: string; ficha: unknown }>;
    for (const l of linhas) {
      const f = lerFicha(l.ficha);
      if (f) fichas.set(l.lead_id, f);
    }
    if (linhas.length < LINHAS_POR_PAGINA) break;
  }

  const alcance = alcanceDaOrg(settings);
  const funisR = await db.from("crm_pipelines").select("id, is_archived, is_client_pipeline").eq("organization_id", orgId);
  if (funisR.error) throw new ErroDoRetrato("duplicados", funisR.error.message);
  const lidos = funisLidos(alcance, (funisR.data ?? []) as FunilDaOrg[]);

  type LeadDoDuplicado = {
    id: string;
    contact_id: string | null;
    created_at: string;
    pipeline_id: string;
    tags: string[] | null;
    etapa: { name: string; is_won: boolean; is_lost: boolean; is_archived: boolean } | null;
  };
  const abertos: LeadDoDuplicado[] = [];
  for (let pagina = 0; pagina < PAGINAS_NO_MAXIMO; pagina += 1) {
    const de = pagina * LINHAS_POR_PAGINA;
    const { data, error } = await db
      .from("crm_leads")
      .select("id, contact_id, created_at, pipeline_id, tags, etapa:crm_stages!crm_leads_stage_id_fkey(name, is_won, is_lost, is_archived)")
      .eq("organization_id", orgId)
      .eq("status", "open")
      .order("id")
      .range(de, de + LINHAS_POR_PAGINA - 1);
    if (error) throw new ErroDoRetrato("duplicados", error.message);
    const linhas = (data ?? []) as unknown as LeadDoDuplicado[];
    for (const l of linhas) {
      if (!l.etapa) continue;
      if (posicaoNoAlcance({ pipeline_id: l.pipeline_id, tags: l.tags, etapa: l.etapa }, lidos, alcance) !== "com_potencial") continue;
      abertos.push(l);
    }
    if (linhas.length < LINHAS_POR_PAGINA) break;
  }
  const maisAntigoPorContato = new Map<string, { id: string; created_at: string }>();
  for (const l of abertos) {
    if (!l.contact_id) continue;
    const a = maisAntigoPorContato.get(l.contact_id);
    if (!a || l.created_at < a.created_at || (l.created_at === a.created_at && l.id < a.id)) {
      maisAntigoPorContato.set(l.contact_id, { id: l.id, created_at: l.created_at });
    }
  }
  const duplicados = new Set<string>();
  for (const l of abertos) {
    if (!l.contact_id) continue;
    const a = maisAntigoPorContato.get(l.contact_id);
    if (a && a.id !== l.id && a.created_at < l.created_at) duplicados.add(l.id);
  }
  return { fichas, duplicados };
}

/** O retrato montado (sem gravar). Com o cliente da sessão, só o que a RLS deixa ver. */
export async function montarRetratoDaOrg(
  db: SupabaseClient,
  orgId: string,
  agora: Date,
): Promise<ConteudoDoRetrato & { fuso: string }> {
  const [ctx, linhas] = await Promise.all([contextoDaOrg(db, orgId), lerLinhasDoRetrato(db, orgId)]);
  const pelaFicha = ctx.pelaFicha
    ? { ...(await lerEntradaPelaFicha(db, orgId, ctx.settings)), tipos: new Set(ctx.tipos.map((t) => t.nome)) }
    : undefined;
  const conteudo = montarRetrato({
    linhas,
    agora,
    fuso: ctx.fuso,
    pipelineId: ctx.pipelineId,
    moeda: ctx.moeda,
    tipos: ctx.tipos,
    etapas: ctx.etapas,
    ...(pelaFicha ? { pelaFicha } : {}),
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
    p_versao_regra: c.resumo.versao_regra,
    p_resumo: c.resumo,
    p_leads: c.leads,
    p_por_dia: c.por_dia,
    p_funil: c.funil,
    p_por_etapa: c.por_etapa,
    p_motivos: c.motivos,
    p_so_se_faltar: opts.soSeFaltar ?? false,
    // O retrato vale para o INÍCIO da montagem: a ficha gravada enquanto ele era
    // montado fica mais nova que ele, e o cron a pega (PC-037 §3).
    p_agora: agora.toISOString(),
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

/** A régua que o painel da organização deve mostrar (a chave `painel_pela_ficha`). */
export function reguaEsperada(settings: unknown): number {
  return painelPelaFicha(settings) ? REGUA_PELA_FICHA : REGUA_POR_MENSAGENS;
}

/**
 * PC-037 §3 — refaz o retrato do dia sem esperar o dia seguinte: depois de uma
 * ficha gravada ou corrigida, do fim da rodada do Leitor, da troca da chave na
 * tela, ou do cron de hora em hora que fecha o lote.
 *
 * Em lote: o retrato de menos de `MINUTOS_ENTRE_RECALCULOS_PELA_FICHA` não é
 * nem MONTADO de novo (o "não recalcular a cada ficha" do PC-037 vale para o
 * cálculo, não só para a gravação) — e o banco recusa (`recente`) de qualquer
 * jeito, é a garantia. O que ficar para trás o cron refaz (`retratoPrecisaRefazer`).
 *
 * Antes das 06:00 (no relógio da organização) não refaz: o retrato do dia é o
 * das 06:00, que espera a rodada do Leitor fechar (PM-027 §3).
 *
 * NUNCA lança — quem chamou já fez o que tinha de fazer (gravou a ficha, trocou
 * a chave), e o retrato que falhou não vira erro dele; o painel segue com o
 * anterior. Devolve o resultado ou `null` (cedo demais, chave desligada quando
 * `soComPainelPelaFicha`, ou falha — esta passa por `falhou`).
 */
export async function refazerRetratoDoDia(
  admin: SupabaseClient,
  orgId: string,
  opts: { agora?: Date; falhou?: (e: unknown) => void; soComPainelPelaFicha?: boolean } = {},
): Promise<ResultadoDaGravacao | null> {
  try {
    const agora = opts.agora ?? new Date();
    const { data, error } = await admin.from("organizations").select("timezone, settings").eq("id", orgId).maybeSingle();
    if (error) throw new ErroDoRetrato("organizacao", error.message);
    if (!data) return null;
    const org = data as { timezone?: string | null; settings?: unknown };
    if (opts.soComPainelPelaFicha && !painelPelaFicha(org.settings)) return null;
    const fuso = fusoUtilizavel(org.timezone);
    if (partesNoFuso(agora, fuso).hora < HORA_DO_RETRATO) return null;

    const dia = diaNoFuso(agora, fuso);
    const ultimo = await admin.from("crm_dados_retrato").select("gerado_em").eq("organization_id", orgId).eq("dia", dia).maybeSingle();
    if (ultimo.error) throw new ErroDoRetrato("retrato", ultimo.error.message);
    const geradoEm = (ultimo.data as { gerado_em?: string } | null)?.gerado_em;
    if (geradoEm) {
      const proximo = Date.parse(geradoEm) + MINUTOS_ENTRE_RECALCULOS_PELA_FICHA * 60_000;
      if (proximo > agora.getTime()) {
        return { dia, geradoEm, gravado: false, motivo: "recente", proximoEm: new Date(proximo).toISOString(), apagados: 0, leads: 0 };
      }
    }
    return await gerarRetratoDaOrg(admin, orgId, "ficha", { agora });
  } catch (e) {
    opts.falhou?.(e);
    return null;
  }
}

/** A ficha mudou: refaz o retrato do dia, só na organização com o painel pela ficha. */
export function refazerRetratoPelaFicha(
  admin: SupabaseClient,
  orgId: string,
  opts: { agora?: Date; falhou?: (e: unknown) => void } = {},
): Promise<ResultadoDaGravacao | null> {
  return refazerRetratoDoDia(admin, orgId, { ...opts, soComPainelPelaFicha: true });
}

/**
 * O retrato de hoje precisa ser refeito? É o que o cron de hora em hora usa para
 * fechar o lote do PC-037 §3:
 *   - o retrato está numa régua que não é a que a chave pede (a chave foi
 *     trocada e o refazer da tela caiu dentro dos 5 minutos de outro retrato);
 *   - na régua v2, há ficha gravada DEPOIS do retrato (a ficha que caiu dentro
 *     dos 5 minutos de um recálculo, ou a correção do Gestor das 17h10).
 * Sem retrato de hoje, não: quem gera o primeiro do dia é o cron das 06:00.
 */
export async function retratoPrecisaRefazer(admin: SupabaseClient, orgId: string, dia: string, regua: number): Promise<boolean> {
  const retR = await admin
    .from("crm_dados_retrato")
    .select("gerado_em, versao_regra")
    .eq("organization_id", orgId)
    .eq("dia", dia)
    .maybeSingle();
  if (retR.error) throw new ErroDoRetrato("retrato", retR.error.message);
  const ret = retR.data as { gerado_em?: string; versao_regra?: number | null } | null;
  if (!ret?.gerado_em) return false;
  if ((ret.versao_regra ?? REGUA_POR_MENSAGENS) !== regua) return true;
  if (regua !== REGUA_PELA_FICHA) return false;
  const fichaR = await admin
    .from("crm_lead_ficha")
    .select("updated_at")
    .eq("organization_id", orgId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fichaR.error) throw new ErroDoRetrato("fichas", fichaR.error.message);
  const ficha = (fichaR.data as { updated_at?: string } | null)?.updated_at;
  return Boolean(ficha && Date.parse(ficha) > Date.parse(ret.gerado_em));
}
