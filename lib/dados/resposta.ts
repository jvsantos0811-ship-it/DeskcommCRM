/**
 * A RESPOSTA DE `GET /api/v1/dados/qualidade` — o que as quatro abas de Dados
 * leem (v3 §4 e §8.4). Pura: a rota lê o banco e chama `montarResposta`.
 */
import {
  MINUTOS_ENTRE_ATUALIZACOES,
  montarPaineis,
  type ConteudoDoRetrato,
  type LeadDoRetrato,
  type Paineis,
  type ResumoDoRetrato,
} from "@/lib/dados/retrato";
import type { PeriodoResolvido } from "@/lib/dados/periodo";

/**
 *  - `retrato`: a tela lê o retrato do dia (gerente, administrador, leitor e
 *    atendente que vê a organização inteira);
 *  - `ao_vivo`: atendente em "só os seus" — o retrato é da organização inteira,
 *    então a conta é feita na hora, só com os leads dele, sem comparação;
 *  - `sem_retrato`: ainda não há retrato (instalação nova antes das 06:00).
 */
export type ModoDoPainel = "retrato" | "ao_vivo" | "sem_retrato";

export interface LeadNaTela extends LeadDoRetrato {
  /** O título do negócio lido AGORA, pela RLS. Nulo = removido ou fora do alcance. */
  nome: string | null;
}

export interface CabecalhoDoRetrato {
  dia: string;
  gerado_em: string;
  origem: string;
  versao_regra: number;
}

export interface RespostaDaQualidade {
  modo: ModoDoPainel;
  /** O "agora" do servidor, para os rótulos relativos ("há 3 h"). */
  agora: string;
  fuso: string;
  retrato: CabecalhoDoRetrato | null;
  pode_atualizar: boolean;
  /** Antes disto o "Atualizar agora" é recusado (30 min depois do último retrato). */
  proximo_atualizar_em: string | null;
  pipeline_id: string | null;
  /** `vocabulary.interesse` do funil padrão — Benefício, Procedimento, Serviço; nulo = "Interesse". */
  rotulo_do_interesse: string | null;
  resumo: ResumoDoRetrato | null;
  ontem: ResumoDoRetrato | null;
  sete_dias: ResumoDoRetrato | null;
  leads: LeadNaTela[];
  por_dia: ConteudoDoRetrato["por_dia"];
  funil: ConteudoDoRetrato["funil"];
  por_etapa: ConteudoDoRetrato["por_etapa"];
  motivos: ConteudoDoRetrato["motivos"];
  paineis: Paineis | null;
  /** PC-025: o período escolhido (dias do fuso da organização, inclusivos). Nulo = "Tudo". */
  periodo: PeriodoResolvido | null;
}

export interface EntradaDaResposta {
  modo: ModoDoPainel;
  agora: Date;
  fuso: string;
  retrato: CabecalhoDoRetrato | null;
  conteudo: ConteudoDoRetrato | null;
  ontem: ResumoDoRetrato | null;
  seteDias: ResumoDoRetrato | null;
  nomes: Map<string, string>;
  podeAtualizar: boolean;
  rotuloDoInteresse: string | null;
  periodo?: PeriodoResolvido | null;
}

/** O próximo "Atualizar agora" permitido, ou nulo se já pode. */
export function proximoAtualizar(geradoEm: string | null | undefined, agora: Date): string | null {
  if (!geradoEm) return null;
  const t = Date.parse(geradoEm);
  if (!Number.isFinite(t)) return null;
  const proximo = t + MINUTOS_ENTRE_ATUALIZACOES * 60_000;
  return proximo > agora.getTime() ? new Date(proximo).toISOString() : null;
}

/** A comparação só vale com a mesma versão da regra: régua diferente engana. */
function comparavel(r: ResumoDoRetrato | null, versao: number | undefined): ResumoDoRetrato | null {
  if (!r || versao === undefined) return r;
  return r.versao_regra === versao ? r : null;
}

export function montarResposta(e: EntradaDaResposta): RespostaDaQualidade {
  const c = e.conteudo;
  const versao = c?.resumo.versao_regra;
  return {
    modo: e.modo,
    agora: e.agora.toISOString(),
    fuso: e.fuso,
    retrato: e.retrato,
    pode_atualizar: e.podeAtualizar,
    proximo_atualizar_em: e.podeAtualizar ? proximoAtualizar(e.retrato?.gerado_em, e.agora) : null,
    pipeline_id: c?.resumo.pipeline_id ?? null,
    rotulo_do_interesse: e.rotuloDoInteresse,
    resumo: c?.resumo ?? null,
    ontem: e.modo === "retrato" ? comparavel(e.ontem, versao) : null,
    sete_dias: e.modo === "retrato" ? comparavel(e.seteDias, versao) : null,
    leads: (c?.leads ?? []).map((l) => ({ ...l, nome: e.nomes.get(l.id) ?? null })),
    por_dia: c?.por_dia ?? [],
    funil: c?.funil ?? [],
    por_etapa: c?.por_etapa ?? [],
    motivos: c?.motivos ?? [],
    paineis: c ? montarPaineis(c) : null,
    periodo: e.periodo ?? null,
  };
}
