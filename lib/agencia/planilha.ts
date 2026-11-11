/**
 * A planilha do painel da agência (PC-028): uma linha por organização, só
 * números agregados — nenhum texto de conversa, nome ou telefone de lead.
 * Valores em reais com vírgula (o Excel em português lê como número).
 */
import type { LinhaDoCliente } from "@/lib/agencia/painel";

const ROTULO_DA_SITUACAO: Record<LinhaDoCliente["situacao"], string> = {
  teste: "Teste",
  pagante: "Pagante",
  em_atraso: "Em atraso",
  suspensa: "Suspensa",
  cancelada: "Cancelada",
  sem_cadastro: "Sem cadastro",
};

function reais(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

function dolares(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

function data(d: string | null): string {
  return d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "";
}

export function planilhaDaAgencia(
  linhas: readonly LinhaDoCliente[],
  t: (s: string) => string = (s) => s,
) {
  const cabecalho = [
    t("Organização"),
    t("Situação"),
    t("Plano"),
    t("Implantação (R$)"),
    t("Implantação paga"),
    t("Mensalidade (R$)"),
    t("Início"),
    t("Próximo vencimento"),
    t("Último pagamento (R$)"),
    t("Último pagamento em"),
    t("Dias em atraso"),
    t("Total pago (R$)"),
    t("Teste vence em"),
    t("Recebido no período (R$)"),
    t("Custo de IA (US$)"),
    t("Custo de IA (R$)"),
    t("Custo do WhatsApp (R$, estimado)"),
    t("Conversas atendidas pela IA"),
    t("Mensagens da IA"),
    t("Custo por conversa (R$)"),
    t("Custo por lead (R$)"),
    t("Custo por contrato (R$)"),
    t("Margem (R$)"),
    t("Margem (%)"),
    t("Leads recebidos"),
    t("Qualificados"),
    t("Passados para a equipe"),
    t("Contratos assinados"),
    t("Contratos por lead (%)"),
    t("Mediana da 1ª resposta (s)"),
    t("Alertas"),
  ];
  const linhasDaPlanilha = linhas.map((l) => [
    l.nome,
    t(ROTULO_DA_SITUACAO[l.situacao]),
    l.plano ?? "",
    reais(l.implantacao_cents),
    l.implantacao_paga ? t("Sim") : t("Não"),
    reais(l.mensalidade_cents),
    data(l.inicio),
    data(l.proximo_vencimento),
    reais(l.ultimo_pagamento?.valor_cents ?? null),
    data(l.ultimo_pagamento?.pago_em ?? null),
    String(l.dias_em_atraso),
    reais(l.total_pago_cents),
    data(l.teste_ate),
    reais(l.recebido_no_periodo_cents),
    dolares(l.ia_usd_cents),
    reais(l.ia_brl_cents),
    reais(l.whatsapp_brl_cents),
    String(l.conversas_ia),
    String(l.mensagens_ia),
    reais(l.custo_por_conversa_cents),
    reais(l.custo_por_lead_cents),
    reais(l.custo_por_contrato_cents),
    reais(l.margem_cents),
    l.margem_pct === null ? "" : String(l.margem_pct).replace(".", ","),
    String(l.resultado.leads),
    String(l.resultado.qualificados),
    String(l.resultado.passados_para_equipe),
    String(l.resultado.contratos),
    l.resultado.contratos_por_lead_pct === null
      ? ""
      : String(l.resultado.contratos_por_lead_pct).replace(".", ","),
    l.resultado.mediana_primeira_resposta_seg === null
      ? ""
      : String(l.resultado.mediana_primeira_resposta_seg),
    l.alertas.join("; "),
  ]);
  return { cabecalho, linhas: linhasDaPlanilha };
}
