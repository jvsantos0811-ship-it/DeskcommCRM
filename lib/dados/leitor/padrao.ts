/**
 * O MODELO PADRÃO DO LEITOR, DA INSTALAÇÃO — PM-027, decisão do dono de 06/11
 * ("o Leitor deve ligar nas organizações que já existem e ligar sozinho nas
 * próximas e nas novas").
 *
 * Mora em `platform_config` (uma linha da instalação, nunca de organização),
 * chave `LEITOR_MODELO_PADRAO`, valor JSON: o modelo, a reserva, quando o padrão
 * passou a valer (`ativo_desde`) e quando foi gravado (`definido_em`). Quem
 * escolhe é o dono da plataforma, na página Administração › Bateria do Leitor,
 * só entre os modelos APROVADOS na bateria (a mesma régua do cartão da empresa).
 *
 * `ativo_desde` é o marco das organizações que seguem o padrão: nada antes dele
 * é lido (sem carga inicial, §3). Trocar o modelo NÃO muda o marco (só as
 * leituras seguintes usam o novo); tirar o padrão e pôr de novo começa um marco
 * novo — o intervalo sem padrão não é lido depois.
 *
 * Nada aqui lança na LEITURA: banco que não respondeu = sem padrão (falha
 * fechada — nenhuma empresa passa a ler por engano), com aviso no log.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { alcanceDaOrg, funisLidos, type FunilDaOrg } from "@/lib/dados/alcance-do-leitor";
import { logger } from "@/lib/logger";
import { ehOperante } from "@/lib/organizacao/operante";

import { ultimaRodadaPorModelo } from "./bateria-admin";
import {
  configDoLeitor,
  configEfetivaDoLeitor,
  lerValorDoPadrao,
  type EscolhaDoLeitor,
  type ModeloDoLeitor,
  type PadraoDoLeitor,
} from "./config";
import { instalacaoAtendeOModelo } from "./modelo-escolhido";
import { nomeDoModelo, type ModeloDoCatalogo } from "./modelos-principais";

export type RecusaDoPadrao = "modelo_nao_aprovado" | "reserva_igual" | "reserva_nao_aprovada";

/**
 * O padrão segue a MESMA régua do cartão da empresa: principal e reserva
 * aprovados na bateria (100% nos casos que bloqueiam, a rodada terminada mais
 * nova de cada modelo) e reserva diferente do principal. A chave não entra aqui:
 * cada empresa usa a sua ou a da instalação, e a que não tem nenhuma não lê
 * (o cartão dela mostra o motivo).
 */
export function recusaDoPadrao(
  rodadas: Map<string, { aprovado: boolean | null }>,
  modelo: ModeloDoLeitor,
  reserva: ModeloDoLeitor | null,
): RecusaDoPadrao | null {
  const aprovado = (m: ModeloDoLeitor) => rodadas.get(`${m.provider}/${m.model_id}`)?.aprovado === true;
  if (!aprovado(modelo)) return "modelo_nao_aprovado";
  if (reserva) {
    if (reserva.provider === modelo.provider && reserva.model_id === modelo.model_id) return "reserva_igual";
    if (!aprovado(reserva)) return "reserva_nao_aprovada";
  }
  return null;
}

/** A linha em `platform_config` (o formato da CHECK exige maiúsculas). */
export const CHAVE_DO_PADRAO_DO_LEITOR = "LEITOR_MODELO_PADRAO";

export async function lerPadraoDoLeitor(admin: SupabaseClient): Promise<PadraoDoLeitor | null> {
  try {
    const { data, error } = await admin
      .from("platform_config")
      .select("valor")
      .eq("chave", CHAVE_DO_PADRAO_DO_LEITOR)
      .maybeSingle();
    if (error) {
      logger.warn("[leitor] não consegui ler o modelo padrão da instalação; sigo sem padrão", { message: error.message });
      return null;
    }
    return lerValorDoPadrao((data as { valor?: string | null } | null)?.valor ?? null);
  } catch (err) {
    logger.warn("[leitor] não consegui ler o modelo padrão da instalação; sigo sem padrão", {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Grava (ou tira, com `modelo` nulo) o padrão. Devolve o antes e o depois.
 * Quem confere a régua (aprovado na bateria, reserva diferente) é quem chama.
 */
export async function gravarPadraoDoLeitor(
  admin: SupabaseClient,
  escolha: { modelo: ModeloDoLeitor | null; reserva: ModeloDoLeitor | null },
  agora: Date,
  userId: string,
): Promise<{ antes: PadraoDoLeitor | null; depois: PadraoDoLeitor | null }> {
  const antes = await lerPadraoDoLeitor(admin);
  if (!escolha.modelo) {
    const { error } = await admin.from("platform_config").delete().eq("chave", CHAVE_DO_PADRAO_DO_LEITOR);
    if (error) throw new Error(error.message);
    return { antes, depois: null };
  }
  const depois: PadraoDoLeitor = {
    modelo: escolha.modelo,
    reserva: escolha.reserva,
    ativo_desde: antes?.ativo_desde ?? agora.toISOString(),
    definido_em: agora.toISOString(),
  };
  const { error } = await admin.from("platform_config").upsert(
    {
      chave: CHAVE_DO_PADRAO_DO_LEITOR,
      valor: JSON.stringify(depois),
      eh_segredo: false,
      semeado_do_env: false,
      updated_by: userId,
    },
    { onConflict: "chave" },
  );
  if (error) throw new Error(error.message);
  return { antes, depois };
}

export interface OrganizacaoNoPadrao {
  id: string;
  nome: string;
  escolha: EscolhaDoLeitor;
  operando: boolean;
  /** Desde quando lê (configuração efetiva); `null` = não lê. */
  ligado_em: string | null;
  /**
   * Os funis que o Leitor lê nesta organização (o alcance dela; sem escolha,
   * todos os não arquivados menos o marcado como funil de clientes). O dono vê
   * isto ANTES de salvar o padrão: um funil de clientes sem a marca seria lido.
   */
  funis_lidos: string[];
}

/**
 * Como cada organização está diante do padrão (para a página do dono e para a
 * auditoria de quando o padrão passa a valer). Lida com o cliente de serviço:
 * é uma visão da instalação, e só a rota do dono a usa.
 */
export async function situacaoDasOrganizacoes(admin: SupabaseClient, padrao: PadraoDoLeitor | null): Promise<OrganizacaoNoPadrao[]> {
  const [orgsR, funisR] = await Promise.all([
    admin.from("organizations").select("id, display_name, settings, created_at, status").order("display_name"),
    admin.from("crm_pipelines").select("id, name, organization_id, is_archived, is_client_pipeline").order("position"),
  ]);
  if (orgsR.error) throw new Error(orgsR.error.message);
  if (funisR.error) throw new Error(funisR.error.message);
  const funisPorOrg = new Map<string, Array<FunilDaOrg & { name: string }>>();
  for (const f of (funisR.data ?? []) as Array<FunilDaOrg & { name: string; organization_id: string }>) {
    const lista = funisPorOrg.get(f.organization_id) ?? [];
    lista.push(f);
    funisPorOrg.set(f.organization_id, lista);
  }
  return ((orgsR.data ?? []) as Array<{ id: string; display_name: string | null; settings: unknown; created_at: string | null; status: string | null }>).map(
    (org) => {
      const efetiva = configEfetivaDoLeitor(configDoLeitor(org.settings), org.created_at, padrao);
      const funis = funisPorOrg.get(org.id) ?? [];
      const lidos = funisLidos(alcanceDaOrg(org.settings), funis);
      return {
        id: org.id,
        nome: org.display_name ?? org.id,
        escolha: efetiva.origem,
        operando: ehOperante(org.status),
        ligado_em: efetiva.ligado ? efetiva.ligado_em : null,
        funis_lidos: funis.filter((f) => lidos.has(f.id)).map((f) => f.name),
      };
    },
  );
}

/** As organizações que seguem o padrão e, com ele, estão ligadas. */
export async function organizacoesQueSeguemOPadrao(admin: SupabaseClient, padrao: PadraoDoLeitor): Promise<OrganizacaoNoPadrao[]> {
  return (await situacaoDasOrganizacoes(admin, padrao)).filter((o) => o.escolha === "padrao" && o.ligado_em !== null);
}

export interface PadraoNaTela {
  atual: PadraoDoLeitor | null;
  /** Os modelos que podem ser o padrão (aprovados na bateria), com o nome e se a instalação tem chave. */
  aprovados: Array<{ provider: string; model_id: string; nome: string; instalacaoTemChave: boolean }>;
  organizacoes: OrganizacaoNoPadrao[];
}

/** O bloco "Modelo padrão do Leitor" da página do dono. */
export async function padraoNaTela(admin: SupabaseClient): Promise<PadraoNaTela> {
  const [atual, rodadas, catalogoR] = await Promise.all([
    lerPadraoDoLeitor(admin),
    ultimaRodadaPorModelo(admin),
    admin.from("ai_models").select("provider, model_id, display_name").is("deprecated_at", null),
  ]);
  if (catalogoR.error) throw new Error(catalogoR.error.message);
  const nomes = new Map(
    ((catalogoR.data ?? []) as Array<Pick<ModeloDoCatalogo, "provider" | "model_id" | "display_name">>).map((m) => [
      `${m.provider}/${m.model_id}`,
      nomeDoModelo(m),
    ]),
  );
  const aprovados = [...rodadas.values()]
    .filter((r) => r.aprovado === true)
    .map((r) => ({
      provider: r.provider,
      model_id: r.model_id,
      nome: nomes.get(`${r.provider}/${r.model_id}`) ?? r.model_id,
      instalacaoTemChave: instalacaoAtendeOModelo(r),
    }));
  return { atual, aprovados, organizacoes: await situacaoDasOrganizacoes(admin, atual) };
}
