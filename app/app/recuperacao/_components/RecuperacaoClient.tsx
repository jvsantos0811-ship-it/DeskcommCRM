"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  diasDesde,
  PERIODO_PADRAO,
  PERIODOS_EM_DIAS,
  resumir,
  SEM_MOTIVO,
  type NegocioPerdido,
  type PeriodoEmDias,
} from "@/lib/leads/recuperacao";
import { formatValorDoNegocio } from "@/lib/money";

const TODOS = "__todos__";

function dinheiro(cents: number, moeda: string): string {
  return formatValorDoNegocio(cents, moeda, { semCentavos: true });
}

/**
 * A tela de recuperação: filtros no topo, o resumo (quantos, quanto, por quê)
 * e a lista com a ação de cada negócio.
 *
 * Os filtros de funil e motivo são feitos aqui, sobre a lista do período —
 * clicar num motivo do resumo filtra a lista por ele, que é o gesto de quem
 * decide "vou atacar primeiro os que perdemos por preço".
 */
export function RecuperacaoClient({ podeAgir }: { podeAgir: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [dias, setDias] = useState<PeriodoEmDias>(PERIODO_PADRAO);
  const [funil, setFunil] = useState<string>(TODOS);
  const [motivo, setMotivo] = useState<string>(TODOS);
  const [ocultarRetomados, setOcultarRetomados] = useState(true);

  const lista = useQuery({
    queryKey: ["recuperacao", dias],
    queryFn: () =>
      apiClient
        .get<{ data: { dias: number; negocios: NegocioPerdido[]; truncado: boolean } }>(
          `/api/v1/leads/lost?dias=${dias}`,
        )
        .then((r) => r.data),
  });

  const todos = useMemo(() => lista.data?.negocios ?? [], [lista.data]);
  const funis = useMemo(
    () => [...new Map(todos.map((n) => [n.pipeline_id, n.pipeline_nome ?? t("Funil")])).entries()],
    [todos, t],
  );
  const filtrados = todos.filter(
    (n) =>
      (funil === TODOS || n.pipeline_id === funil) &&
      (motivo === TODOS || (n.lost_reason?.trim() || SEM_MOTIVO) === motivo) &&
      (!ocultarRetomados || !n.retomado),
  );
  const resumo = resumir(
    todos.filter((n) => funil === TODOS || n.pipeline_id === funil),
  );

  const retomar = useMutation({
    mutationFn: (id: string) => apiClient.post(`/api/v1/leads/${id}/retomar`, {}),
    onError: showApiError,
    onSuccess: () => {
      toast.success(t("Negócio retomado: ele voltou para a primeira etapa do funil."));
      qc.invalidateQueries({ queryKey: ["recuperacao"] });
    },
  });

  const recontato = useMutation({
    mutationFn: (n: NegocioPerdido) => {
      const quando = new Date(Date.now() + 3 * 86_400_000);
      quando.setHours(9, 0, 0, 0);
      return apiClient.post("/api/v1/tasks", {
        title: `${t("Retomar contato")}: ${n.title}`,
        description: n.lost_reason ? `${t("Perdido por")}: ${n.lost_reason}` : null,
        due_date: quando.toISOString(),
        priority: "medium",
        lead_id: n.id,
        contact_id: n.contact_id,
      });
    },
    onError: showApiError,
    onSuccess: () => toast.success(t("Tarefa de recontato criada para daqui a 3 dias, às 9h.")),
  });

  return (
    <div className="flex flex-col gap-6 p-6" data-recuperacao>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Recuperação de negócios perdidos")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "O que ficou na mesa, e por quê. Retome um negócio (ele volta ao funil como negócio novo, sem apagar o histórico) ou agende o recontato.",
          )}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1.5 text-text-muted">
          {t("Período")}
          <select
            value={dias}
            onChange={(e) => setDias(Number(e.target.value) as PeriodoEmDias)}
            className="h-9 rounded-md border border-border bg-background px-2 text-text"
          >
            {PERIODOS_EM_DIAS.map((d) => (
              <option key={d} value={d}>
                {t("Últimos {n} dias").replace("{n}", String(d))}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-text-muted">
          {t("Funil")}
          <select
            value={funil}
            onChange={(e) => setFunil(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-2 text-text"
          >
            <option value={TODOS}>{t("Todos")}</option>
            {funis.map(([id, nome]) => (
              <option key={id} value={id}>
                {nome}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-text-muted">
          <input
            type="checkbox"
            checked={ocultarRetomados}
            onChange={(e) => setOcultarRetomados(e.target.checked)}
          />
          {t("Esconder os já retomados")}
        </label>
        {motivo !== TODOS && (
          <button
            type="button"
            onClick={() => setMotivo(TODOS)}
            className="h-9 rounded-md border border-primary/40 bg-primary/5 px-3 text-text"
          >
            {t("Motivo")}: {motivo === SEM_MOTIVO ? t("Sem motivo informado") : motivo} ✕
          </button>
        )}
      </div>

      {/* ── resumo ── */}
      <section className="grid gap-3 md:grid-cols-3" aria-label={t("Resumo")}>
        <div className="rounded-lg border border-border p-4">
          <p className="text-xs text-text-muted">{t("Negócios perdidos")}</p>
          <p className="text-2xl font-semibold tabular-nums text-text">{resumo.quantidade}</p>
          <p className="text-xs text-text-muted">
            {resumo.ainda_nao_retomados} {t("ainda não retomados")}
          </p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="text-xs text-text-muted">{t("Valor que ficou na mesa")}</p>
          {Object.keys(resumo.valor_por_moeda).length === 0 ? (
            <p className="text-2xl font-semibold text-text">—</p>
          ) : (
            Object.entries(resumo.valor_por_moeda).map(([moeda, v]) => (
              <p key={moeda} className="text-2xl font-semibold tabular-nums text-text">
                {dinheiro(v, moeda)}
              </p>
            ))
          )}
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="mb-2 text-xs text-text-muted">{t("Principais motivos (clique para filtrar)")}</p>
          <ul className="flex flex-col gap-1.5">
            {resumo.motivos.slice(0, 5).map((m) => {
              const largura = resumo.quantidade ? Math.max(4, (m.quantidade / resumo.quantidade) * 100) : 0;
              return (
                <li key={m.motivo}>
                  <button
                    type="button"
                    onClick={() => setMotivo(m.motivo)}
                    className="flex w-full flex-col gap-0.5 text-left text-xs"
                  >
                    <span className="flex justify-between gap-2 text-text">
                      <span className="truncate">{m.motivo === SEM_MOTIVO ? t("Sem motivo informado") : m.motivo}</span>
                      <span className="tabular-nums text-text-muted">{m.quantidade}</span>
                    </span>
                    <span className="h-1.5 w-full rounded-full bg-muted">
                      <span className="block h-1.5 rounded-full bg-primary" style={{ width: `${largura}%` }} />
                    </span>
                  </button>
                </li>
              );
            })}
            {resumo.motivos.length === 0 && <li className="text-xs text-text-muted">—</li>}
          </ul>
        </div>
      </section>

      {/* ── lista ── */}
      <section aria-label={t("Negócios perdidos")}>
        {lista.isLoading && <p className="text-sm text-text-muted">{t("Carregando…")}</p>}
        {lista.isError && (
          <p className="text-sm text-destructive">{t("Não foi possível carregar os negócios perdidos.")}</p>
        )}
        {!lista.isLoading && filtrados.length === 0 && !lista.isError && (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">
            {t("Nenhum negócio perdido neste filtro. Bom sinal.")}
          </p>
        )}
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {filtrados.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-negocio-perdido={n.id}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">{n.title}</p>
                <p className="truncate text-xs text-text-muted">
                  {[n.contato_nome, n.pipeline_nome].filter(Boolean).join(" · ")}
                </p>
              </div>
              <div className="w-40 text-xs">
                <p className="truncate text-text">{n.lost_reason?.trim() || t("Sem motivo informado")}</p>
                <p className="text-text-muted">
                  {t("Perdido há {n} dias").replace("{n}", String(diasDesde(n.closed_at)))}
                </p>
              </div>
              <p className="w-28 text-right text-sm tabular-nums text-text">
                {n.value_cents != null ? dinheiro(n.value_cents, n.currency ?? "BRL") : "—"}
              </p>
              <div className="flex shrink-0 flex-wrap gap-1.5">
                {n.conversa_id && (
                  <Link
                    href={`/app/inbox?id=${n.conversa_id}`}
                    className="inline-flex h-8 items-center rounded-md border border-border px-2.5 text-xs font-medium text-text hover:bg-muted"
                  >
                    {t("Ver conversa")}
                  </Link>
                )}
                {podeAgir && (
                  <>
                    <button
                      type="button"
                      onClick={() => recontato.mutate(n)}
                      disabled={recontato.isPending}
                      className="h-8 rounded-md border border-border px-2.5 text-xs font-medium text-text hover:bg-muted disabled:opacity-60"
                    >
                      {t("Agendar recontato")}
                    </button>
                    {n.retomado ? (
                      <span className="inline-flex h-8 items-center rounded-md px-2.5 text-xs text-text-muted">
                        {t("Já retomado")}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => retomar.mutate(n.id)}
                        disabled={retomar.isPending}
                        className="h-8 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                      >
                        {t("Retomar")}
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        {lista.data?.truncado && (
          <p className="mt-2 text-xs text-text-muted">
            {t("Mostrando os 500 mais recentes do período. Escolha um período menor para ver o resto.")}
          </p>
        )}
      </section>
    </div>
  );
}
