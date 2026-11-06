/**
 * O CARTÃO DO LEITOR NA TELA PROVEDORES — PM-027 §8, com as decisões do dono de
 * 06/11 (a aprovação na bateria vale para a instalação; cada escritório liga o
 * seu, só com modelo aprovado; o Leitor usa a mesma chave de IA que o resto do
 * CRM já usa — nenhum escritório precisa cadastrar chave própria).
 *
 * Para cada modelo: preço do catálogo, custo estimado por mês nesta organização
 * (leituras de lead dos últimos 30 dias × tokens médios × preço), nota na bateria
 * (acertos/total, data), tempo médio, se está aprovado e DE ONDE vem a chave:
 * a credencial da própria organização (ativa e validada) ou, sem ela, a chave da
 * instalação — a mesma escada da leitura (`montarModeloEscolhido`), perguntada
 * pela mesma função (`instalacaoAtendeOModelo`), para a tela e a leitura nunca
 * divergirem. As leituras são pela sessão do usuário (RLS): as rodadas da
 * bateria só expõem números.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ultimaRodadaPorModelo, type RodadaNaTela } from "./bateria-admin";
import {
  configDoLeitor,
  configEfetivaDoLeitor,
  type ConfigEfetivaDoLeitor,
  type ModeloDoLeitor,
  type PadraoDoLeitor,
} from "./config";
import { instalacaoAtendeOModelo } from "./modelo-escolhido";
import {
  CASOS_PARA_UMA_BATERIA_ROBUSTA,
  custoEstimadoPorMes,
  MODELOS_PRINCIPAIS_DO_LEITOR,
  nomeDoModelo,
  type ModeloDoCatalogo,
} from "./modelos-principais";

const DIA_MS = 86_400_000;

export interface ModeloNoCartao {
  provider: string;
  model_id: string;
  nome: string;
  principal: boolean;
  precoEntrada: number | null;
  precoSaida: number | null;
  custoPorMesCents: number | null;
  bateria: {
    acertos: number;
    total: number;
    bloqueantes: number;
    bloqueantesAcertos: number;
    qualidadeAcertos: number;
    regraV2: number;
    data: string | null;
    tempoMedioMs: number | null;
    aprovado: boolean;
  } | null;
  /** Há chave para este modelo: a da organização ou a da instalação. */
  temChave: boolean;
  /** De onde vem a chave; `null` = nenhuma (o modelo fica desabilitado na escolha). */
  origemDaChave: OrigemDaChave | null;
}

export type OrigemDaChave = "empresa" | "instalacao";

export interface DadosDoLeitor {
  /** O que vale agora (com o padrão da instalação no lugar, quando a organização o segue). */
  config: ConfigEfetivaDoLeitor;
  /** O último modelo e reserva que a própria organização escolheu (o cartão os oferece). */
  escolhaPropria: { modelo: ModeloDoLeitor | null; reserva: ModeloDoLeitor | null };
  /** O modelo padrão da instalação, se o dono já escolheu um. */
  padrao: { modelo: ModeloDoLeitor; reserva: ModeloDoLeitor | null; ativoDesde: string } | null;
  /**
   * Ligado, mas sem conseguir ler: o modelo que vale (principal) não tem chave
   * nesta organização nem na instalação. O Leitor não troca de modelo sozinho.
   */
  semChaveParaOModelo: boolean;
  modelos: ModeloNoCartao[];
  bateriaPequena: boolean;
  casosNaBateria: number | null;
  uso: { leituras: number; entradaMedia: number; saidaMedia: number } | null;
}

function noCartao(r: RodadaNaTela | undefined): ModeloNoCartao["bateria"] {
  if (!r) return null;
  return {
    acertos: r.acertos,
    total: r.casos_total,
    bloqueantes: r.bloqueantes,
    bloqueantesAcertos: r.bloqueantes_acertos,
    qualidadeAcertos: r.qualidade_acertos,
    regraV2: r.regra_v2,
    data: r.terminada_em,
    tempoMedioMs: r.tempo_medio_ms,
    aprovado: r.aprovado === true,
  };
}

export interface OpcoesDoCartao {
  /** A instalação tem chave para este modelo? O padrão é a pergunta da leitura; o teste injeta. */
  instalacaoAtende?: (m: { provider: string; model_id: string }) => boolean;
  /** O modelo padrão da instalação (lido com o cliente de serviço por quem chama; `platform_config` não tem policy). */
  padrao?: PadraoDoLeitor | null;
}

/**
 * A lista de modelos do cartão, sem banco: catálogo, provedores com credencial
 * da organização, rodadas da bateria e uso. A chave da instalação é avaliada uma
 * vez por modelo, e só quando a organização não tem a sua daquele provedor.
 */
export function modelosNoCartao(
  catalogo: ModeloDoCatalogo[],
  provedoresComChaveDaEmpresa: Set<string>,
  rodadas: Map<string, RodadaNaTela>,
  uso: DadosDoLeitor["uso"],
  instalacaoAtende: (m: { provider: string; model_id: string }) => boolean,
): ModeloNoCartao[] {
  const principais = new Set(MODELOS_PRINCIPAIS_DO_LEITOR.map((p) => `${p.provider}/${p.model_id}`));
  const ordem = new Map(MODELOS_PRINCIPAIS_DO_LEITOR.map((p, i) => [`${p.provider}/${p.model_id}`, i]));
  return catalogo
    .map((m): ModeloNoCartao => {
      const k = `${m.provider}/${m.model_id}`;
      const origemDaChave: OrigemDaChave | null = provedoresComChaveDaEmpresa.has(m.provider)
        ? "empresa"
        : instalacaoAtende(m)
          ? "instalacao"
          : null;
      return {
        provider: m.provider,
        model_id: m.model_id,
        nome: nomeDoModelo(m),
        principal: principais.has(k),
        precoEntrada: m.input_price_per_million_cents,
        precoSaida: m.output_price_per_million_cents,
        custoPorMesCents: custoEstimadoPorMes(m, uso),
        bateria: noCartao(rodadas.get(k)),
        temChave: origemDaChave !== null,
        origemDaChave,
      };
    })
    .sort((a, b) => {
      const oa = ordem.get(`${a.provider}/${a.model_id}`) ?? 999;
      const ob = ordem.get(`${b.provider}/${b.model_id}`) ?? 999;
      return oa - ob;
    });
}

export async function dadosDoLeitor(db: SupabaseClient, orgId: string, opcoes: OpcoesDoCartao = {}): Promise<DadosDoLeitor> {
  const desde = new Date(Date.now() - 30 * DIA_MS).toISOString();
  const [orgR, catalogoR, credR, usoR, rodadas] = await Promise.all([
    db.from("organizations").select("settings, created_at").eq("id", orgId).maybeSingle(),
    db
      .from("ai_models")
      .select("provider, model_id, display_name, input_price_per_million_cents, output_price_per_million_cents")
      .is("deprecated_at", null)
      .order("provider")
      .order("display_name"),
    db
      .from("ai_provider_credentials")
      .select("provider")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .not("validated_at", "is", null),
    db
      .from("llm_calls")
      .select("input_tokens, output_tokens")
      .eq("organization_id", orgId)
      .eq("purpose", "leitor_da_conversa")
      .not("contact_id", "is", null)
      .gte("created_at", desde)
      .limit(5_000),
    ultimaRodadaPorModelo(db),
  ]);
  if (orgR.error) throw new Error(orgR.error.message);
  if (catalogoR.error) throw new Error(catalogoR.error.message);
  const linhaDaOrg = orgR.data as { settings?: unknown; created_at?: string | null } | null;
  const crua = configDoLeitor(linhaDaOrg?.settings);
  const padrao = opcoes.padrao ?? null;
  const config = configEfetivaDoLeitor(crua, linhaDaOrg?.created_at ?? null, padrao);
  const instalacaoAtende = opcoes.instalacaoAtende ?? instalacaoAtendeOModelo;
  const comChave = new Set(((credR.data ?? []) as Array<{ provider: string }>).map((c) => c.provider));
  const leituras = (usoR.data ?? []) as Array<{ input_tokens: number | null; output_tokens: number | null }>;
  const uso =
    leituras.length > 0
      ? {
          leituras: leituras.length,
          entradaMedia: leituras.reduce((a, l) => a + (l.input_tokens ?? 0), 0) / leituras.length,
          saidaMedia: leituras.reduce((a, l) => a + (l.output_tokens ?? 0), 0) / leituras.length,
        }
      : null;
  const modelos = modelosNoCartao(
    (catalogoR.data ?? []) as ModeloDoCatalogo[],
    comChave,
    rodadas,
    uso,
    instalacaoAtende,
  );
  const maisRecente = [...rodadas.values()].sort((a, b) => String(b.terminada_em).localeCompare(String(a.terminada_em)))[0];
  const casos = maisRecente?.casos_total ?? null;
  const valendo = config.ligado && config.modelo ? config.modelo : null;
  const modeloQueVale = valendo ? modelos.find((m) => m.provider === valendo.provider && m.model_id === valendo.model_id) : undefined;
  const semChaveParaOModelo =
    valendo !== null &&
    !(modeloQueVale ? modeloQueVale.temChave : comChave.has(valendo.provider) || instalacaoAtende(valendo));
  return {
    config,
    escolhaPropria: { modelo: crua.modelo, reserva: crua.reserva },
    padrao: padrao ? { modelo: padrao.modelo, reserva: padrao.reserva, ativoDesde: padrao.ativo_desde } : null,
    semChaveParaOModelo,
    modelos,
    bateriaPequena: casos === null || casos < CASOS_PARA_UMA_BATERIA_ROBUSTA,
    casosNaBateria: casos,
    uso,
  };
}

export type RecusaDoLeitor = "modelo_nao_aprovado" | "sem_chave" | "reserva_igual" | "reserva_nao_aprovada" | "sem_modelo";

/**
 * Pode ligar (ou trocar) com este modelo e esta reserva? `sem_chave` só quando
 * não há chave NENHUMA para o modelo — nem da organização, nem da instalação.
 */
export function conferirEscolha(
  d: Pick<DadosDoLeitor, "modelos">,
  modelo: ModeloDoLeitor | null,
  reserva: ModeloDoLeitor | null,
): RecusaDoLeitor | null {
  if (!modelo) return "sem_modelo";
  const achar = (m: ModeloDoLeitor) => d.modelos.find((x) => x.provider === m.provider && x.model_id === m.model_id);
  const principal = achar(modelo);
  if (!principal?.bateria?.aprovado) return "modelo_nao_aprovado";
  if (!principal.temChave) return "sem_chave";
  if (reserva) {
    if (reserva.provider === modelo.provider && reserva.model_id === modelo.model_id) return "reserva_igual";
    const r = achar(reserva);
    if (!r?.bateria?.aprovado) return "reserva_nao_aprovada";
    if (!r.temChave) return "sem_chave";
  }
  return null;
}
