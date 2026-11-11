"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { SeletorDePeriodo } from "@/app/app/dados/_components/SeletorDePeriodo";
import type { AgenteDaOrg } from "@/lib/agencia/ler";
import type {
  Alerta,
  ConfigDaAgencia,
  LinhaDoCliente,
  PagamentoLancado,
  Situacao,
  Tendencia,
  TotaisDoTopo,
} from "@/lib/agencia/painel";
import { apiClient } from "@/lib/api/client";
import {
  parametrosDoPeriodo,
  periodoDosParametros,
  rotuloDoPeriodo,
  type PeriodoPedido,
  type PeriodoResolvido,
} from "@/lib/dados/periodo";
import { cn } from "@/lib/utils";

type Cliente = LinhaDoCliente & {
  agentes: AgenteDaOrg[];
  pagamentos: Array<PagamentoLancado & { lancado_por_nome: string | null }>;
};

interface Painel {
  periodo: PeriodoResolvido;
  anterior: { de: string; ate: string };
  config: ConfigDaAgencia;
  totais: TotaisDoTopo;
  clientes: Cliente[];
  organizacoes: Array<{ id: string; nome: string }>;
}

/** As formas de pagamento do lançamento manual (o CHECK de `agencia_pagamentos`). */
const FORMAS_DE_PAGAMENTO = [
  "pix",
  "boleto",
  "cartao",
  "transferencia",
  "dinheiro",
  "outro",
] as const;

const brl = (cents: number | null | undefined) =>
  cents === null || cents === undefined
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
const usd = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const data = (d: string | null | undefined) =>
  d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—";

function Seta({
  t: tendencia,
  melhorQuandoCai = false,
}: {
  t: Tendencia;
  melhorQuandoCai?: boolean;
}) {
  if (!tendencia || tendencia === "igual") return <span className="text-text-muted">·</span>;
  const bom = tendencia === "subiu" ? !melhorQuandoCai : melhorQuandoCai;
  return (
    <span className={bom ? "text-success-fg" : "text-destructive"} aria-label={tendencia}>
      {tendencia === "subiu" ? "▲" : "▼"}
    </span>
  );
}

/**
 * O PAINEL DA AGÊNCIA (PC-028). Só números agregados. A planilha sai pela
 * mesma leitura da tela (`/api/v1/admin/agencia/export`), com auditoria.
 */
export function AgenciaClient() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const periodo = periodoDosParametros(params);
  const org = params.get("org") ?? "";
  const [aberto, setAberto] = useState<string | null>(null);
  const qc = useQueryClient();

  const qs = new URLSearchParams({
    ...parametrosDoPeriodo(periodo),
    ...(org ? { org } : {}),
  }).toString();
  const q = useQuery({
    queryKey: ["admin", "agencia", qs],
    queryFn: () =>
      apiClient
        .get<{ data: Painel }>(`/api/v1/admin/agencia${qs ? `?${qs}` : ""}`)
        .then((r) => r.data),
  });
  const d = q.data;

  const irPara = (novo: { periodo?: PeriodoPedido | null; org?: string }) => {
    const p = new URLSearchParams(params.toString());
    if (novo.periodo !== undefined) {
      for (const k of ["periodo", "de", "ate"]) p.delete(k);
      for (const [k, v] of Object.entries(parametrosDoPeriodo(novo.periodo))) p.set(k, v);
    }
    if (novo.org !== undefined) {
      if (novo.org) p.set("org", novo.org);
      else p.delete("org");
    }
    const s = p.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  const rotuloDaSituacao: Record<Situacao, string> = {
    teste: t("Teste"),
    pagante: t("Pagante"),
    em_atraso: t("Em atraso"),
    suspensa: t("Suspensa"),
    cancelada: t("Cancelada"),
    sem_cadastro: t("Sem cadastro"),
  };
  const rotuloDoAlerta: Record<Alerta, string> = {
    pagamento_em_atraso: t("Pagamento em atraso"),
    teste_vencendo: t("Teste vence em até 3 dias"),
    custo_acima_da_mensalidade: t("Custo acima do limite da mensalidade"),
    teto_de_ia_perto: t("Teto de gasto de IA perto do limite"),
    whatsapp_desconectado: t("WhatsApp desconectado ou com falha"),
    agente_pausado: t("Agente pausado"),
    sem_conversa_nova: t("Sem conversa nova há 48 h"),
  };
  const exportar = (formato: "xlsx" | "csv") => {
    const s = new URLSearchParams({ ...parametrosDoPeriodo(periodo), formato }).toString();
    window.location.href = `/api/v1/admin/agencia/export?${s}`;
  };
  const recarregar = () => void qc.invalidateQueries({ queryKey: ["admin", "agencia"] });

  return (
    <div className="space-y-6" data-testid="painel-da-agencia">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Agência")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "Quem paga, quanto custa e se o cliente está tendo resultado. Só números agregados.",
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={org}
            onChange={(e) => irPara({ org: e.target.value })}
            aria-label={t("Organização")}
            data-testid="agencia-org"
          >
            <option value="">{t("Todas as organizações")}</option>
            {(d?.organizacoes ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.nome}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            onClick={() => exportar("xlsx")}
            data-testid="agencia-exportar-xlsx"
          >
            {t("Exportar .xlsx")}
          </Button>
          <Button
            variant="outline"
            onClick={() => exportar("csv")}
            data-testid="agencia-exportar-csv"
          >
            {t("Exportar .csv")}
          </Button>
        </div>
      </div>

      <SeletorDePeriodo
        key={JSON.stringify(periodo)}
        valor={periodo}
        onMudar={(p) => irPara({ periodo: p })}
      />
      {d && (
        <p className="text-sm text-text-muted" data-testid="agencia-periodo">
          {t("Período: {periodo}. Comparado com {anterior}.")
            .replace("{periodo}", rotuloDoPeriodo(d.periodo, t))
            .replace("{anterior}", rotuloDoPeriodo({ atalho: "personalizado", ...d.anterior }, t))}
        </p>
      )}

      {q.isLoading && <p className="text-sm text-text-muted">{t("Carregando…")}</p>}
      {q.isError && (
        <p className="text-sm text-destructive">{t("Não foi possível montar o painel agora.")}</p>
      )}

      {d && (
        <>
          <section
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
            data-testid="agencia-totais"
          >
            {(
              [
                [
                  t("Receita recorrente mensal"),
                  brl(d.totais.receita_recorrente_cents),
                  "agencia-mrr",
                ],
                [
                  t("Recebido no período"),
                  brl(d.totais.recebido_no_periodo_cents),
                  "agencia-recebido",
                ],
                [t("Em atraso"), brl(d.totais.em_atraso_cents), "agencia-em-atraso"],
                [t("Ticket médio"), brl(d.totais.ticket_medio_cents), "agencia-ticket"],
                [
                  t("Cancelaram no período"),
                  String(d.totais.cancelaram_no_periodo),
                  "agencia-cancelaram",
                ],
                [
                  t("Clientes"),
                  (["pagante", "em_atraso", "teste", "suspensa", "cancelada"] as const)
                    .map((s) => `${rotuloDaSituacao[s]} ${d.totais.clientes_por_situacao[s]}`)
                    .join(" · "),
                  "agencia-por-situacao",
                ],
              ] as const
            ).map(([rotulo, valor, id]) => (
              <div key={id} className="rounded-lg border border-border bg-card p-4">
                <p className="text-xs font-medium tracking-wide text-text-muted uppercase">
                  {rotulo}
                </p>
                <p className="mt-1 text-lg font-semibold tabular-nums" data-testid={id}>
                  {valor}
                </p>
              </div>
            ))}
          </section>

          <Configuracao config={d.config} onSalvo={recarregar} />

          <section className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm" data-testid="agencia-tabela">
              <thead className="bg-muted/40 text-xs text-text-muted">
                <tr>
                  {[
                    t("Organização"),
                    t("Situação"),
                    t("Mensalidade"),
                    t("Próx. vencimento"),
                    t("Atraso (dias)"),
                    t("Recebido"),
                    t("Custo IA + WhatsApp"),
                    t("Custo por conversa"),
                    t("Margem"),
                    t("Leads"),
                    t("Contratos"),
                    t("Contratos por lead"),
                    t("Alertas"),
                  ].map((c) => (
                    <th key={c} className="px-3 py-2 text-left font-semibold whitespace-nowrap">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.clientes.map((c) => (
                  <Fragment key={c.organization_id}>
                    <tr
                      className="cursor-pointer border-t border-border hover:bg-muted/30"
                      onClick={() =>
                        setAberto(aberto === c.organization_id ? null : c.organization_id)
                      }
                      data-testid="agencia-linha"
                      data-org={c.organization_id}
                    >
                      <td className="px-3 py-2 font-semibold">{c.nome}</td>
                      <td className="px-3 py-2" data-testid="agencia-situacao">
                        {rotuloDaSituacao[c.situacao]}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{brl(c.mensalidade_cents)}</td>
                      <td className="px-3 py-2 tabular-nums">{data(c.proximo_vencimento)}</td>
                      <td className="px-3 py-2 tabular-nums" data-testid="agencia-dias-em-atraso">
                        {c.dias_em_atraso}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{brl(c.recebido_no_periodo_cents)}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {brl(c.custo_total_brl_cents)}{" "}
                        <span
                          className="rounded-sm bg-warning-bg px-1 text-[10px] text-warning-fg"
                          title={t("O custo do WhatsApp é estimado pela tabela de preço.")}
                        >
                          {t("estimado")}
                        </span>
                      </td>
                      <td
                        className="px-3 py-2 tabular-nums"
                        data-testid="agencia-custo-por-conversa"
                      >
                        {brl(c.custo_por_conversa_cents)}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 tabular-nums",
                          c.margem_cents < 0 && "text-destructive",
                        )}
                      >
                        {brl(c.margem_cents)}
                        {c.margem_pct !== null && (
                          <span className="text-text-muted"> · {c.margem_pct}%</span>
                        )}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {c.resultado.leads} <Seta t={c.tendencias.leads} />
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {c.resultado.contratos} <Seta t={c.tendencias.contratos} />
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {c.resultado.contratos_por_lead_pct === null
                          ? "—"
                          : `${c.resultado.contratos_por_lead_pct}%`}{" "}
                        <Seta t={c.tendencias.contratos_por_lead_pct} />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1" data-testid="agencia-alertas">
                          {c.alertas.map((a) => (
                            <span
                              key={a}
                              data-alerta={a}
                              className="rounded-full bg-warning-bg px-2 py-0.5 text-[11px] text-warning-fg"
                            >
                              {rotuloDoAlerta[a]}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                    {aberto === c.organization_id && (
                      <tr className="border-t border-border bg-muted/10">
                        <td colSpan={13} className="px-3 py-4">
                          <DetalheDoCliente cliente={c} onSalvo={recarregar} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </section>
          <p className="text-xs text-text-muted">
            {t(
              "De onde vem cada número: situação, plano e vencimento da cobrança do produto quando a organização tem assinatura; senão do cadastro manual. Pagamentos e total pago, só do lançamento manual. Custo de IA: o mesmo do Usage, em dólar, convertido pela cotação. WhatsApp: estimado (mensagens de modelo × tabela de preço; resposta na janela de 24 h e modelo na janela grátis do anúncio contam R$ 0).",
            )}
          </p>
        </>
      )}
    </div>
  );
}

function Configuracao({ config, onSalvo }: { config: ConfigDaAgencia; onSalvo: () => void }) {
  const t = useT();
  const [aberta, setAberta] = useState(false);
  const [cotacao, setCotacao] = useState(String(config.cotacao_usd_brl));
  const [precos, setPrecos] = useState({
    marketing: (config.precos_whatsapp.marketing / 100).toFixed(2),
    utilidade: (config.precos_whatsapp.utilidade / 100).toFixed(2),
    autenticacao: (config.precos_whatsapp.autenticacao / 100).toFixed(2),
  });
  const [alerta, setAlerta] = useState(String(config.alerta_custo_pct));
  const salvar = useMutation({
    mutationFn: () =>
      apiClient.put("/api/v1/admin/agencia/config", {
        cotacao_usd_brl: Number(cotacao.replace(",", ".")),
        precos_whatsapp: {
          marketing: Math.round(Number(precos.marketing.replace(",", ".")) * 100),
          utilidade: Math.round(Number(precos.utilidade.replace(",", ".")) * 100),
          autenticacao: Math.round(Number(precos.autenticacao.replace(",", ".")) * 100),
        },
        alerta_custo_pct: Number(alerta.replace(",", ".")),
      }),
    onSuccess: () => {
      toast.success(t("Configuração salva."));
      onSalvo();
    },
    onError: (e) => showApiError(e),
  });
  return (
    <section className="rounded-lg border border-border p-4">
      <button
        type="button"
        className="text-sm font-semibold"
        onClick={() => setAberta(!aberta)}
        data-testid="agencia-config-abrir"
      >
        {aberta ? "▾" : "▸"} {t("Cotação, preços do WhatsApp e alerta de custo")}
      </button>
      {aberta && (
        <div className="mt-3 grid gap-3 sm:grid-cols-5">
          <div className="grid gap-1">
            <Label className="text-xs">{t("Cotação do dólar (R$)")}</Label>
            <Input
              value={cotacao}
              onChange={(e) => setCotacao(e.target.value)}
              data-testid="agencia-cotacao"
            />
          </div>
          {(["marketing", "utilidade", "autenticacao"] as const).map((k) => (
            <div key={k} className="grid gap-1">
              <Label className="text-xs">
                {k === "marketing"
                  ? t("Modelo de marketing (R$/mensagem)")
                  : k === "utilidade"
                    ? t("Modelo de utilidade (R$/mensagem)")
                    : t("Modelo de autenticação (R$/mensagem)")}
              </Label>
              <Input
                value={precos[k]}
                onChange={(e) => setPrecos({ ...precos, [k]: e.target.value })}
              />
            </div>
          ))}
          <div className="grid gap-1">
            <Label className="text-xs">{t("Alerta: custo acima de (% da mensalidade)")}</Label>
            <Input
              value={alerta}
              onChange={(e) => setAlerta(e.target.value)}
              data-testid="agencia-alerta-pct"
            />
          </div>
          <div className="sm:col-span-5">
            <Button
              size="sm"
              onClick={() => salvar.mutate()}
              disabled={salvar.isPending}
              data-testid="agencia-config-salvar"
            >
              {t("Salvar")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function DetalheDoCliente({ cliente: c, onSalvo }: { cliente: Cliente; onSalvo: () => void }) {
  const t = useT();
  const hoje = new Date().toISOString().slice(0, 10);
  const [cad, setCad] = useState({
    plano: c.plano ?? "",
    implantacao: (c.implantacao_cents / 100).toFixed(2),
    implantacao_paga: c.implantacao_paga,
    mensalidade: (c.mensalidade_cents / 100).toFixed(2),
    inicio: c.inicio ?? "",
    proximo_vencimento: c.proximo_vencimento ?? "",
    teste_ate: c.teste_ate ?? "",
    cancelada_em: "",
  });
  const [pag, setPag] = useState({
    tipo: "mensalidade",
    pago_em: hoje,
    valor: "",
    forma: "pix",
    observacao: "",
  });
  const centavos = (v: string) =>
    Math.round(Number(v.replace(/\./g, "").replace(",", ".")) * 100) || 0;
  const salvarCadastro = useMutation({
    mutationFn: () =>
      apiClient.put("/api/v1/admin/agencia/clientes", {
        organization_id: c.organization_id,
        plano: cad.plano.trim() || null,
        implantacao_cents: centavos(cad.implantacao),
        implantacao_paga: cad.implantacao_paga,
        mensalidade_cents: centavos(cad.mensalidade),
        inicio: cad.inicio || null,
        proximo_vencimento: cad.proximo_vencimento || null,
        teste_ate: cad.teste_ate || null,
        cancelada_em: cad.cancelada_em || null,
      }),
    onSuccess: () => {
      toast.success(t("Cadastro salvo."));
      onSalvo();
    },
    onError: (e) => showApiError(e),
  });
  const lancar = useMutation({
    mutationFn: () =>
      apiClient.post("/api/v1/admin/agencia/pagamentos", {
        organization_id: c.organization_id,
        tipo: pag.tipo,
        pago_em: pag.pago_em,
        valor_cents: centavos(pag.valor),
        forma: pag.forma,
        observacao: pag.observacao.trim() || null,
      }),
    onSuccess: () => {
      toast.success(t("Pagamento lançado."));
      setPag({ ...pag, valor: "", observacao: "" });
      onSalvo();
    },
    onError: (e) => showApiError(e),
  });
  const campo = "h-8 rounded-md border border-input bg-background px-2 text-xs";
  const rotuloDaForma: Record<string, string> = {
    pix: "Pix",
    boleto: t("Boleto"),
    cartao: t("Cartão"),
    transferencia: t("Transferência"),
    dinheiro: t("Dinheiro"),
    outro: t("Outro"),
  };

  return (
    <div className="grid gap-5 lg:grid-cols-3" data-testid="agencia-detalhe">
      <div className="space-y-2 text-xs">
        <h3 className="text-sm font-semibold">{t("Cobrança")}</h3>
        <p>
          {t("Fonte")}:{" "}
          {c.fonte_da_cobranca === "produto"
            ? t("cobrança do produto")
            : c.fonte_da_cobranca === "manual"
              ? t("lançamento manual")
              : "—"}
        </p>
        <p>
          {t("Plano")}: {c.plano ?? "—"} · {t("Implantação")}: {brl(c.implantacao_cents)} (
          {c.implantacao_paga ? t("paga") : t("não paga")})
        </p>
        <p>
          {t("Início")}: {data(c.inicio)} · {t("Teste vence em")}: {data(c.teste_ate)}
        </p>
        <p data-testid="agencia-total-pago">
          {t("Total pago")}: {brl(c.total_pago_cents)} · {t("Último pagamento")}:{" "}
          {c.ultimo_pagamento
            ? `${brl(c.ultimo_pagamento.valor_cents)} ${t("em")} ${data(c.ultimo_pagamento.pago_em)}`
            : "—"}
        </p>
        <h3 className="pt-2 text-sm font-semibold">{t("Custo no período")}</h3>
        <p>
          {t("IA")}: {usd(c.ia_usd_cents)} ({brl(c.ia_brl_cents)}) · {t("WhatsApp")}:{" "}
          {brl(c.whatsapp_brl_cents)} ({t("estimado")})
        </p>
        <p>
          {t("Conversas atendidas pela IA")}: {c.conversas_ia} · {t("Mensagens da IA")}:{" "}
          {c.mensagens_ia}
        </p>
        <p>
          {t("Por conversa")}: {brl(c.custo_por_conversa_cents)} · {t("Por lead")}:{" "}
          {brl(c.custo_por_lead_cents)} · {t("Por contrato")}: {brl(c.custo_por_contrato_cents)}
        </p>
        <h3 className="pt-2 text-sm font-semibold">{t("Resultado do cliente")}</h3>
        <p>
          {t("Leads")}: {c.resultado.leads} <Seta t={c.tendencias.leads} /> · {t("Qualificados")}:{" "}
          {c.resultado.qualificados} <Seta t={c.tendencias.qualificados} /> ·{" "}
          {t("Passados para a equipe")}: {c.resultado.passados_para_equipe}{" "}
          <Seta t={c.tendencias.passados_para_equipe} />
        </p>
        <p>
          {t("Contratos")}: {c.resultado.contratos} <Seta t={c.tendencias.contratos} /> ·{" "}
          {t("1ª resposta (mediana)")}:{" "}
          {c.resultado.mediana_primeira_resposta_seg === null
            ? "—"
            : `${Math.round(c.resultado.mediana_primeira_resposta_seg / 60)} min`}{" "}
          <Seta t={c.tendencias.mediana_primeira_resposta_seg} melhorQuandoCai />
        </p>
        {c.agentes.length > 0 && (
          <>
            <h3 className="pt-2 text-sm font-semibold">{t("Por agente")}</h3>
            <ul data-testid="agencia-por-agente">
              {c.agentes.map((a) => (
                <li key={a.agent_id ?? "fora"}>
                  {a.nome}: {usd(a.custo_usd_cents)} ({brl(a.custo_brl_cents)}) · {a.contatos}{" "}
                  {t("contatos")}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <form
        className="grid content-start gap-2 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          salvarCadastro.mutate();
        }}
      >
        <h3 className="text-sm font-semibold">{t("Cadastro manual")}</h3>
        <Label className="text-xs">{t("Plano")}</Label>
        <input
          className={campo}
          value={cad.plano}
          onChange={(e) => setCad({ ...cad, plano: e.target.value })}
          placeholder={t("Entrada, Crescimento, Operação completa")}
        />
        <Label className="text-xs">{t("Implantação (R$)")}</Label>
        <input
          className={campo}
          value={cad.implantacao}
          onChange={(e) => setCad({ ...cad, implantacao: e.target.value })}
        />
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={cad.implantacao_paga}
            onChange={(e) => setCad({ ...cad, implantacao_paga: e.target.checked })}
          />
          {t("Implantação paga")}
        </label>
        <Label className="text-xs">{t("Mensalidade (R$)")}</Label>
        <input
          className={campo}
          value={cad.mensalidade}
          onChange={(e) => setCad({ ...cad, mensalidade: e.target.value })}
          data-testid="agencia-cad-mensalidade"
        />
        <Label className="text-xs">{t("Início")}</Label>
        <input
          type="date"
          className={campo}
          value={cad.inicio}
          onChange={(e) => setCad({ ...cad, inicio: e.target.value })}
        />
        <Label className="text-xs">{t("Próximo vencimento")}</Label>
        <input
          type="date"
          className={campo}
          value={cad.proximo_vencimento}
          onChange={(e) => setCad({ ...cad, proximo_vencimento: e.target.value })}
          data-testid="agencia-cad-vencimento"
        />
        <Label className="text-xs">{t("Teste vence em")}</Label>
        <input
          type="date"
          className={campo}
          value={cad.teste_ate}
          onChange={(e) => setCad({ ...cad, teste_ate: e.target.value })}
        />
        <Label className="text-xs">{t("Cancelada em (se cancelou)")}</Label>
        <input
          type="date"
          className={campo}
          value={cad.cancelada_em}
          onChange={(e) => setCad({ ...cad, cancelada_em: e.target.value })}
        />
        <Button
          size="sm"
          type="submit"
          disabled={salvarCadastro.isPending}
          data-testid="agencia-cad-salvar"
        >
          {t("Salvar cadastro")}
        </Button>
        <p className="text-[11px] text-text-muted">
          {t("Este cadastro não muda plano nem suspende ninguém: é o registro da agência.")}
        </p>
      </form>

      <div className="grid content-start gap-2 text-xs">
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            lancar.mutate();
          }}
        >
          <h3 className="text-sm font-semibold">{t("Lançar pagamento")}</h3>
          <select
            className={campo}
            value={pag.tipo}
            onChange={(e) => setPag({ ...pag, tipo: e.target.value })}
          >
            <option value="mensalidade">{t("Mensalidade")}</option>
            <option value="implantacao">{t("Implantação")}</option>
            <option value="outro">{t("Outro")}</option>
          </select>
          <input
            type="date"
            className={campo}
            value={pag.pago_em}
            onChange={(e) => setPag({ ...pag, pago_em: e.target.value })}
            data-testid="agencia-pag-data"
          />
          <input
            className={campo}
            value={pag.valor}
            onChange={(e) => setPag({ ...pag, valor: e.target.value })}
            placeholder={t("Valor (R$)")}
            data-testid="agencia-pag-valor"
          />
          <select
            className={campo}
            value={pag.forma}
            onChange={(e) => setPag({ ...pag, forma: e.target.value })}
          >
            {FORMAS_DE_PAGAMENTO.map((f) => (
              <option key={f} value={f}>
                {rotuloDaForma[f]}
              </option>
            ))}
          </select>
          <input
            className={campo}
            value={pag.observacao}
            onChange={(e) => setPag({ ...pag, observacao: e.target.value })}
            placeholder={t("Observação do pagamento (opcional)")}
          />
          <Button
            size="sm"
            type="submit"
            disabled={!pag.valor || lancar.isPending}
            data-testid="agencia-pag-lancar"
          >
            {t("Lançar")}
          </Button>
        </form>
        <h3 className="pt-2 text-sm font-semibold">{t("Histórico de pagamentos")}</h3>
        {c.pagamentos.length === 0 ? (
          <p className="text-text-muted">{t("Nenhum pagamento lançado.")}</p>
        ) : (
          <ul className="space-y-1" data-testid="agencia-historico">
            {c.pagamentos.map((p) => (
              <li key={p.id}>
                {data(p.pago_em)} · {brl(p.valor_cents)} · {rotuloDaForma[p.forma] ?? p.forma}
                {p.observacao ? ` · ${p.observacao}` : ""}{" "}
                <span className="text-text-muted">
                  ({t("lançado por")} {p.lancado_por_nome ?? "—"} {t("em")}{" "}
                  {data(p.lancado_em.slice(0, 10))})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
