/**
 * O PAINEL DA AGÊNCIA (PC-028) — as contas, puras, sem banco.
 *
 * ─── De onde vem cada número ─────────────────────────────────────────────────
 *
 *  · Situação, plano, vencimento e atraso: a cobrança do produto
 *    (`cobranca_assinaturas` + `cobranca_planos`) quando a organização tem
 *    assinatura nela; senão o cadastro manual (`agencia_clientes`). Suspensa
 *    vem sempre de `organizations.status`.
 *  · Pagamentos, total pago e recebido no período: só o lançamento manual
 *    (`agencia_pagamentos`) — a cobrança do produto não guarda a lista.
 *  · Custo de IA: `llm_calls.cost_cents` no período (centavos de DÓLAR), a
 *    mesma leitura da tela de Usage; em reais pela cotação da tela.
 *  · Custo do WhatsApp: SEMPRE estimado — o provedor do canal oficial não
 *    devolve o custo ao CRM. Mensagens de modelo por categoria × a tabela de preço da tela;
 *    resposta dentro da janela de 24 h e modelo na janela grátis do anúncio
 *    (até 72 h depois da chegada pelo anúncio de clique) contam R$ 0.
 *  · Resultado do cliente: `fn_agencia_numeros` (migration 9030).
 *
 * Só números agregados: nada de texto de conversa, nome ou telefone de lead.
 */

import { estaSuspensa } from "@/lib/organizacao/operante";

export const SITUACOES = [
  "teste",
  "pagante",
  "em_atraso",
  "suspensa",
  "cancelada",
  "sem_cadastro",
] as const;
export type Situacao = (typeof SITUACOES)[number];

export interface ClienteManual {
  organization_id: string;
  plano: string | null;
  implantacao_cents: number;
  implantacao_paga: boolean;
  mensalidade_cents: number;
  inicio: string | null;
  proximo_vencimento: string | null;
  teste_ate: string | null;
  cancelada_em: string | null;
  observacao: string | null;
}

export interface PagamentoLancado {
  id: string;
  organization_id: string;
  tipo: "mensalidade" | "implantacao" | "outro";
  pago_em: string;
  valor_cents: number;
  forma: string;
  observacao: string | null;
  lancado_por: string | null;
  lancado_em: string;
}

/** A assinatura da cobrança do produto, quando existe. */
export interface AssinaturaDoProduto {
  estado: "trial" | "ativa" | "em_atraso" | "cancelada";
  plano_nome: string | null;
  preco_cents: number | null;
  intervalo: "mes" | "ano" | null;
  trial_ate: string | null;
  vencida_desde: string | null;
  proximo_vencimento: string | null;
}

export interface NumerosDaOrg {
  leads_recebidos: number;
  qualificados: number;
  passados_para_equipe: number;
  ganhos: number;
  mediana_primeira_resposta_seg: number | null;
  conversas_ia: number;
  mensagens_ia: number;
  modelos_marketing: number;
  modelos_utilidade: number;
  modelos_autenticacao: number;
  modelos_gratis_anuncio: number;
  ia_custo_usd_cents: number;
  ultima_conversa_nova_em: string | null;
}

export interface ConfigDaAgencia {
  cotacao_usd_brl: number;
  precos_whatsapp: { marketing: number; utilidade: number; autenticacao: number };
  alerta_custo_pct: number;
}

export const NUMEROS_VAZIOS: NumerosDaOrg = {
  leads_recebidos: 0,
  qualificados: 0,
  passados_para_equipe: 0,
  ganhos: 0,
  mediana_primeira_resposta_seg: null,
  conversas_ia: 0,
  mensagens_ia: 0,
  modelos_marketing: 0,
  modelos_utilidade: 0,
  modelos_autenticacao: 0,
  modelos_gratis_anuncio: 0,
  ia_custo_usd_cents: 0,
  ultima_conversa_nova_em: null,
};

const DIA_MS = 86_400_000;

/** Dias entre dois `AAAA-MM-DD` (b − a), pelo calendário. */
export function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DIA_MS);
}

/** Um mês depois, mantendo o dia (31/01 → 28/02). */
export function umMesDepois(dia: string): string {
  const [a, m, d] = dia.split("-").map(Number) as [number, number, number];
  const ultimoDoMes = new Date(Date.UTC(a, m + 1, 0)).getUTCDate();
  const alvo = new Date(Date.UTC(a, m, Math.min(d, ultimoDoMes)));
  return alvo.toISOString().slice(0, 10);
}

/** Dias em atraso: hoje − vencimento, quando o vencimento já passou. */
export function diasEmAtraso(vencimento: string | null, hoje: string): number {
  if (!vencimento) return 0;
  return Math.max(0, diasEntre(vencimento.slice(0, 10), hoje));
}

export function situacaoDoCliente(a: {
  orgStatus: string;
  manual: ClienteManual | null;
  assinatura: AssinaturaDoProduto | null;
  hoje: string;
  pagamentos: number;
}): Situacao {
  if (estaSuspensa(a.orgStatus)) return "suspensa";
  if (a.manual?.cancelada_em || a.assinatura?.estado === "cancelada") return "cancelada";
  if (a.assinatura) {
    if (a.assinatura.estado === "trial") return "teste";
    if (a.assinatura.estado === "em_atraso") return "em_atraso";
    return "pagante";
  }
  if (!a.manual) return "sem_cadastro";
  if (a.manual.teste_ate && a.manual.teste_ate >= a.hoje && a.pagamentos === 0) return "teste";
  if (diasEmAtraso(a.manual.proximo_vencimento, a.hoje) > 0) return "em_atraso";
  return a.manual.mensalidade_cents > 0 ? "pagante" : "teste";
}

/** Custo do WhatsApp em centavos de real — sempre estimado (ver o cabeçalho). */
export function custoDoWhatsApp(
  n: NumerosDaOrg,
  precos: ConfigDaAgencia["precos_whatsapp"],
): number {
  return (
    n.modelos_marketing * precos.marketing +
    n.modelos_utilidade * precos.utilidade +
    n.modelos_autenticacao * precos.autenticacao
  );
}

export function emReais(usdCents: number, cotacao: number): number {
  return Math.round(usdCents * cotacao);
}

function divisao(a: number, b: number): number | null {
  return b > 0 ? Math.round(a / b) : null;
}

export type Tendencia = "subiu" | "caiu" | "igual" | null;

export function tendencia(atual: number | null, anterior: number | null): Tendencia {
  if (atual === null || anterior === null) return null;
  if (atual > anterior) return "subiu";
  if (atual < anterior) return "caiu";
  return "igual";
}

export const ALERTAS = [
  "pagamento_em_atraso",
  "teste_vencendo",
  "custo_acima_da_mensalidade",
  "teto_de_ia_perto",
  "whatsapp_desconectado",
  "agente_pausado",
  "sem_conversa_nova",
] as const;
export type Alerta = (typeof ALERTAS)[number];

export interface LinhaDoCliente {
  organization_id: string;
  nome: string;
  situacao: Situacao;
  fonte_da_cobranca: "produto" | "manual" | "nenhuma";
  plano: string | null;
  implantacao_cents: number;
  implantacao_paga: boolean;
  mensalidade_cents: number;
  inicio: string | null;
  proximo_vencimento: string | null;
  ultimo_pagamento: { valor_cents: number; pago_em: string } | null;
  dias_em_atraso: number;
  total_pago_cents: number;
  teste_ate: string | null;
  recebido_no_periodo_cents: number;
  ia_usd_cents: number;
  ia_brl_cents: number;
  whatsapp_brl_cents: number;
  whatsapp_estimado: true;
  custo_total_brl_cents: number;
  conversas_ia: number;
  mensagens_ia: number;
  custo_por_conversa_cents: number | null;
  custo_por_lead_cents: number | null;
  custo_por_contrato_cents: number | null;
  margem_cents: number;
  margem_pct: number | null;
  resultado: {
    leads: number;
    qualificados: number;
    passados_para_equipe: number;
    contratos: number;
    contratos_por_lead_pct: number | null;
    mediana_primeira_resposta_seg: number | null;
  };
  tendencias: Record<
    | "leads"
    | "qualificados"
    | "passados_para_equipe"
    | "contratos"
    | "contratos_por_lead_pct"
    | "mediana_primeira_resposta_seg",
    Tendencia
  >;
  alertas: Alerta[];
}

export interface EntradaDaLinha {
  org: { id: string; nome: string; status: string };
  manual: ClienteManual | null;
  assinatura: AssinaturaDoProduto | null;
  pagamentos: readonly PagamentoLancado[];
  numeros: NumerosDaOrg;
  anteriores: NumerosDaOrg;
  config: ConfigDaAgencia;
  periodo: { de: string; ate: string };
  hoje: string;
  agora: Date;
  /** Gasto de IA no mês (fn_gasto_de_ia_do_mes) e o teto de `ai_budgets`, em centavos de dólar. */
  teto: { gasto_mes_usd_cents: number; limite_usd_cents: number | null; alarme_pct: number } | null;
  whatsappComFalha: boolean;
  agentePausado: boolean;
}

function resultado(n: NumerosDaOrg) {
  return {
    leads: n.leads_recebidos,
    qualificados: n.qualificados,
    passados_para_equipe: n.passados_para_equipe,
    contratos: n.ganhos,
    contratos_por_lead_pct:
      n.leads_recebidos > 0 ? Math.round((n.ganhos / n.leads_recebidos) * 1000) / 10 : null,
    mediana_primeira_resposta_seg:
      n.mediana_primeira_resposta_seg === null
        ? null
        : Math.round(Number(n.mediana_primeira_resposta_seg)),
  };
}

export function linhaDoCliente(e: EntradaDaLinha): LinhaDoCliente {
  const { manual, assinatura, config, numeros } = e;
  const pagamentos = [...e.pagamentos].sort(
    (a, b) => b.pago_em.localeCompare(a.pago_em) || b.lancado_em.localeCompare(a.lancado_em),
  );
  const situacao = situacaoDoCliente({
    orgStatus: e.org.status,
    manual,
    assinatura,
    hoje: e.hoje,
    pagamentos: pagamentos.length,
  });
  const mensalidade =
    assinatura?.preco_cents != null
      ? assinatura.intervalo === "ano"
        ? Math.round(assinatura.preco_cents / 12)
        : assinatura.preco_cents
      : (manual?.mensalidade_cents ?? 0);
  const proximoVencimento =
    assinatura?.proximo_vencimento?.slice(0, 10) ?? manual?.proximo_vencimento ?? null;
  const diasAtraso = assinatura
    ? assinatura.estado === "em_atraso" && assinatura.vencida_desde
      ? diasEmAtraso(assinatura.vencida_desde.slice(0, 10), e.hoje)
      : 0
    : diasEmAtraso(manual?.proximo_vencimento ?? null, e.hoje);
  const testeAte = assinatura?.trial_ate?.slice(0, 10) ?? manual?.teste_ate ?? null;
  const recebido = pagamentos
    .filter((p) => p.pago_em >= e.periodo.de && p.pago_em <= e.periodo.ate)
    .reduce((s, p) => s + p.valor_cents, 0);
  const iaBrl = emReais(Number(numeros.ia_custo_usd_cents), config.cotacao_usd_brl);
  const waBrl = custoDoWhatsApp(numeros, config.precos_whatsapp);
  const custo = iaBrl + waBrl;
  const margem = recebido - custo;
  const atual = resultado(numeros);
  const antes = resultado(e.anteriores);

  const alertas: Alerta[] = [];
  if (situacao === "em_atraso") alertas.push("pagamento_em_atraso");
  if (situacao === "teste" && testeAte) {
    const faltam = diasEntre(e.hoje, testeAte);
    if (faltam >= 0 && faltam <= 3) alertas.push("teste_vencendo");
  }
  // Custo do período levado a 30 dias, contra a mensalidade.
  const diasDoPeriodo = Math.max(1, diasEntre(e.periodo.de, e.periodo.ate) + 1);
  if (
    mensalidade > 0 &&
    (custo * 30) / diasDoPeriodo > (mensalidade * config.alerta_custo_pct) / 100
  ) {
    alertas.push("custo_acima_da_mensalidade");
  }
  if (e.teto && e.teto.limite_usd_cents && e.teto.limite_usd_cents > 0) {
    if (e.teto.gasto_mes_usd_cents >= (e.teto.limite_usd_cents * e.teto.alarme_pct) / 100)
      alertas.push("teto_de_ia_perto");
  }
  if (e.whatsappComFalha) alertas.push("whatsapp_desconectado");
  if (e.agentePausado) alertas.push("agente_pausado");
  if (
    situacao !== "cancelada" &&
    situacao !== "sem_cadastro" &&
    (!numeros.ultima_conversa_nova_em ||
      Date.parse(numeros.ultima_conversa_nova_em) < e.agora.getTime() - 48 * 3_600_000)
  ) {
    alertas.push("sem_conversa_nova");
  }

  return {
    organization_id: e.org.id,
    nome: e.org.nome,
    situacao,
    fonte_da_cobranca: assinatura ? "produto" : manual ? "manual" : "nenhuma",
    plano: assinatura?.plano_nome ?? manual?.plano ?? null,
    implantacao_cents: manual?.implantacao_cents ?? 0,
    implantacao_paga: manual?.implantacao_paga ?? false,
    mensalidade_cents: mensalidade,
    inicio: manual?.inicio ?? null,
    proximo_vencimento: proximoVencimento,
    ultimo_pagamento: pagamentos[0]
      ? { valor_cents: pagamentos[0].valor_cents, pago_em: pagamentos[0].pago_em }
      : null,
    dias_em_atraso: diasAtraso,
    total_pago_cents: pagamentos.reduce((s, p) => s + p.valor_cents, 0),
    teste_ate: testeAte,
    recebido_no_periodo_cents: recebido,
    ia_usd_cents: Math.round(Number(numeros.ia_custo_usd_cents)),
    ia_brl_cents: iaBrl,
    whatsapp_brl_cents: waBrl,
    whatsapp_estimado: true,
    custo_total_brl_cents: custo,
    conversas_ia: numeros.conversas_ia,
    mensagens_ia: numeros.mensagens_ia,
    custo_por_conversa_cents: divisao(custo, numeros.conversas_ia),
    custo_por_lead_cents: divisao(custo, numeros.leads_recebidos),
    custo_por_contrato_cents: divisao(custo, numeros.ganhos),
    margem_cents: margem,
    margem_pct: recebido > 0 ? Math.round((margem / recebido) * 1000) / 10 : null,
    resultado: atual,
    tendencias: {
      leads: tendencia(atual.leads, antes.leads),
      qualificados: tendencia(atual.qualificados, antes.qualificados),
      passados_para_equipe: tendencia(atual.passados_para_equipe, antes.passados_para_equipe),
      contratos: tendencia(atual.contratos, antes.contratos),
      contratos_por_lead_pct: tendencia(atual.contratos_por_lead_pct, antes.contratos_por_lead_pct),
      mediana_primeira_resposta_seg: tendencia(
        atual.mediana_primeira_resposta_seg,
        antes.mediana_primeira_resposta_seg,
      ),
    },
    alertas,
  };
}

export interface TotaisDoTopo {
  receita_recorrente_cents: number;
  recebido_no_periodo_cents: number;
  em_atraso_cents: number;
  clientes_por_situacao: Record<Situacao, number>;
  ticket_medio_cents: number | null;
  cancelaram_no_periodo: number;
}

export function totaisDoTopo(
  linhas: readonly LinhaDoCliente[],
  manuais: ReadonlyMap<string, ClienteManual>,
  periodo: { de: string; ate: string },
): TotaisDoTopo {
  const ativos = linhas.filter((l) => l.situacao === "pagante" || l.situacao === "em_atraso");
  const mrr = ativos.reduce((s, l) => s + l.mensalidade_cents, 0);
  const porSituacao = Object.fromEntries(SITUACOES.map((s) => [s, 0])) as Record<Situacao, number>;
  for (const l of linhas) porSituacao[l.situacao] += 1;
  return {
    receita_recorrente_cents: mrr,
    recebido_no_periodo_cents: linhas.reduce((s, l) => s + l.recebido_no_periodo_cents, 0),
    em_atraso_cents: linhas
      .filter((l) => l.situacao === "em_atraso")
      .reduce((s, l) => s + l.mensalidade_cents, 0),
    clientes_por_situacao: porSituacao,
    ticket_medio_cents: ativos.length > 0 ? Math.round(mrr / ativos.length) : null,
    cancelaram_no_periodo: [...manuais.values()].filter(
      (m) => m.cancelada_em && m.cancelada_em >= periodo.de && m.cancelada_em <= periodo.ate,
    ).length,
  };
}

/** O período imediatamente anterior, do mesmo tamanho. */
export function periodoAnterior(p: { de: string; ate: string }): { de: string; ate: string } {
  const dias = diasEntre(p.de, p.ate) + 1;
  const ate = new Date(Date.parse(`${p.de}T00:00:00Z`) - DIA_MS).toISOString().slice(0, 10);
  const de = new Date(Date.parse(`${ate}T00:00:00Z`) - (dias - 1) * DIA_MS)
    .toISOString()
    .slice(0, 10);
  return { de, ate };
}
