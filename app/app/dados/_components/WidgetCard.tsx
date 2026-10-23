"use client";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { SOBRE_A_METRICA, type Resultado, type Widget } from "@/lib/dados/widgets";
import { formatValorDoNegocio, MOEDA_PADRAO } from "@/lib/money";
import { cn } from "@/lib/utils";

import { useResultado } from "./useDados";

/** Paleta pelos tokens do tema: o gráfico acompanha claro, escuro e a cor da marca. */
const CORES = [
  "var(--primary)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--destructive)",
  "var(--muted-foreground)",
];

export function formatar(valor: number, tipo: Resultado["tipo"], tag: string): string {
  if (tipo === "dinheiro") return formatValorDoNegocio(valor, MOEDA_PADRAO, { semCentavos: true });
  if (tipo === "percentual") return `${valor.toLocaleString(tag, { maximumFractionDigits: 1 })}%`;
  return valor.toLocaleString(tag);
}

/** "2026-10-10" vira "10/10"; "2026-10" vira "out/26"; o resto passa como está. */
function rotuloCurto(rotulo: string, tag: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(rotulo)) {
    const [, m, d] = rotulo.split("-");
    return `${d}/${m}`;
  }
  if (/^\d{4}-\d{2}$/.test(rotulo)) {
    return new Date(`${rotulo}-15T12:00:00Z`).toLocaleDateString(tag, { month: "short", year: "2-digit" });
  }
  return rotulo;
}

export function WidgetCard({
  widget,
  acoes,
}: {
  widget: Widget;
  acoes?: React.ReactNode;
}) {
  const t = useT();
  const tag = useTagDeIdioma();
  const r = useResultado(widget);
  const tipo = SOBRE_A_METRICA[widget.metrica].tipo;
  const meta = widget.meta ?? null;
  const fmt = (v: number) => formatar(v, tipo, tag);
  const serie = (r.data?.serie ?? []).map((p) => ({ ...p, rotulo: rotuloCurto(p.rotulo, tag) }));
  const tooltipEstilo = {
    border: "1px solid var(--border)",
    background: "var(--popover)",
    color: "var(--popover-foreground)",
    borderRadius: 6,
    fontSize: 12,
  };

  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-card p-4",
        widget.visual !== "numero" && "md:col-span-2",
      )}
      data-widget={widget.metrica}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-text">{widget.titulo}</h3>
          <p className="text-xs text-text-muted">
            {t("Últimos {n} dias").replace("{n}", String(widget.periodo_dias))}
          </p>
        </div>
        {acoes}
      </header>

      {r.isLoading && <div className="h-24 animate-pulse rounded-md bg-muted" />}
      {r.isError && <p className="text-sm text-destructive">{t("Não foi possível calcular este gráfico.")}</p>}

      {r.data && widget.visual === "numero" && (
        <div className="flex flex-col gap-2">
          <p className="text-3xl font-semibold tabular-nums text-text">{fmt(r.data.total)}</p>
          {meta != null && meta > 0 && (
            <div className="flex flex-col gap-1">
              <div className="h-2 w-full rounded-full bg-muted" role="progressbar" aria-valuenow={r.data.total} aria-valuemax={meta}>
                <div
                  className={cn("h-2 rounded-full", r.data.total >= meta ? "bg-success" : "bg-primary")}
                  style={{ width: `${Math.min(100, (r.data.total / meta) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-text-muted">
                {t("Meta")}: {fmt(meta)} · {Math.round((r.data.total / meta) * 100)}%
              </p>
            </div>
          )}
        </div>
      )}

      {r.data && widget.visual !== "numero" && serie.length === 0 && (
        <p className="py-8 text-center text-sm text-text-muted">{t("Nada no período.")}</p>
      )}

      {r.data && widget.visual === "linha" && serie.length > 0 && (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={serie} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="rotulo" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} />
              <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickFormatter={fmt} width={70} />
              <Tooltip formatter={(v) => fmt(Number(v))} contentStyle={tooltipEstilo} />
              {meta != null && <ReferenceLine y={meta} stroke="var(--color-success)" strokeDasharray="4 4" />}
              <Line type="monotone" dataKey="valor" stroke="var(--primary)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {r.data && widget.visual === "barras" && serie.length > 0 && (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={serie.slice(0, 20)} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="rotulo" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} interval={0} />
              <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickFormatter={fmt} width={70} />
              <Tooltip formatter={(v) => fmt(Number(v))} contentStyle={tooltipEstilo} />
              {meta != null && <ReferenceLine y={meta} stroke="var(--color-success)" strokeDasharray="4 4" />}
              <Bar dataKey="valor" fill="var(--primary)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {r.data && widget.visual === "pizza" && serie.length > 0 && (
        <div className="flex flex-col items-center gap-3 md:flex-row">
          <div className="h-48 w-full md:w-1/2">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={serie.slice(0, 5)} dataKey="valor" nameKey="rotulo" innerRadius="55%" outerRadius="90%">
                  {serie.slice(0, 5).map((p, i) => (
                    <Cell key={p.rotulo} fill={CORES[i % CORES.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => fmt(Number(v))} contentStyle={tooltipEstilo} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="flex w-full flex-col gap-1 text-xs md:w-1/2">
            {serie.slice(0, 5).map((p, i) => (
              <li key={p.rotulo} className="flex items-center gap-2">
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: CORES[i % CORES.length] }} />
                <span className="min-w-0 flex-1 truncate text-text">{p.rotulo}</span>
                <span className="tabular-nums text-text-muted">{fmt(p.valor)}</span>
              </li>
            ))}
            {serie.length > 5 && (
              <li className="text-text-muted">
                {t("e mais {n}").replace("{n}", String(serie.length - 5))}
              </li>
            )}
          </ul>
        </div>
      )}

      {r.data?.truncado && (
        <p className="text-[11px] text-text-muted">{t("Período grande demais: o gráfico considerou os 10 mil registros mais recentes.")}</p>
      )}
    </article>
  );
}
