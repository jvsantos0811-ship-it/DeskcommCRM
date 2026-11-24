import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/cobranca/provedores", () => ({ adaptador: vi.fn() }));
vi.mock("@/lib/agencia/ler", () => ({ lerConfigDaAgencia: vi.fn(async () => ({ cotacao_usd_brl: 5 })) }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import {
  conferirCreditosPendentes,
  extratoDoMes,
  iniciarCompraDeCredito,
  saldoDoCredito,
  vencimentoDoCredito,
} from "@/lib/cobranca/credito-ia";
import { ErroDoProvedor, type AdaptadorDeCobranca } from "@/lib/cobranca/provedores/contrato";

describe("as contas do crédito de IA (PC-051)", () => {
  it("vence no fim do mês SEGUINTE ao do pagamento", () => {
    expect(vencimentoDoCredito(new Date("2026-11-23T15:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(vencimentoDoCredito(new Date("2026-12-31T23:59:00Z")).toISOString()).toBe("2027-02-01T00:00:00.000Z");
  });

  it("o consumo é primeiro o incluído no plano, depois o crédito", () => {
    expect(saldoDoCredito({ tetoDoPlano: 1000, gasto: 800, creditoDoMes: 500 })).toBe(500);
    expect(saldoDoCredito({ tetoDoPlano: 1000, gasto: 1200, creditoDoMes: 500 })).toBe(300);
    expect(saldoDoCredito({ tetoDoPlano: 1000, gasto: 1900, creditoDoMes: 500 })).toBe(0);
  });

  it("⭐ o cliente vê PORCENTAGEM — nunca dólar nem o custo convertido", () => {
    expect(extratoDoMes({ tetoDoPlano: 1000, gasto: 730, creditoDoMes: 0 })).toEqual({ uso_do_plano_pct: 73, credito_restante_pct: null });
    expect(extratoDoMes({ tetoDoPlano: 1000, gasto: 1200, creditoDoMes: 500 })).toEqual({ uso_do_plano_pct: 100, credito_restante_pct: 60 });
    expect(extratoDoMes({ tetoDoPlano: 1000, gasto: 1900, creditoDoMes: 500 })).toEqual({ uso_do_plano_pct: 100, credito_restante_pct: 0 });
  });
});

/** Um dublê mínimo do PostgREST: cada `from(tabela)` devolve o que o teste quiser e registra os updates. */
function adminFalso(respostas: {
  pendentes?: unknown[];
  gravada?: (mudanca: Record<string, unknown>) => unknown;
  assinatura?: unknown;
  plano?: unknown;
  pacotes?: unknown[];
  aberta?: unknown;
  nova?: unknown;
  /** O update do link da compra (pagamento_ref) falha. */
  erroNoLink?: boolean;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];
  function consulta(tabela: string) {
    let mudanca: Record<string, unknown> | null = null;
    let inserido: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {};
    const encadeia = () => q;
    for (const m of ["select", "eq", "not", "is", "gte", "order", "limit"]) q[m] = encadeia;
    q.update = (v: Record<string, unknown>) => {
      mudanca = v;
      updates.push(v);
      return q;
    };
    q.insert = (v: Record<string, unknown>) => {
      inserido = v;
      inserts.push(v);
      return q;
    };
    const resultado = () => {
      if (tabela === "ia_creditos" && mudanca && respostas.erroNoLink && "pagamento_ref" in mudanca) {
        return { data: null, error: { code: "57014" } };
      }
      if (tabela === "ia_creditos" && mudanca) return { data: respostas.gravada ? respostas.gravada(mudanca) : null, error: null };
      if (tabela === "ia_creditos" && inserido) return { data: respostas.nova ?? null, error: null };
      if (tabela === "ia_creditos") return { data: respostas.aberta ?? null, error: null };
      if (tabela === "cobranca_assinaturas") return { data: respostas.assinatura ?? null, error: null };
      if (tabela === "cobranca_planos") return { data: respostas.plano ?? null, error: null };
      return { data: null, error: null };
    };
    q.maybeSingle = async () => resultado();
    q.single = async () => resultado();
    q.then = (ok: (v: unknown) => unknown) => {
      if (tabela === "ia_creditos" && !mudanca && !inserido) return Promise.resolve({ data: respostas.pendentes ?? [], error: null }).then(ok);
      if (tabela === "cobranca_pacotes_credito_ia") return Promise.resolve({ data: respostas.pacotes ?? [], error: null }).then(ok);
      return Promise.resolve(resultado()).then(ok);
    };
    return q;
  }
  return { admin: { from: (t: string) => consulta(t) } as unknown as SupabaseClient, updates, inserts };
}

const PENDENTE = {
  id: "11111111-0000-4000-8000-000000000001",
  origem: "compra",
  status: "pendente",
  preco_cents: 10000,
  ia_usd_cents: 1500,
  provedor: "asaas",
  pagamento_ref: "pay_1",
  link_pagamento: "https://www.asaas.com/i/1",
  pago_em: null,
  vence_em: null,
  created_at: "2026-11-23T10:00:00Z",
};

describe("conferir as compras pendentes", () => {
  it("⭐ pago vira crédito UMA vez: o compare-and-set em pendente barra o segundo sinal", async () => {
    const ler = vi.fn<AdaptadorDeCobranca["lerPagamentoProporcional"]>().mockResolvedValue("pago");
    const adaptadorDe = () => ({ lerPagamentoProporcional: ler }) as unknown as AdaptadorDeCobranca;
    vi.mocked(audit).mockClear();
    let jaGravou = false;
    const { admin, updates } = adminFalso({
      pendentes: [PENDENTE],
      gravada: () => {
        if (jaGravou) return null;
        jaGravou = true;
        return { id: PENDENTE.id };
      },
    });
    const agora = () => new Date("2026-11-23T15:00:00Z");
    expect(await conferirCreditosPendentes(admin, "org", { adaptadorDe, agora })).toBe(1);
    expect(await conferirCreditosPendentes(admin, "org", { adaptadorDe, agora })).toBe(0);
    expect(updates[0]).toMatchObject({ status: "pago", vence_em: "2027-01-01T00:00:00.000Z" });
    expect(vi.mocked(audit).mock.calls.filter(([e]) => e.action === "cobranca.credito_ia_pago")).toHaveLength(1);
  });

  it("pendente no provedor não muda nada; encerrado cancela; falha do provedor não lança", async () => {
    const ler = vi
      .fn<AdaptadorDeCobranca["lerPagamentoProporcional"]>()
      .mockResolvedValueOnce("pendente")
      .mockResolvedValueOnce("encerrado")
      .mockRejectedValueOnce(new ErroDoProvedor(503, "fora", true));
    const adaptadorDe = () => ({ lerPagamentoProporcional: ler }) as unknown as AdaptadorDeCobranca;
    const { admin, updates } = adminFalso({ pendentes: [PENDENTE], gravada: () => ({ id: PENDENTE.id }) });
    expect(await conferirCreditosPendentes(admin, "org", { adaptadorDe })).toBe(0);
    expect(updates).toHaveLength(0);
    expect(await conferirCreditosPendentes(admin, "org", { adaptadorDe })).toBe(0);
    expect(updates[0]).toEqual({ status: "cancelado" });
    await expect(conferirCreditosPendentes(admin, "org", { adaptadorDe })).resolves.toBe(0);
  });
});

describe("o botão Comprar", () => {
  const ASSINATURA = { plano_id: "p1", estado: "ativa", provedor: "asaas", provedor_cliente_id: "cus_1" };
  const PACOTE = { id: "22222222-0000-4000-8000-000000000002", nome: "R$ 100", preco_cents: 10000, ia_usd_cents: 1500, arquivado_em: null };

  it("⭐ sem pacote, ou plano sem a oferta, nada é cobrado (como antes)", async () => {
    const iniciar = vi.fn();
    const adaptadorDe = () => ({ iniciarCompraDeCredito: iniciar }) as unknown as AdaptadorDeCobranca;
    const semPacote = adminFalso({ assinatura: ASSINATURA, plano: { teto_ia_usd_cents: 9100, oferece_credito_ia: true }, pacotes: [] });
    const r1 = await iniciarCompraDeCredito(semPacote.admin, { orgId: "org", pacoteId: PACOTE.id, actorUserId: "u", requestId: "r", adaptadorDe });
    expect(r1).toMatchObject({ ok: false, status: 409, code: "sem_pacote" });
    const semOferta = adminFalso({ assinatura: ASSINATURA, plano: { teto_ia_usd_cents: 9100, oferece_credito_ia: false }, pacotes: [PACOTE] });
    const r2 = await iniciarCompraDeCredito(semOferta.admin, { orgId: "org", pacoteId: PACOTE.id, actorUserId: "u", requestId: "r", adaptadorDe });
    expect(r2).toMatchObject({ ok: false, code: "plano_sem_oferta" });
    expect(iniciar).not.toHaveBeenCalled();
    expect(semPacote.inserts).toHaveLength(0);
  });

  it("⭐ teste grátis, atraso ou cancelada: não compra (a avulsa paga não pode virar 'já pagou')", async () => {
    const iniciar = vi.fn();
    const adaptadorDe = () => ({ iniciarCompraDeCredito: iniciar }) as unknown as AdaptadorDeCobranca;
    for (const estado of ["trial", "em_atraso", "cancelada", "suspensa"]) {
      const { admin, inserts } = adminFalso({
        assinatura: { ...ASSINATURA, estado },
        plano: { teto_ia_usd_cents: 9100, oferece_credito_ia: true },
        pacotes: [PACOTE],
      });
      const r = await iniciarCompraDeCredito(admin, { orgId: "org", pacoteId: PACOTE.id, actorUserId: "u", requestId: "r", adaptadorDe });
      expect(r, estado).toMatchObject({ ok: false, status: 409, code: "assinatura_nao_ativa" });
      expect(inserts).toHaveLength(0);
    }
    expect(iniciar).not.toHaveBeenCalled();
  });

  it("o link não foi gravado (nem na 2ª tentativa): não entrega o link e cancela a linha", async () => {
    const iniciar = vi.fn<AdaptadorDeCobranca["iniciarCompraDeCredito"]>().mockResolvedValue({ pagamentoRef: "pay_9", url: "https://www.asaas.com/i/9" });
    const adaptadorDe = () => ({ iniciarCompraDeCredito: iniciar }) as unknown as AdaptadorDeCobranca;
    const f = adminFalso({ assinatura: ASSINATURA, plano: { teto_ia_usd_cents: 9100, oferece_credito_ia: true }, pacotes: [PACOTE], nova: { id: "c1" }, erroNoLink: true });
    const r = await iniciarCompraDeCredito(f.admin, { orgId: "org", pacoteId: PACOTE.id, actorUserId: "u", requestId: "r", adaptadorDe });
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(f.updates.filter((u) => "pagamento_ref" in u)).toHaveLength(2);
    expect(f.updates.at(-1)).toEqual({ status: "cancelado" });
  });

  it("sem cadastro de pagamento da assinatura: recusa com o motivo", async () => {
    const { admin } = adminFalso({
      assinatura: { ...ASSINATURA, provedor_cliente_id: null },
      plano: { teto_ia_usd_cents: 9100, oferece_credito_ia: true },
      pacotes: [PACOTE],
    });
    const r = await iniciarCompraDeCredito(admin, { orgId: "org", pacoteId: PACOTE.id, actorUserId: "u", requestId: "r" });
    expect(r).toMatchObject({ ok: false, code: "sem_cadastro_de_pagamento" });
  });

  it("compra nasce pendente com o preço do pacote; o link do provedor volta; falha do provedor cancela a linha", async () => {
    const iniciar = vi
      .fn<AdaptadorDeCobranca["iniciarCompraDeCredito"]>()
      .mockResolvedValueOnce({ pagamentoRef: "pay_9", url: "https://www.asaas.com/i/9" })
      .mockRejectedValueOnce(new ErroDoProvedor(503, "fora", true));
    const adaptadorDe = () => ({ iniciarCompraDeCredito: iniciar }) as unknown as AdaptadorDeCobranca;
    const base = { assinatura: ASSINATURA, plano: { teto_ia_usd_cents: 9100, oferece_credito_ia: true }, pacotes: [PACOTE], nova: { id: "c1" } };
    const ok = adminFalso(base);
    const r = await iniciarCompraDeCredito(ok.admin, { orgId: "org", pacoteId: PACOTE.id, actorUserId: "u", requestId: "r", adaptadorDe });
    expect(r).toEqual({ ok: true, url: "https://www.asaas.com/i/9", creditoId: "c1" });
    expect(ok.inserts[0]).toMatchObject({ status: "pendente", origem: "compra", preco_cents: 10000, ia_usd_cents: 1500, provedor: "asaas" });
    expect(iniciar.mock.calls[0]![0]).toMatchObject({ clienteRef: "cus_1", valorCents: 10000, chaveIdempotencia: "c1" });

    const falha = adminFalso(base);
    const r2 = await iniciarCompraDeCredito(falha.admin, { orgId: "org", pacoteId: PACOTE.id, actorUserId: "u", requestId: "r", adaptadorDe });
    expect(r2).toMatchObject({ ok: false, status: 503, code: "provedor_recusou" });
    expect(falha.updates[0]).toEqual({ status: "cancelado" });
  });
});
