"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  parametrosDoPeriodo,
  type PeriodoPedido,
  type PeriodoResolvido,
} from "@/lib/dados/periodo";
import { SEM_MOTIVO, type QuemMarcou } from "@/lib/dados/perdas";
import { linkDoFunil } from "@/lib/dados/retrato";
import { rotuloDoMotivoDePerda } from "@/lib/schemas/leads";
import { cn } from "@/lib/utils";

import { rotuloDaOrigem, Secao, type T } from "./pecas";

interface RespostaDasPerdas {
  periodo: PeriodoResolvido | null;
  truncado: boolean;
  total: number;
  motivos: Array<{ motivo: string; leads: number; pct: number; ids: string[] }>;
  cards: Array<{
    id: string;
    titulo: string;
    pipeline_id: string;
    motivo: string | null;
    perdido_em: string;
    perdido_dia: string;
    etapa_de_onde_saiu: string | null;
    marcou: QuemMarcou;
    agente_id: string | null;
    origem: string;
  }>;
  opcoes: {
    funis: Array<{ id: string; name: string }>;
    etapas: Array<{ id: string; nome: string }>;
    agentes: Array<{ id: string; nome: string }>;
    origens: string[];
  };
}

export function rotuloDaOrigemOuAnuncio(chave: string, t: T): string {
  if (chave.startsWith("anuncio:")) return `${t("Anúncio")} …${chave.slice(-4)}`;
  return chave ? rotuloDaOrigem(chave, t) : t("Sem origem");
}

/**
 * MOTIVO DE PERDA (PC-025, item 1) em Dados › Explorar › Medir: perdidos no
 * período (pela data da perda), por motivo, com % do total perdido e "sem
 * motivo". Clicar no número lista os cards daquele motivo.
 */
export function MedidaMotivoDePerda({ periodo }: { periodo: PeriodoPedido | null }) {
  const t = useT();
  const [funil, setFunil] = useState("");
  const [etapa, setEtapa] = useState("");
  const [marcou, setMarcou] = useState<"" | QuemMarcou>("");
  const [agente, setAgente] = useState("");
  const [origem, setOrigem] = useState("");
  const [aberto, setAberto] = useState<string | null>(null);

  const params = new URLSearchParams(parametrosDoPeriodo(periodo));
  if (funil) params.set("pipeline_id", funil);
  if (etapa) params.set("etapa", etapa);
  if (marcou) params.set("marcou", marcou);
  if (agente) params.set("agente", agente);
  if (origem) params.set("origem", origem);
  const qs = params.toString();
  const q = useQuery({
    queryKey: ["dados", "perdas", qs],
    queryFn: () =>
      apiClient.get<{ data: RespostaDasPerdas }>(`/api/v1/dados/perdas?${qs}`).then((r) => r.data),
    staleTime: 60_000,
  });
  const d = q.data;
  const nomeDaEtapa = new Map((d?.opcoes.etapas ?? []).map((e) => [e.id, e.nome]));
  const rotuloDoMotivo = (m: string) =>
    m === SEM_MOTIVO ? t("Sem motivo") : t(rotuloDoMotivoDePerda(m));
  const maior = Math.max(1, ...(d?.motivos ?? []).map((m) => m.leads));
  const selecionado = d?.motivos.find((m) => m.motivo === aberto) ?? null;
  const cardsDoMotivo = selecionado
    ? (d?.cards ?? []).filter((c) => (c.motivo?.trim() || SEM_MOTIVO) === selecionado.motivo)
    : [];
  const select = "h-8 rounded-md border border-input bg-background px-2 text-xs";
  const rotuloDeQuem: Record<QuemMarcou, string> = {
    ia: t("IA"),
    pessoa: t("Pessoa"),
    outro: t("Outro"),
  };

  return (
    <div className="flex flex-col gap-5" data-testid="medida-motivo-de-perda">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("Filtros")}>
        <select
          className={select}
          value={funil}
          onChange={(e) => {
            setFunil(e.target.value);
            setEtapa("");
            setAberto(null);
          }}
          aria-label={t("Funil")}
          data-testid="perdas-funil"
        >
          <option value="">{t("Todos os funis")}</option>
          {(d?.opcoes.funis ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <select
          className={select}
          value={etapa}
          onChange={(e) => {
            setEtapa(e.target.value);
            setAberto(null);
          }}
          aria-label={t("Etapa de onde saiu")}
          data-testid="perdas-etapa"
        >
          <option value="">{t("Qualquer etapa de onde saiu")}</option>
          {(d?.opcoes.etapas ?? []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.nome}
            </option>
          ))}
        </select>
        <select
          className={select}
          value={marcou}
          onChange={(e) => {
            setMarcou(e.target.value as "" | QuemMarcou);
            setAberto(null);
          }}
          aria-label={t("Quem marcou")}
          data-testid="perdas-marcou"
        >
          <option value="">{t("IA ou pessoa")}</option>
          <option value="ia">{t("Marcado pela IA")}</option>
          <option value="pessoa">{t("Marcado por pessoa")}</option>
          <option value="outro">{t("Automação ou sistema")}</option>
        </select>
        <select
          className={select}
          value={agente}
          onChange={(e) => {
            setAgente(e.target.value);
            setAberto(null);
          }}
          aria-label={t("Agente de IA")}
          data-testid="perdas-agente"
        >
          <option value="">{t("Qualquer agente de IA")}</option>
          {(d?.opcoes.agentes ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.nome}
            </option>
          ))}
        </select>
        <select
          className={select}
          value={origem}
          onChange={(e) => {
            setOrigem(e.target.value);
            setAberto(null);
          }}
          aria-label={t("Origem ou anúncio")}
          data-testid="perdas-origem"
        >
          <option value="">{t("Qualquer origem")}</option>
          {(d?.opcoes.origens ?? []).map((o) => (
            <option key={o} value={o}>
              {rotuloDaOrigemOuAnuncio(o, t)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <Secao
          className="min-w-0 flex-[1_1_480px]"
          rotulo={t("Motivo de perda")}
          titulo={t("Perdidos por motivo")}
          extra={
            d
              ? t("{n} perdidos no período · clique num motivo para ver os cards").replace(
                  "{n}",
                  String(d.total),
                )
              : null
          }
        >
          {q.isLoading && <p className="text-sm text-text-muted">{t("Carregando…")}</p>}
          {q.isError && (
            <p className="text-sm text-destructive">
              {t("Não foi possível calcular os motivos de perda.")}
            </p>
          )}
          {d && d.total === 0 && (
            <p className="text-sm text-text-muted">{t("Nenhum card perdido neste recorte.")}</p>
          )}
          {d?.truncado && (
            <p className="text-xs text-warning-fg">
              {t(
                "Mostrando as 10.000 perdas mais recentes. Escolha um período menor para ver tudo.",
              )}
            </p>
          )}
          <div className="flex flex-col gap-1.5" data-testid="perdas-barras">
            {(d?.motivos ?? []).map((m) => {
              const sel = m.motivo === aberto;
              return (
                <button
                  key={m.motivo || "sem-motivo"}
                  type="button"
                  data-testid="perdas-barra"
                  data-motivo={m.motivo}
                  aria-pressed={sel}
                  onClick={() => setAberto(sel ? null : m.motivo)}
                  className={cn(
                    "grid grid-cols-[minmax(120px,220px)_1fr_auto] items-center gap-3 rounded-md border-2 px-2 py-1.5 text-left text-xs",
                    sel ? "border-accent bg-accent/10" : "border-transparent hover:bg-muted",
                  )}
                >
                  <span className="truncate font-semibold" title={rotuloDoMotivo(m.motivo)}>
                    {rotuloDoMotivo(m.motivo)}
                  </span>
                  <span className="block h-3 overflow-hidden rounded-sm bg-muted">
                    <span
                      className="block h-full bg-accent"
                      style={{ width: `${Math.max(1, (m.leads / maior) * 100)}%` }}
                    />
                  </span>
                  <span className="whitespace-nowrap tabular-nums">
                    <strong data-testid="perdas-numero">{m.leads}</strong>{" "}
                    <span className="text-text-muted">· {m.pct}%</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Secao>

        <Secao
          className="min-w-0 flex-[1_1_420px]"
          rotulo={t("Cards do motivo")}
          titulo={
            selecionado
              ? `${rotuloDoMotivo(selecionado.motivo)} · ${selecionado.leads}`
              : t("Cards do motivo")
          }
        >
          {!selecionado ? (
            <p className="text-sm text-text-muted">{t("Escolha um motivo ao lado.")}</p>
          ) : (
            <div className="overflow-x-auto" data-testid="perdas-lista">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    {[t("Card"), t("Saiu de"), t("Marcou"), t("Perdido em")].map((c) => (
                      <th
                        key={c}
                        className="border-b border-border px-3 py-2 text-left text-xs font-semibold whitespace-nowrap text-text-muted"
                      >
                        {c}
                      </th>
                    ))}
                    <th className="border-b border-border px-3 py-2">
                      <span className="sr-only">{t("Ação")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cardsDoMotivo.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-border/60 last:border-0"
                      data-testid="perdas-card"
                    >
                      <td className="px-3 py-2 font-semibold">{c.titulo}</td>
                      <td className="px-3 py-2 text-text-muted">
                        {c.etapa_de_onde_saiu
                          ? (nomeDaEtapa.get(c.etapa_de_onde_saiu) ?? "—")
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-text-muted">{rotuloDeQuem[c.marcou]}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-text-muted tabular-nums">
                        {c.perdido_dia.slice(8, 10)}/{c.perdido_dia.slice(5, 7)}/
                        {c.perdido_dia.slice(0, 4)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          href={linkDoFunil(c.pipeline_id, { lead: c.id })}
                          className="text-xs font-semibold whitespace-nowrap text-accent underline-offset-2 hover:underline"
                        >
                          {t("Abrir no funil")}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Secao>
      </div>
    </div>
  );
}
