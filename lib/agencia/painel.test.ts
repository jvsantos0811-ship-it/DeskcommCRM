import { describe, expect, it } from "vitest";

import {
  custoDoWhatsApp,
  diasEmAtraso,
  linhaDoCliente,
  NUMEROS_VAZIOS,
  periodoAnterior,
  situacaoDoCliente,
  totaisDoTopo,
  umMesDepois,
  type ClienteManual,
  type EntradaDaLinha,
  type PagamentoLancado,
} from "./painel";
import { planilhaDaAgencia } from "./planilha";

const hoje = "2026-11-10";
const agora = new Date("2026-11-10T15:00:00.000Z");
const config = {
  cotacao_usd_brl: 5.5,
  precos_whatsapp: { marketing: 35, utilidade: 4, autenticacao: 4 },
  alerta_custo_pct: 15,
};
const manual = (extra: Partial<ClienteManual> = {}): ClienteManual => ({
  organization_id: "org",
  plano: "Crescimento",
  implantacao_cents: 150000,
  implantacao_paga: true,
  mensalidade_cents: 100000,
  inicio: "2026-08-01",
  proximo_vencimento: "2026-11-15",
  teste_ate: null,
  cancelada_em: null,
  observacao: null,
  ...extra,
});
const pagamento = (id: string, pago_em: string, valor_cents: number): PagamentoLancado => ({
  id,
  organization_id: "org",
  tipo: "mensalidade",
  pago_em,
  valor_cents,
  forma: "pix",
  observacao: null,
  lancado_por: "dono",
  lancado_em: `${pago_em}T12:00:00Z`,
});
const entrada = (extra: Partial<EntradaDaLinha> = {}): EntradaDaLinha => ({
  org: { id: "org", nome: "Escritório", status: "active" },
  manual: manual(),
  assinatura: null,
  pagamentos: [],
  numeros: { ...NUMEROS_VAZIOS, ultima_conversa_nova_em: "2026-11-10T10:00:00Z" },
  anteriores: NUMEROS_VAZIOS,
  config,
  periodo: { de: "2026-11-01", ate: "2026-11-30" },
  hoje,
  agora,
  teto: null,
  whatsappComFalha: false,
  agentePausado: false,
  ...extra,
});

describe("cobrança da agência (PC-028)", () => {
  it("dias em atraso e o vencimento que anda um mês", () => {
    expect(diasEmAtraso("2026-11-05", hoje)).toBe(5);
    expect(diasEmAtraso("2026-11-15", hoje)).toBe(0);
    expect(umMesDepois("2026-01-31")).toBe("2026-02-28");
    expect(umMesDepois("2026-11-10")).toBe("2026-12-10");
  });

  it("situação: suspensa, cancelada, produto, teste, atraso, pagante, sem cadastro", () => {
    const base = { manual: manual(), assinatura: null, hoje, pagamentos: 1 };
    expect(situacaoDoCliente({ ...base, orgStatus: "suspended" })).toBe("suspensa");
    expect(
      situacaoDoCliente({
        ...base,
        orgStatus: "active",
        manual: manual({ cancelada_em: "2026-11-02" }),
      }),
    ).toBe("cancelada");
    expect(
      situacaoDoCliente({
        ...base,
        orgStatus: "active",
        manual: manual({ proximo_vencimento: "2026-11-01" }),
      }),
    ).toBe("em_atraso");
    expect(situacaoDoCliente({ ...base, orgStatus: "active" })).toBe("pagante");
    expect(
      situacaoDoCliente({
        ...base,
        orgStatus: "active",
        manual: manual({ teste_ate: "2026-11-12" }),
        pagamentos: 0,
      }),
    ).toBe("teste");
    expect(situacaoDoCliente({ ...base, orgStatus: "active", manual: null })).toBe("sem_cadastro");
    expect(
      situacaoDoCliente({
        ...base,
        orgStatus: "active",
        assinatura: {
          estado: "em_atraso",
          plano_nome: "X",
          preco_cents: 1,
          intervalo: "mes",
          trial_ate: null,
          vencida_desde: null,
          proximo_vencimento: null,
        },
      }),
    ).toBe("em_atraso");
  });

  it("totais conferem com a conta à mão: total pago, recebido no período, dias em atraso", () => {
    const l = linhaDoCliente(
      entrada({
        manual: manual({ proximo_vencimento: "2026-11-05" }),
        pagamentos: [
          pagamento("a", "2026-10-05", 100000),
          pagamento("b", "2026-11-02", 60000),
          pagamento("c", "2026-11-08", 40000),
        ],
      }),
    );
    expect(l.situacao).toBe("em_atraso");
    expect(l.dias_em_atraso).toBe(5);
    expect(l.total_pago_cents).toBe(200000);
    expect(l.recebido_no_periodo_cents).toBe(100000);
    expect(l.ultimo_pagamento).toEqual({ valor_cents: 40000, pago_em: "2026-11-08" });
  });

  it("custo por conversa = (IA + WhatsApp) ÷ conversas; WhatsApp estimado pela tabela; margem", () => {
    const numeros = {
      ...NUMEROS_VAZIOS,
      ultima_conversa_nova_em: "2026-11-10T10:00:00Z",
      ia_custo_usd_cents: 500,
      conversas_ia: 2,
      modelos_marketing: 2,
      modelos_gratis_anuncio: 5,
      leads_recebidos: 4,
      ganhos: 1,
    };
    expect(custoDoWhatsApp(numeros, config.precos_whatsapp)).toBe(70);
    const l = linhaDoCliente(
      entrada({ numeros, pagamentos: [pagamento("b", "2026-11-02", 100000)] }),
    );
    expect(l.ia_brl_cents).toBe(2750);
    expect(l.whatsapp_brl_cents).toBe(70);
    expect(l.whatsapp_estimado).toBe(true);
    expect(l.custo_total_brl_cents).toBe(2820);
    expect(l.custo_por_conversa_cents).toBe(1410);
    expect(l.custo_por_lead_cents).toBe(705);
    expect(l.custo_por_contrato_cents).toBe(2820);
    expect(l.margem_cents).toBe(100000 - 2820);
    expect(l.resultado.contratos_por_lead_pct).toBe(25);
  });

  it("cada alerta aparece no seu cenário", () => {
    const alertas = (e: Partial<EntradaDaLinha>) => linhaDoCliente(entrada(e)).alertas;
    expect(alertas({})).toEqual([]);
    expect(alertas({ manual: manual({ proximo_vencimento: "2026-11-01" }) })).toContain(
      "pagamento_em_atraso",
    );
    expect(
      alertas({ manual: manual({ teste_ate: "2026-11-12", mensalidade_cents: 0 }) }),
    ).toContain("teste_vencendo");
    expect(
      alertas({
        numeros: {
          ...NUMEROS_VAZIOS,
          ultima_conversa_nova_em: "2026-11-10T10:00:00Z",
          ia_custo_usd_cents: 4000,
        },
      }),
    ).toContain("custo_acima_da_mensalidade"); // 220,00 em 30 dias > 15% de 1.000,00
    expect(
      alertas({ teto: { gasto_mes_usd_cents: 4100, limite_usd_cents: 5000, alarme_pct: 80 } }),
    ).toContain("teto_de_ia_perto");
    expect(
      alertas({ teto: { gasto_mes_usd_cents: 3000, limite_usd_cents: 5000, alarme_pct: 80 } }),
    ).not.toContain("teto_de_ia_perto");
    expect(alertas({ whatsappComFalha: true })).toContain("whatsapp_desconectado");
    expect(alertas({ agentePausado: true })).toContain("agente_pausado");
    expect(
      alertas({ numeros: { ...NUMEROS_VAZIOS, ultima_conversa_nova_em: "2026-11-07T10:00:00Z" } }),
    ).toContain("sem_conversa_nova");
  });

  it("totais do topo e período anterior", () => {
    const a = linhaDoCliente(entrada({ pagamentos: [pagamento("x", "2026-11-03", 100000)] }));
    const b = linhaDoCliente(
      entrada({
        org: { id: "b", nome: "B", status: "active" },
        manual: manual({
          organization_id: "b",
          proximo_vencimento: "2026-11-01",
          mensalidade_cents: 50000,
        }),
      }),
    );
    const c = linhaDoCliente(
      entrada({
        org: { id: "c", nome: "C", status: "active" },
        manual: manual({ organization_id: "c", cancelada_em: "2026-11-04" }),
      }),
    );
    const manuais = new Map([["c", manual({ organization_id: "c", cancelada_em: "2026-11-04" })]]);
    const t = totaisDoTopo([a, b, c], manuais, { de: "2026-11-01", ate: "2026-11-30" });
    expect(t.receita_recorrente_cents).toBe(150000);
    expect(t.recebido_no_periodo_cents).toBe(100000);
    expect(t.em_atraso_cents).toBe(50000);
    expect(t.ticket_medio_cents).toBe(75000);
    expect(t.cancelaram_no_periodo).toBe(1);
    expect(t.clientes_por_situacao.cancelada).toBe(1);
    expect(periodoAnterior({ de: "2026-11-01", ate: "2026-11-30" })).toEqual({
      de: "2026-10-02",
      ate: "2026-10-31",
    });
  });

  it("a planilha só tem números agregados por organização", () => {
    const l = linhaDoCliente(entrada());
    const { cabecalho, linhas } = planilhaDaAgencia([l]);
    expect(cabecalho).toContain("Custo do WhatsApp (R$, estimado)");
    expect(linhas[0]![0]).toBe("Escritório");
    expect(linhas[0]).toHaveLength(cabecalho.length);
  });
});
