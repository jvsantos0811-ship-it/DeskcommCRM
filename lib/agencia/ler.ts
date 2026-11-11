/**
 * O PAINEL DA AGÊNCIA (PC-028) — a leitura, com o `service_role` das rotas de
 * plataforma. Uma função só, usada pela tela e pela planilha: o número da
 * planilha é o mesmo da tela.
 *
 * ─── Cache ───────────────────────────────────────────────────────────────────
 *
 * As agregações pesadas (`fn_agencia_numeros`, nos dois períodos, e
 * `fn_agencia_por_agente`) ficam 5 minutos em memória por período: a tela abre
 * rápido mesmo com muitas organizações, e o lançamento manual (barato) é sempre
 * relido — o pagamento que acabou de ser lançado aparece na hora.
 */
import { periodoNoFuso } from "@/lib/datas/periodo-no-fuso";
import { ehOperante, estaSuspensa } from "@/lib/organizacao/operante";
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  linhaDoCliente,
  NUMEROS_VAZIOS,
  periodoAnterior,
  totaisDoTopo,
  type AssinaturaDoProduto,
  type ClienteManual,
  type ConfigDaAgencia,
  type LinhaDoCliente,
  type NumerosDaOrg,
  type PagamentoLancado,
  type TotaisDoTopo,
} from "@/lib/agencia/painel";

type Admin = ReturnType<typeof createAdminClient>;

/** O nome da organização cliente na carteira (não é contato: é a empresa). */
function nomeDaOrganizacao(o: { display_name: string | null }): string {
  return typeof o.display_name === "string" && o.display_name.trim() ? o.display_name : "—";
}

/** O fuso da agência: o da instalação (Brasília). */
export const FUSO_DA_AGENCIA = "America/Sao_Paulo";
const CACHE_MS = 5 * 60_000;

interface DoCache<T> {
  em: number;
  valor: T;
}
const cache = new Map<string, DoCache<unknown>>();

async function comCache<T>(chave: string, ler: () => Promise<T>): Promise<T> {
  const atual = cache.get(chave);
  if (atual && Date.now() - atual.em < CACHE_MS) return atual.valor as T;
  const valor = await ler();
  cache.set(chave, { em: Date.now(), valor });
  if (cache.size > 50) cache.delete(cache.keys().next().value as string);
  return valor;
}

/** Para os testes e para o "Recalcular agora". */
export function limparCacheDaAgencia(): void {
  cache.clear();
}

function limites(p: { de: string; ate: string }): { desde: string; ate: string } {
  const { inicio, fimExclusivo } = periodoNoFuso(p.de, p.ate, FUSO_DA_AGENCIA);
  return { desde: inicio!.toISOString(), ate: fimExclusivo!.toISOString() };
}

async function numerosDoPeriodo(
  admin: Admin,
  p: { de: string; ate: string },
): Promise<Map<string, NumerosDaOrg>> {
  return comCache(`numeros:${p.de}:${p.ate}`, async () => {
    const l = limites(p);
    const { data, error } = await admin.rpc("fn_agencia_numeros", {
      p_desde: l.desde,
      p_ate: l.ate,
    });
    if (error) throw new Error(`fn_agencia_numeros: ${error.message}`);
    const m = new Map<string, NumerosDaOrg>();
    for (const r of (data ?? []) as Array<NumerosDaOrg & { organization_id: string }>) {
      m.set(r.organization_id, {
        ...NUMEROS_VAZIOS,
        ...r,
        ia_custo_usd_cents: Number(r.ia_custo_usd_cents ?? 0),
      });
    }
    return m;
  });
}

export interface AgenteDaOrg {
  agent_id: string | null;
  nome: string;
  custo_usd_cents: number;
  custo_brl_cents: number;
  contatos: number;
}

async function porAgente(admin: Admin, p: { de: string; ate: string }) {
  return comCache(`agentes:${p.de}:${p.ate}`, async () => {
    const l = limites(p);
    const { data, error } = await admin.rpc("fn_agencia_por_agente", {
      p_desde: l.desde,
      p_ate: l.ate,
    });
    if (error) throw new Error(`fn_agencia_por_agente: ${error.message}`);
    return (data ?? []) as Array<{
      organization_id: string;
      agent_id: string | null;
      custo_usd_cents: number;
      contatos: number;
    }>;
  });
}

export interface PainelDaAgencia {
  periodo: { de: string; ate: string };
  anterior: { de: string; ate: string };
  config: ConfigDaAgencia;
  totais: TotaisDoTopo;
  clientes: Array<
    LinhaDoCliente & {
      agentes: AgenteDaOrg[];
      pagamentos: Array<PagamentoLancado & { lancado_por_nome: string | null }>;
    }
  >;
  organizacoes: Array<{ id: string; nome: string }>;
}

export const CONFIG_PADRAO: ConfigDaAgencia = {
  cotacao_usd_brl: 5.5,
  precos_whatsapp: { marketing: 35, utilidade: 4, autenticacao: 4 },
  alerta_custo_pct: 15,
};

export async function lerConfigDaAgencia(admin: Admin): Promise<ConfigDaAgencia> {
  const { data } = await admin
    .from("agencia_config")
    .select("cotacao_usd_brl, precos_whatsapp, alerta_custo_pct")
    .maybeSingle();
  if (!data) return CONFIG_PADRAO;
  const d = data as {
    cotacao_usd_brl: number | string;
    precos_whatsapp: Partial<ConfigDaAgencia["precos_whatsapp"]> | null;
    alerta_custo_pct: number | string;
  };
  return {
    cotacao_usd_brl: Number(d.cotacao_usd_brl) || CONFIG_PADRAO.cotacao_usd_brl,
    precos_whatsapp: { ...CONFIG_PADRAO.precos_whatsapp, ...(d.precos_whatsapp ?? {}) },
    alerta_custo_pct: Number(d.alerta_custo_pct) || CONFIG_PADRAO.alerta_custo_pct,
  };
}

export async function montarPainelDaAgencia(
  admin: Admin,
  args: {
    periodo: { de: string; ate: string };
    hoje: string;
    agora: Date;
    orgId?: string | null;
    nomes: (ids: string[]) => Promise<Map<string, string | null>>;
  },
): Promise<PainelDaAgencia> {
  const anterior = periodoAnterior(args.periodo);
  const [
    orgsR,
    manuaisR,
    pagamentosR,
    config,
    assinaturasR,
    budgetsR,
    sessoesR,
    agentesR,
    numeros,
    antes,
    gastoPorAgente,
  ] = await Promise.all([
    admin.from("organizations").select("id, display_name, status").order("display_name"),
    admin.from("agencia_clientes").select("*"),
    admin.from("agencia_pagamentos").select("*").order("pago_em", { ascending: false }),
    lerConfigDaAgencia(admin),
    admin
      .from("cobranca_assinaturas")
      .select(
        "organization_id, estado, trial_ate, vencida_desde, proximo_vencimento, plano:cobranca_planos!cobranca_assinaturas_plano_id_fkey(nome, preco_cents, intervalo)",
      ),
    admin.from("ai_budgets").select("organization_id, monthly_limit_cents, alarm_threshold_pct"),
    admin.from("channel_sessions").select("organization_id, status"),
    admin
      .from("ai_agents")
      .select("id, organization_id, name, paused_at, is_active, archived_at, published_version_id"),
    numerosDoPeriodo(admin, args.periodo),
    numerosDoPeriodo(admin, anterior),
    porAgente(admin, args.periodo),
  ]);
  if (orgsR.error) throw new Error(`organizations: ${orgsR.error.message}`);

  const orgs = (
    (orgsR.data ?? []) as Array<{ id: string; display_name: string | null; status: string }>
  )
    // Arquivada saiu da carteira; suspensa e redigida continuam à vista.
    .filter((o) => ehOperante(o.status) || estaSuspensa(o.status))
    .filter((o) => !args.orgId || o.id === args.orgId);
  const manuais = new Map(
    ((manuaisR.data ?? []) as ClienteManual[]).map((m) => [m.organization_id, m]),
  );
  const pagamentos = (pagamentosR.data ?? []) as PagamentoLancado[];
  const assinaturas = new Map<string, AssinaturaDoProduto>();
  for (const a of (assinaturasR.data ?? []) as unknown as Array<{
    organization_id: string;
    estado: AssinaturaDoProduto["estado"];
    trial_ate: string | null;
    vencida_desde: string | null;
    proximo_vencimento: string | null;
    plano: { nome: string; preco_cents: number; intervalo: "mes" | "ano" } | null;
  }>) {
    assinaturas.set(a.organization_id, {
      estado: a.estado,
      plano_nome: a.plano?.nome ?? null,
      preco_cents: a.plano?.preco_cents ?? null,
      intervalo: a.plano?.intervalo ?? null,
      trial_ate: a.trial_ate,
      vencida_desde: a.vencida_desde,
      proximo_vencimento: a.proximo_vencimento,
    });
  }
  const budgets = new Map(
    (
      (budgetsR.data ?? []) as Array<{
        organization_id: string;
        monthly_limit_cents: number;
        alarm_threshold_pct: number;
      }>
    ).map((b) => [b.organization_id, b]),
  );
  const comFalha = new Set(
    ((sessoesR.data ?? []) as Array<{ organization_id: string; status: string }>)
      .filter((s) => s.status === "FAILED" || s.status === "STOPPED" || s.status === "SCAN_QR_CODE")
      .map((s) => s.organization_id),
  );
  const agentes = (agentesR.data ?? []) as Array<{
    id: string;
    organization_id: string;
    name: string;
    paused_at: string | null;
    is_active: boolean;
    archived_at: string | null;
    published_version_id: string | null;
  }>;
  const pausados = new Set(
    agentes
      .filter((a) => a.is_active && !a.archived_at && a.published_version_id && a.paused_at)
      .map((a) => a.organization_id),
  );
  const nomeDoAgente = new Map(agentes.map((a) => [a.id, a.name]));

  // O gasto do MÊS pela régua única do produto (fn_gasto_de_ia_do_mes), só de
  // quem tem teto — é contra ele que o alerta "perto do limite" mede.
  const gastoDoMes = new Map<string, number>();
  await Promise.all(
    orgs
      .filter((o) => (budgets.get(o.id)?.monthly_limit_cents ?? 0) > 0)
      .map(async (o) => {
        const { data } = await admin.rpc("fn_gasto_de_ia_do_mes", { p_org: o.id });
        gastoDoMes.set(o.id, Number(data ?? 0));
      }),
  );

  const nomesDeQuemLancou = await args.nomes([
    ...new Set(pagamentos.map((p) => p.lancado_por).filter((x): x is string => !!x)),
  ]);

  const clientes = orgs.map((o) => {
    const dela = pagamentos.filter((p) => p.organization_id === o.id);
    const b = budgets.get(o.id);
    const linha = linhaDoCliente({
      org: { id: o.id, nome: nomeDaOrganizacao(o), status: o.status },
      manual: manuais.get(o.id) ?? null,
      assinatura: assinaturas.get(o.id) ?? null,
      pagamentos: dela,
      numeros: numeros.get(o.id) ?? NUMEROS_VAZIOS,
      anteriores: antes.get(o.id) ?? NUMEROS_VAZIOS,
      config,
      periodo: args.periodo,
      hoje: args.hoje,
      agora: args.agora,
      teto: b
        ? {
            gasto_mes_usd_cents: gastoDoMes.get(o.id) ?? 0,
            limite_usd_cents: b.monthly_limit_cents,
            alarme_pct: b.alarm_threshold_pct,
          }
        : null,
      whatsappComFalha: comFalha.has(o.id),
      agentePausado: pausados.has(o.id),
    });
    return {
      ...linha,
      agentes: gastoPorAgente
        .filter((g) => g.organization_id === o.id)
        .map((g) => ({
          agent_id: g.agent_id,
          nome: g.agent_id
            ? (nomeDoAgente.get(g.agent_id) ?? "Agente removido")
            : "Fora de um agente",
          custo_usd_cents: Math.round(Number(g.custo_usd_cents)),
          custo_brl_cents: Math.round(Number(g.custo_usd_cents) * config.cotacao_usd_brl),
          contatos: g.contatos,
        }))
        .sort((a, b) => b.custo_usd_cents - a.custo_usd_cents),
      pagamentos: dela.slice(0, 50).map((p) => ({
        ...p,
        lancado_por_nome: p.lancado_por ? (nomesDeQuemLancou.get(p.lancado_por) ?? null) : null,
      })),
    };
  });

  return {
    periodo: args.periodo,
    anterior,
    config,
    totais: totaisDoTopo(clientes, manuais, args.periodo),
    clientes,
    organizacoes: ((orgsR.data ?? []) as Array<{ id: string; display_name: string | null }>).map(
      (o) => ({ id: o.id, nome: nomeDaOrganizacao(o) }),
    ),
  };
}
