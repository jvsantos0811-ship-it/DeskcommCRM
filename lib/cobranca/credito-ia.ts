/**
 * CRÉDITO DE IA (PC-051): a 4ª saída quando o teto de IA do plano acaba.
 *
 * O teto do plano (`cobranca_planos.teto_ia_usd_cents`) bloqueia a chave da
 * instalação quando o gasto do mês o alcança. Com crédito pago que ainda vale,
 * o teto do mês passa a ser `teto do plano + crédito`
 * (`fn_credito_de_ia_disponivel`, migration 9040) — a régua mora no banco e é a
 * mesma no gate do engine (`SQL_TETO_DO_PLANO`) e no caminho legado.
 *
 * Aqui mora o que a TELA e a COBRANÇA precisam:
 *   - `lerExtratoDeCredito`: o que a empresa vê em Plano e cobrança — o uso do
 *     plano e o crédito restante em PORCENTAGEM, e as compras pelo valor PAGO em
 *     reais. Nunca dólar e nunca o custo da IA convertido (que mostraria ao
 *     cliente quanto do plano é custo);
 *   - `iniciarCompraDeCredito`: o botão "Comprar" — linha `pendente` + link do
 *     provedor que a empresa já usa na assinatura;
 *   - `conferirCreditosPendentes`: chamada por `sincronizar` (aviso do provedor,
 *     reconciliação do cron e "Já paguei"). Crédito só vira `pago` com o
 *     pagamento RELIDO no provedor — o aviso do webhook só acorda a leitura —, e
 *     o compare-and-set em `status = 'pendente'` impede crédito em dobro.
 *
 * Regras do João (23/11/2026): o crédito vence no fim do mês SEGUINTE ao do
 * pagamento; só o comprado passa de um mês para o outro; o consumo é primeiro o
 * incluído no plano, depois o crédito mais antigo. Nada é cobrado sem o clique
 * do admin da empresa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { adaptador as adaptadorPadrao } from "@/lib/cobranca/provedores";
import { ErroDoProvedor, type AdaptadorDeCobranca } from "@/lib/cobranca/provedores/contrato";
import { urlDoPainelDaEmpresa } from "@/lib/cobranca/url";
import type { ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { logger } from "@/lib/logger";

/** Linha de `ia_creditos` como a tela e a conferência a leem. */
export interface LinhaDeCredito {
  id: string;
  origem: "compra" | "cortesia";
  status: "pendente" | "pago" | "cancelado";
  preco_cents: number | null;
  ia_usd_cents: number;
  provedor: ProvedorDeCobranca | null;
  pagamento_ref: string | null;
  link_pagamento: string | null;
  pago_em: string | null;
  vence_em: string | null;
  created_at: string;
}

const COLUNAS_DO_CREDITO =
  "id, origem, status, preco_cents, ia_usd_cents, provedor, pagamento_ref, link_pagamento, pago_em, vence_em, created_at";

export interface PacoteDeCredito {
  id: string;
  nome: string;
  preco_cents: number;
  ia_usd_cents: number;
  arquivado_em: string | null;
}

export const COLUNAS_DO_PACOTE = "id, nome, preco_cents, ia_usd_cents, arquivado_em, created_at, updated_at";

/** Por que a empresa não vê a compra. `null` = vê. */
export type MotivoSemOferta =
  | "sem_assinatura"
  | "sem_teto"
  | "plano_sem_oferta"
  | "sem_pacote"
  /** Teste grátis, atraso ou cancelada: o crédito só se compra com o plano em dia. */
  | "assinatura_nao_ativa"
  | "sem_cadastro_de_pagamento";

/**
 * O crédito pago vale até o fim do mês SEGUINTE ao do pagamento. O mês é o do
 * banco (`date_trunc('month', ...)` em UTC, a mesma régua de
 * `fn_gasto_de_ia_do_mes`). Devolve o instante em que deixa de valer
 * (exclusivo): o 1º dia do 2º mês depois do pagamento, 00:00 UTC.
 */
export function vencimentoDoCredito(pagoEm: Date): Date {
  return new Date(Date.UTC(pagoEm.getUTCFullYear(), pagoEm.getUTCMonth() + 2, 1));
}

/**
 * O extrato do mês em PORCENTAGEM: quanto do incluído no plano já foi usado (0 a
 * 100) e quanto do crédito que vale no mês ainda resta (`null` sem crédito).
 */
export function extratoDoMes(p: { tetoDoPlano: number; gasto: number; creditoDoMes: number }): {
  uso_do_plano_pct: number;
  credito_restante_pct: number | null;
} {
  const uso = p.tetoDoPlano > 0 ? Math.min(100, Math.round((p.gasto / p.tetoDoPlano) * 100)) : 100;
  const restante =
    p.creditoDoMes > 0 ? Math.round((saldoDoCredito(p) / p.creditoDoMes) * 100) : null;
  return { uso_do_plano_pct: Math.max(0, uso), credito_restante_pct: restante };
}

/**
 * O que sobra do crédito NESTE mês. `creditoDoMes` é o crédito que vale no mês
 * antes do consumo dele (`fn_credito_de_ia_disponivel`); o consumo do mês come
 * primeiro o incluído no plano, depois o crédito.
 */
export function saldoDoCredito(p: { tetoDoPlano: number; gasto: number; creditoDoMes: number }): number {
  const alemDoPlano = Math.max(0, p.gasto - p.tetoDoPlano);
  return Math.max(0, p.creditoDoMes - alemDoPlano);
}

export interface ExtratoDeCredito {
  motivoSemOferta: MotivoSemOferta | null;
  /** Pacotes à venda (só quando `motivoSemOferta` é null). Preço em centavos de real. */
  pacotes: Array<{ id: string; nome: string; preco_cents: number }>;
  /** Em PORCENTAGEM (nunca dólar nem custo). `null` quando o plano não tem teto de IA. */
  mes: {
    uso_do_plano_pct: number;
    credito_restante_pct: number | null;
  } | null;
  pendentes: Array<{ id: string; preco_cents: number; link: string | null; criado_em: string }>;
  historico: Array<{
    id: string;
    origem: "compra" | "cortesia";
    status: "pendente" | "pago" | "cancelado";
    /** O valor PAGO, em centavos de real; `null` na cortesia. */
    preco_cents: number | null;
    pago_em: string | null;
    vence_em: string | null;
    criado_em: string;
  }>;
}

interface Assinatura {
  plano_id: string | null;
  estado: string | null;
  provedor: ProvedorDeCobranca | null;
  provedor_cliente_id: string | null;
}

async function lerAssinatura(admin: SupabaseClient, orgId: string): Promise<Assinatura | null> {
  const { data, error } = await admin
    .from("cobranca_assinaturas")
    .select("plano_id, estado, provedor, provedor_cliente_id")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`credito_ia: assinatura ilegível (${error.code ?? "sem_codigo"})`);
  return (data as Assinatura | null) ?? null;
}

async function pacotesAtivos(admin: SupabaseClient): Promise<PacoteDeCredito[]> {
  const { data, error } = await admin
    .from("cobranca_pacotes_credito_ia")
    .select(COLUNAS_DO_PACOTE)
    .is("arquivado_em", null)
    .order("preco_cents", { ascending: true });
  if (error) throw new Error(`credito_ia: pacotes ilegíveis (${error.code ?? "sem_codigo"})`);
  return (data ?? []) as PacoteDeCredito[];
}

/**
 * A oferta vale para ESTA empresa? Assinatura com plano que tem teto de IA e
 * `oferece_credito_ia`, pacote ativo e cadastro no provedor (a compra usa o
 * mesmo cliente da assinatura). Lê o plano e os pacotes; não chama o provedor.
 */
async function lerOferta(
  admin: SupabaseClient,
  orgId: string,
): Promise<{ motivo: MotivoSemOferta | null; assinatura: Assinatura | null; tetoUsd: number | null; pacotes: PacoteDeCredito[] }> {
  const assinatura = await lerAssinatura(admin, orgId);
  if (!assinatura || assinatura.plano_id === null) return { motivo: "sem_assinatura", assinatura, tetoUsd: null, pacotes: [] };
  const { data: plano, error } = await admin
    .from("cobranca_planos")
    .select("teto_ia_usd_cents, oferece_credito_ia")
    .eq("id", assinatura.plano_id)
    .maybeSingle();
  if (error) throw new Error(`credito_ia: plano ilegível (${error.code ?? "sem_codigo"})`);
  const p = plano as { teto_ia_usd_cents: number | null; oferece_credito_ia: boolean | null } | null;
  const tetoUsd = p?.teto_ia_usd_cents ?? null;
  if (tetoUsd === null) return { motivo: "sem_teto", assinatura, tetoUsd, pacotes: [] };
  if (p?.oferece_credito_ia !== true) return { motivo: "plano_sem_oferta", assinatura, tetoUsd, pacotes: [] };
  const pacotes = await pacotesAtivos(admin);
  if (pacotes.length === 0) return { motivo: "sem_pacote", assinatura, tetoUsd, pacotes };
  // Teste grátis com o 1º pagamento pendente: a cobrança avulsa paga não pode
  // ser lida como "já pagou" pela leitura da assinatura (e virar suspensão).
  if (assinatura.estado !== "ativa") return { motivo: "assinatura_nao_ativa", assinatura, tetoUsd, pacotes };
  if (assinatura.provedor === null || assinatura.provedor_cliente_id === null) {
    return { motivo: "sem_cadastro_de_pagamento", assinatura, tetoUsd, pacotes };
  }
  return { motivo: null, assinatura, tetoUsd, pacotes };
}

async function numeroDaRpc(admin: SupabaseClient, fn: string, orgId: string): Promise<number> {
  const { data, error } = await admin.rpc(fn, { p_org: orgId });
  if (error) throw new Error(`credito_ia: ${fn} falhou (${error.code ?? "sem_codigo"})`);
  return Number(data ?? 0);
}

/** O extrato da tela de Plano e cobrança. A organização vem da sessão, nunca do corpo. */
export async function lerExtratoDeCredito(admin: SupabaseClient, orgId: string): Promise<ExtratoDeCredito> {
  const oferta = await lerOferta(admin, orgId);
  const { data: linhas, error } = await admin
    .from("ia_creditos")
    .select(COLUNAS_DO_CREDITO)
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(`credito_ia: créditos ilegíveis (${error.code ?? "sem_codigo"})`);
  const creditos = (linhas ?? []) as LinhaDeCredito[];

  let mes: ExtratoDeCredito["mes"] = null;
  if (oferta.tetoUsd !== null) {
    const [gasto, creditoDoMes] = await Promise.all([
      numeroDaRpc(admin, "fn_gasto_de_ia_do_mes", orgId),
      numeroDaRpc(admin, "fn_credito_de_ia_disponivel", orgId),
    ]);
    mes = extratoDoMes({ tetoDoPlano: oferta.tetoUsd, gasto, creditoDoMes });
  }

  return {
    motivoSemOferta: oferta.motivo,
    pacotes: oferta.motivo === null ? oferta.pacotes.map((p) => ({ id: p.id, nome: p.nome, preco_cents: p.preco_cents })) : [],
    mes,
    pendentes: creditos
      .filter((c) => c.status === "pendente" && c.origem === "compra")
      .map((c) => ({ id: c.id, preco_cents: c.preco_cents ?? 0, link: c.link_pagamento, criado_em: c.created_at })),
    historico: creditos.map((c) => ({
      id: c.id,
      origem: c.origem,
      status: c.status,
      preco_cents: c.preco_cents,
      pago_em: c.pago_em,
      vence_em: c.vence_em,
      criado_em: c.created_at,
    })),
  };
}

function auditar(
  action: AuditAction,
  orgId: string,
  creditoId: string,
  actorUserId: string | null,
  metadata: Record<string, unknown>,
  requestId?: string,
): void {
  void audit({
    action,
    actorUserId,
    organizationId: orgId,
    bypassedRls: true,
    resourceType: "ia_credito",
    resourceId: creditoId,
    ...(requestId === undefined ? {} : { requestId }),
    metadata,
  });
}

export type ResultadoDaCompra =
  | { ok: true; url: string; creditoId: string }
  | { ok: false; status: number; code: string; message: string };

/** Clique duplo na mesma compra devolve o MESMO link dentro desta janela. */
const REUSO_DO_LINK_MS = 24 * 3_600_000;

/**
 * O botão "Comprar". Nunca dentro de transação: a linha nasce `pendente`, o
 * provedor é chamado fora, e a linha recebe a referência e o link. Falha do
 * provedor cancela a linha (não fica compra fantasma na tela).
 */
export async function iniciarCompraDeCredito(
  admin: SupabaseClient,
  p: {
    orgId: string;
    pacoteId: string;
    actorUserId: string;
    requestId: string;
    adaptadorDe?: (id: ProvedorDeCobranca) => AdaptadorDeCobranca;
    agora?: () => Date;
  },
): Promise<ResultadoDaCompra> {
  const agora = p.agora ?? (() => new Date());
  const oferta = await lerOferta(admin, p.orgId);
  if (oferta.motivo !== null) {
    return {
      ok: false,
      status: 409,
      code: oferta.motivo,
      message:
        oferta.motivo === "sem_cadastro_de_pagamento"
          ? "A compra de crédito usa o cadastro de pagamento da assinatura, e esta empresa ainda não tem. Assine o plano pelo CRM ou fale com o suporte."
          : oferta.motivo === "assinatura_nao_ativa"
            ? "A compra de crédito fica disponível com a assinatura ativa e o pagamento do plano em dia."
            : "O seu plano não oferece compra de crédito de IA.",
    };
  }
  const pacote = oferta.pacotes.find((x) => x.id === p.pacoteId);
  if (!pacote) return { ok: false, status: 404, code: "pacote_inexistente", message: "Pacote não encontrado." };
  const provedor = oferta.assinatura!.provedor!;
  const cliente = oferta.assinatura!.provedor_cliente_id!;

  // Clique duplo: a compra pendente do mesmo pacote, ainda nova e com link, volta igual.
  const desde = new Date(agora().getTime() - REUSO_DO_LINK_MS).toISOString();
  const { data: aberta } = await admin
    .from("ia_creditos")
    .select("id, link_pagamento")
    .eq("organization_id", p.orgId)
    .eq("pacote_id", pacote.id)
    .eq("status", "pendente")
    .eq("provedor", provedor)
    .not("link_pagamento", "is", null)
    .gte("created_at", desde)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const reaproveitada = aberta as { id: string; link_pagamento: string } | null;
  if (reaproveitada) return { ok: true, url: reaproveitada.link_pagamento, creditoId: reaproveitada.id };

  const { data: nova, error: erroNova } = await admin
    .from("ia_creditos")
    .insert({
      organization_id: p.orgId,
      pacote_id: pacote.id,
      origem: "compra",
      status: "pendente",
      preco_cents: pacote.preco_cents,
      ia_usd_cents: pacote.ia_usd_cents,
      provedor,
      criado_por: p.actorUserId,
    })
    .select("id")
    .single();
  if (erroNova || !nova) {
    return { ok: false, status: 500, code: "internal_error", message: "Não foi possível registrar a compra." };
  }
  const creditoId = (nova as { id: string }).id;

  let cobranca: { pagamentoRef: string; url: string };
  try {
    cobranca = await (p.adaptadorDe ?? adaptadorPadrao)(provedor).iniciarCompraDeCredito({
      clienteRef: cliente,
      orgId: p.orgId,
      descricao: `Crédito de IA — ${pacote.nome}`,
      valorCents: pacote.preco_cents,
      chaveIdempotencia: creditoId,
      urlDeVolta: urlDoPainelDaEmpresa(),
    });
  } catch (e) {
    await admin.from("ia_creditos").update({ status: "cancelado" }).eq("id", creditoId).eq("organization_id", p.orgId);
    const codigo = e instanceof ErroDoProvedor ? e.codigo : "falha_interna";
    logger.warn("cobranca.credito_ia_link_falhou", { organization_id: p.orgId, codigo });
    const transitorio = e instanceof ErroDoProvedor && e.transitorio;
    return {
      ok: false,
      status: transitorio ? 503 : 502,
      code: "provedor_recusou",
      message: transitorio
        ? "O serviço de pagamento não respondeu. Tente de novo em alguns minutos."
        : "O serviço de pagamento recusou a cobrança. Fale com o suporte.",
    };
  }

  // Sem `pagamento_ref` gravado, a leitura nunca acharia este pagamento e a
  // compra paga nunca viraria crédito: tenta de novo e, falhando, não entrega o
  // link (nada é pago por ele) e cancela a linha.
  const gravarLink = () =>
    admin
      .from("ia_creditos")
      .update({ pagamento_ref: cobranca.pagamentoRef, link_pagamento: cobranca.url })
      .eq("id", creditoId)
      .eq("organization_id", p.orgId);
  let { error: erroLink } = await gravarLink();
  if (erroLink) ({ error: erroLink } = await gravarLink());
  if (erroLink) {
    logger.warn("cobranca.credito_ia_link_nao_gravado", { organization_id: p.orgId, codigo: erroLink.code ?? null });
    await admin.from("ia_creditos").update({ status: "cancelado" }).eq("id", creditoId).eq("organization_id", p.orgId);
    return { ok: false, status: 500, code: "internal_error", message: "Não foi possível registrar a compra. Tente de novo em alguns minutos." };
  }
  auditar("cobranca.credito_ia_compra_iniciada", p.orgId, creditoId, p.actorUserId, {
    pacote_id: pacote.id,
    preco_cents: pacote.preco_cents,
    ia_usd_cents: pacote.ia_usd_cents,
    provedor,
  }, p.requestId);
  return { ok: true, url: cobranca.url, creditoId };
}

/**
 * Relê no provedor cada compra pendente da empresa. Pago → `pago` com a data e
 * o vencimento; encerrado → `cancelado`. Compare-and-set em `status = 'pendente'`:
 * dois sinais ao mesmo tempo dão UM crédito. Nunca lança: a falha de uma compra
 * não para a leitura da assinatura. Devolve quantas viraram `pago`.
 */
export async function conferirCreditosPendentes(
  admin: SupabaseClient,
  orgId: string,
  deps: { adaptadorDe?: (id: ProvedorDeCobranca) => AdaptadorDeCobranca; agora?: () => Date } = {},
): Promise<number> {
  const agora = deps.agora ?? (() => new Date());
  let data: unknown[] | null;
  let error: { code?: string } | null;
  try {
    const r = await admin
      .from("ia_creditos")
      .select(COLUNAS_DO_CREDITO)
      .eq("organization_id", orgId)
      .eq("status", "pendente")
      .not("pagamento_ref", "is", null)
      .limit(20);
    data = r.data;
    error = r.error;
  } catch {
    error = { code: "leitura_lancou" };
    data = null;
  }
  if (error) {
    logger.warn("cobranca.credito_ia_pendentes_ilegiveis", { organization_id: orgId, codigo: error.code ?? null });
    return 0;
  }
  let pagos = 0;
  // `Array.isArray`: um dublê (ou um PostgREST que mudou de forma) não derruba a releitura da assinatura.
  for (const c of (Array.isArray(data) ? data : []) as LinhaDeCredito[]) {
    if (c.provedor === null || c.pagamento_ref === null) continue;
    try {
      const estado = await (deps.adaptadorDe ?? adaptadorPadrao)(c.provedor).lerPagamentoProporcional(c.pagamento_ref);
      if (estado === "pendente") continue;
      const instante = agora();
      const mudanca =
        estado === "pago"
          ? { status: "pago", pago_em: instante.toISOString(), vence_em: vencimentoDoCredito(instante).toISOString() }
          : { status: "cancelado" };
      const { data: gravada, error: erroGravacao } = await admin
        .from("ia_creditos")
        .update(mudanca)
        .eq("id", c.id)
        .eq("organization_id", orgId)
        .eq("status", "pendente")
        .select("id")
        .maybeSingle();
      if (erroGravacao) throw new Error(`gravação falhou (${erroGravacao.code ?? "sem_codigo"})`);
      if (!gravada) continue;
      if (estado === "pago") {
        pagos += 1;
        auditar("cobranca.credito_ia_pago", orgId, c.id, null, {
          preco_cents: c.preco_cents,
          ia_usd_cents: c.ia_usd_cents,
          provedor: c.provedor,
          vence_em: mudanca.vence_em,
        });
      } else {
        auditar("cobranca.credito_ia_cancelado", orgId, c.id, null, { provedor: c.provedor, motivo: "encerrado_no_provedor" });
      }
    } catch (e) {
      logger.warn("cobranca.credito_ia_leitura_falhou", {
        organization_id: orgId,
        codigo: e instanceof ErroDoProvedor ? e.codigo : "falha_interna",
      });
    }
  }
  return pagos;
}

/**
 * Cortesia do dono da instalação: crédito pago na hora, com motivo. Quem chama
 * é a rota de platform admin; a organização vem do corpo DELA (o dono escolhe a
 * empresa), conferida aqui contra `organizations`.
 */
export async function darCortesiaDeCredito(
  admin: SupabaseClient,
  p: { orgId: string; iaUsdCents: number; motivo: string; actorUserId: string; requestId: string; agora?: () => Date },
): Promise<{ ok: true; creditoId: string } | { ok: false; status: number; code: string; message: string }> {
  const { data: org, error: erroOrg } = await admin.from("organizations").select("id").eq("id", p.orgId).maybeSingle();
  if (erroOrg) return { ok: false, status: 500, code: "internal_error", message: "Empresa ilegível." };
  if (!org) return { ok: false, status: 404, code: "not_found", message: "Empresa não encontrada." };
  const instante = (p.agora ?? (() => new Date()))();
  const { data, error } = await admin
    .from("ia_creditos")
    .insert({
      organization_id: p.orgId,
      origem: "cortesia",
      status: "pago",
      ia_usd_cents: p.iaUsdCents,
      motivo: p.motivo,
      pago_em: instante.toISOString(),
      vence_em: vencimentoDoCredito(instante).toISOString(),
      criado_por: p.actorUserId,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, status: 500, code: "internal_error", message: "Não foi possível dar a cortesia." };
  const creditoId = (data as { id: string }).id;
  void audit({
    action: "cobranca.credito_ia_cortesia",
    actorUserId: p.actorUserId,
    actingAsPlatformAdmin: true,
    organizationId: p.orgId,
    bypassedRls: true,
    resourceType: "ia_credito",
    resourceId: creditoId,
    requestId: p.requestId,
    // O motivo é texto livre do dono: vai o tamanho, não o texto.
    metadata: { ia_usd_cents: p.iaUsdCents, motivo_caracteres: p.motivo.length },
  });
  return { ok: true, creditoId };
}
