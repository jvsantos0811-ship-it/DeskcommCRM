"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  HORAS_DA_MEDIDA,
  type HorasDaMedida,
  type MedidaDoParou,
  type Quebra,
} from "@/lib/dados/parou-antes";
import {
  parametrosDoPeriodo,
  type PeriodoPedido,
  type PeriodoResolvido,
} from "@/lib/dados/periodo";
import { linkDoFunil } from "@/lib/dados/retrato";
import { cn } from "@/lib/utils";

import { rotuloDaOrigemOuAnuncio } from "./MedidaMotivoDePerda";
import { Secao } from "./pecas";

type Eixo = "etapa" | "agente" | "origem" | "dia";

interface RespostaDoParou {
  configurado: boolean;
  funil: { id: string; name: string } | null;
  funis: Array<{ id: string; name: string; is_default: boolean }>;
  periodo: PeriodoResolvido | null;
  horas: HorasDaMedida;
  marco?: { id: string; nome: string } | null;
  fora?: Array<{ id: string; nome: string }>;
  etapas?: Array<{ id: string; nome: string }>;
  agentes?: Array<{ id: string; nome: string }>;
  conversaram?: number;
  so_primeira?: number;
  parou?: number;
  pct_so_primeira?: number;
  pct_parou?: number;
  cards?: Array<{
    id: string;
    titulo: string;
    medida: MedidaDoParou;
    stage_id: string;
    agente_id: string | null;
    origem: string;
    anuncio_id: string | null;
    dia: string;
  }>;
  quebras?: Record<MedidaDoParou, Record<Eixo, Quebra[]>>;
}

/**
 * "PAROU ANTES DA QUALIFICAÇÃO" (PC-025, item 3) em Dados › Explorar › Medir:
 * (a) só mandou a 1ª mensagem e (b) conversou e parou antes do marco, com a
 * espera de 24, 48 ou 72 horas. Quebras por etapa, agente, origem/anúncio e dia
 * de entrada; clicar abre a lista dos cards. Só contagem e horário.
 */
export function MedidaParouAntes({ periodo }: { periodo: PeriodoPedido | null }) {
  const t = useT();
  const [funil, setFunil] = useState("");
  const [horas, setHoras] = useState<HorasDaMedida>(24);
  const [medida, setMedida] = useState<MedidaDoParou>("parou");
  const [eixo, setEixo] = useState<Eixo>("etapa");
  const [grupo, setGrupo] = useState<string | null>(null);

  const params = new URLSearchParams({ ...parametrosDoPeriodo(periodo), horas: String(horas) });
  if (funil) params.set("pipeline_id", funil);
  const qs = params.toString();
  const q = useQuery({
    queryKey: ["dados", "parou-antes", qs],
    queryFn: () =>
      apiClient
        .get<{ data: RespostaDoParou }>(`/api/v1/dados/parou-antes?${qs}`)
        .then((r) => r.data),
    staleTime: 60_000,
  });
  const d = q.data;
  const nomeDaEtapa = new Map((d?.etapas ?? []).map((e) => [e.id, e.nome]));
  const nomeDoAgente = new Map((d?.agentes ?? []).map((a) => [a.id, a.nome]));
  const rotuloDoGrupo = (chave: string): string => {
    if (eixo === "etapa") return nomeDaEtapa.get(chave) ?? "—";
    if (eixo === "agente")
      return chave ? (nomeDoAgente.get(chave) ?? t("Agente removido")) : t("Sem agente de IA");
    if (eixo === "origem") return rotuloDaOrigemOuAnuncio(chave, t);
    return `${chave.slice(8, 10)}/${chave.slice(5, 7)}`;
  };
  const chaveDoCard = (c: NonNullable<RespostaDoParou["cards"]>[number]): string =>
    eixo === "etapa"
      ? c.stage_id
      : eixo === "agente"
        ? (c.agente_id ?? "")
        : eixo === "origem"
          ? c.anuncio_id
            ? `anuncio:${c.anuncio_id}`
            : c.origem
          : c.dia;
  const quebras = d?.quebras?.[medida][eixo] ?? [];
  const maior = Math.max(1, ...quebras.map((x) => x.leads));
  const cards = (d?.cards ?? []).filter(
    (c) => c.medida === medida && (grupo === null || chaveDoCard(c) === grupo),
  );
  const chip = (ativo: boolean) =>
    cn(
      "h-8 rounded-full border px-3 text-xs font-semibold",
      ativo
        ? "border-accent bg-accent text-accent-foreground"
        : "border-border-strong bg-surface text-text hover:border-accent",
    );
  const rotuloDoEixo: Record<Eixo, string> = {
    etapa: t("Etapa onde parou"),
    agente: t("Agente de IA"),
    origem: t("Origem ou anúncio"),
    dia: t("Dia de entrada"),
  };

  return (
    <div className="flex flex-col gap-5" data-testid="medida-parou-antes">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          value={funil || d?.funil?.id || ""}
          onChange={(e) => {
            setFunil(e.target.value);
            setGrupo(null);
          }}
          aria-label={t("Funil")}
          data-testid="parou-funil"
        >
          {(d?.funis ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <span className="ml-2 text-xs text-text-muted">
          {t("Sem mensagem do cliente há mais de")}
        </span>
        {HORAS_DA_MEDIDA.map((h) => (
          <button
            key={h}
            type="button"
            className={chip(horas === h)}
            aria-pressed={horas === h}
            data-testid={`parou-horas-${h}`}
            onClick={() => {
              setHoras(h);
              setGrupo(null);
            }}
          >
            {t("{n} h").replace("{n}", String(h))}
          </button>
        ))}
      </div>

      {q.isLoading && <p className="text-sm text-text-muted">{t("Carregando…")}</p>}
      {q.isError && (
        <p className="text-sm text-destructive">{t("Não foi possível calcular esta medida.")}</p>
      )}

      {d && !d.configurado && (
        <div
          className="rounded-lg border border-dashed border-border p-6 text-sm"
          data-testid="parou-configure-o-marco"
        >
          <p className="font-semibold text-text">
            {t("Configure o marco de qualificação deste funil.")}
          </p>
          <p className="mt-1 text-text-muted">
            {t(
              'Em Configurações › Funis, escolha a "Etapa marco de qualificação" (ex.: Qualificado) e, se quiser, as etapas que ficam fora desta medida.',
            )}{" "}
            <Link
              href="/app/settings/tenant/pipelines"
              className="font-semibold text-accent underline-offset-2 hover:underline"
            >
              {t("Abrir Configurações › Funis")}
            </Link>
          </p>
        </div>
      )}

      {d?.configurado && (
        <>
          <div className="flex flex-wrap gap-3">
            {(
              [
                [
                  "so_primeira",
                  t("Só mandou a 1ª mensagem"),
                  d.so_primeira ?? 0,
                  d.pct_so_primeira ?? 0,
                ],
                [
                  "parou",
                  t("Conversou e parou antes da qualificação"),
                  d.parou ?? 0,
                  d.pct_parou ?? 0,
                ],
              ] as const
            ).map(([m, rotulo, n, pct]) => (
              <button
                key={m}
                type="button"
                aria-pressed={medida === m}
                data-testid={`parou-medida-${m}`}
                onClick={() => {
                  setMedida(m);
                  setGrupo(null);
                }}
                className={cn(
                  "flex min-w-[240px] flex-1 flex-col gap-1 rounded-xl border-2 bg-surface p-4 text-left",
                  medida === m ? "border-accent" : "border-border hover:border-accent/60",
                )}
              >
                <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">
                  {rotulo}
                </span>
                <span
                  className="text-3xl font-bold text-text tabular-nums"
                  data-testid={`parou-numero-${m}`}
                >
                  {n}
                </span>
                <span className="text-xs text-text-muted">
                  {t("{p}% dos {n} cards que conversaram")
                    .replace("{p}", String(pct))
                    .replace("{n}", String(d.conversaram ?? 0))}
                </span>
              </button>
            ))}
          </div>
          <p className="text-xs text-text-muted" data-testid="parou-legenda">
            {t("Marco: {marco}.").replace("{marco}", d.marco?.nome ?? "")}{" "}
            {(d.fora ?? []).length > 0 &&
              t("Fora da medida: {etapas}.").replace(
                "{etapas}",
                (d.fora ?? []).map((e) => e.nome).join(", "),
              )}{" "}
            {t(
              "Só cards abertos, sem mensagem do cliente há mais de {n} h. Conta só mensagens e horários, nunca o texto.",
            ).replace("{n}", String(d.horas))}
          </p>

          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label={t("Quebrar por")}
          >
            <span className="mr-1 text-xs font-semibold tracking-wide text-text-muted uppercase">
              {t("Quebrar por")}
            </span>
            {(["etapa", "agente", "origem", "dia"] as const).map((e) => (
              <button
                key={e}
                type="button"
                className={chip(eixo === e)}
                aria-pressed={eixo === e}
                data-testid={`parou-eixo-${e}`}
                onClick={() => {
                  setEixo(e);
                  setGrupo(null);
                }}
              >
                {rotuloDoEixo[e]}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-start gap-5">
            <Secao
              className="min-w-0 flex-[1_1_420px]"
              rotulo={rotuloDoEixo[eixo]}
              titulo={rotuloDoEixo[eixo]}
              extra={t("Clique num grupo para ver os cards")}
            >
              {quebras.length === 0 && (
                <p className="text-sm text-text-muted">{t("Nenhum card nesta medida.")}</p>
              )}
              <div className="flex flex-col gap-1.5">
                {quebras.map((x) => {
                  const sel = grupo === x.chave;
                  return (
                    <button
                      key={x.chave || "vazio"}
                      type="button"
                      aria-pressed={sel}
                      data-testid="parou-grupo"
                      onClick={() => setGrupo(sel ? null : x.chave)}
                      className={cn(
                        "grid grid-cols-[minmax(120px,200px)_1fr_auto] items-center gap-3 rounded-md border-2 px-2 py-1.5 text-left text-xs",
                        sel ? "border-accent bg-accent/10" : "border-transparent hover:bg-muted",
                      )}
                    >
                      <span className="truncate font-semibold">{rotuloDoGrupo(x.chave)}</span>
                      <span className="block h-3 overflow-hidden rounded-sm bg-muted">
                        <span
                          className="block h-full bg-accent"
                          style={{ width: `${Math.max(1, (x.leads / maior) * 100)}%` }}
                        />
                      </span>
                      <strong className="tabular-nums">{x.leads}</strong>
                    </button>
                  );
                })}
              </div>
            </Secao>
            <Secao
              className="min-w-0 flex-[1_1_420px]"
              rotulo={t("Cards")}
              titulo={t("{n} cards").replace("{n}", String(cards.length))}
            >
              {cards.length === 0 ? (
                <p className="text-sm text-text-muted">{t("Nenhum card nesta medida.")}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border/60" data-testid="parou-lista">
                  {cards.map((c) => (
                    <li
                      key={c.id}
                      className="flex items-center justify-between gap-3 py-2 text-sm"
                      data-testid="parou-card"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{c.titulo}</span>
                        <span className="block truncate text-xs text-text-muted">
                          {nomeDaEtapa.get(c.stage_id) ?? "—"} · {t("entrou em")}{" "}
                          {c.dia.slice(8, 10)}/{c.dia.slice(5, 7)}
                        </span>
                      </span>
                      {d.funil && (
                        <Link
                          href={linkDoFunil(d.funil.id, { lead: c.id })}
                          className="shrink-0 text-xs font-semibold text-accent underline-offset-2 hover:underline"
                        >
                          {t("Abrir no funil")}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Secao>
          </div>
        </>
      )}
    </div>
  );
}
