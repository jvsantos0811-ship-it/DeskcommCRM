"use client";
import Link from "next/link";
import { useMemo, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { NIVEIS, TEMPERATURAS, type Nivel, type Temperatura } from "@/lib/dados/qualidade";
import {
  AGRUPAMENTOS,
  linkDoFunil,
  MEDIDAS,
  type Agrupamento,
  type FaixaDaPrimeiraResposta,
  type FiltroDoPainel,
  type GrupoDoExplorar,
  type Medida,
} from "@/lib/dados/retrato";
import type { PeriodoPedido } from "@/lib/dados/periodo";
import type { RespostaDaQualidade } from "@/lib/dados/resposta";
import { cn } from "@/lib/utils";

import { MedidaMotivoDePerda } from "./MedidaMotivoDePerda";
import { MedidaParouAntes } from "./MedidaParouAntes";
import { nomeDoLead, rotuloDaOrigem, rotuloDaTemperatura, Secao, SeloDoNivel, TabelaDeLeads, useDinheiro, type T } from "./pecas";

function rotuloDoDia(d: string, t: T): string {
  const dias = [t("Domingo"), t("Segunda"), t("Terça"), t("Quarta"), t("Quinta"), t("Sexta"), t("Sábado")];
  return dias[Number(d)] ?? d;
}

function rotuloDaFaixa(f: string, t: T): string {
  const rotulos: Record<FaixaDaPrimeiraResposta, string> = {
    ate_5_min: t("Menos de 5 min"),
    "5_a_30_min": t("5 a 30 min"),
    "30_min_a_2_h": t("30 min a 2 h"),
    mais_de_2_h: t("Mais de 2 h"),
    sem_resposta: t("Sem resposta"),
  };
  return rotulos[f as FaixaDaPrimeiraResposta] ?? f;
}

/**
 * Aba "Explorar" (v3 §4): o cliente monta a própria análise — agrupar por um
 * dos 9 eixos, medir uma das 6 medidas. Os grupos e as medidas vêm do servidor
 * (`montarPaineis`); clicar numa barra lista os leads do grupo, cada um com
 * "Abrir no funil", e o grupo que tem filtro no funil (nível, temperatura,
 * interesse) abre inteiro de uma vez.
 */
/**
 * PC-025: duas medidas que não saem do retrato — leem ao vivo, com o período da
 * página: o motivo de perda (pela data da perda) e "parou antes da
 * qualificação". Escolhidas no mesmo "Medir", trocam o painel de baixo.
 */
const MEDIDAS_AO_VIVO = ["motivo_de_perda", "parou_antes"] as const;
type MedidaAoVivo = (typeof MEDIDAS_AO_VIVO)[number];

export function AbaExplorar({ dados, periodo = null }: { dados: RespostaDaQualidade; periodo?: PeriodoPedido | null }) {
  const t = useT();
  const pid = dados.pipeline_id;
  const brl = useDinheiro(dados.resumo?.moeda ?? "BRL");
  const interesse = dados.rotulo_do_interesse ?? t("Interesse");
  const [agrupar, setAgrupar] = useState<Agrupamento>("primeira_resposta");
  const [medir, setMedir] = useState<Medida>("pct_qualificacao");
  const [aoVivo, setAoVivo] = useState<MedidaAoVivo | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const grupos = dados.paineis?.explorar[agrupar] ?? [];
  const porId = useMemo(() => new Map(dados.leads.map((l) => [l.id, l])), [dados.leads]);
  const etapas = useMemo(() => new Map(dados.por_etapa.map((e) => [e.etapa_id, e.etapa])), [dados.por_etapa]);

  const rotuloDoAgrupamento: Record<Agrupamento, string> = {
    interesse,
    nivel: t("Nível"),
    temperatura: t("Temperatura"),
    origem: t("Origem"),
    anuncio: t("Anúncio"),
    etapa: t("Etapa"),
    primeira_resposta: t("Tempo da 1ª resposta"),
    dia_da_semana: t("Dia da semana"),
    hora: t("Hora em que entrou"),
  };
  const rotuloDaMedida: Record<Medida, string> = {
    leads: t("Leads"),
    pct_resposta: t("% de resposta"),
    pct_qualificacao: t("% de qualificação"),
    nota_media: t("Nota média"),
    leads_ab: t("Leads A/B"),
    em_jogo_cents: t("Dinheiro em jogo"),
  };

  const rotuloDoGrupo = (g: GrupoDoExplorar): string => {
    const k = g.chave;
    switch (agrupar) {
      case "interesse":
        return k || t("Não identificado");
      case "nivel":
        return k === "desqualificado" ? t("Desqualificado") : k === "fechado" ? t("Fechado") : `${t("Nível")} ${k}`;
      case "temperatura":
        return k === "desqualificado"
          ? t("Desqualificado")
          : k === "fechado"
            ? t("Fechado")
            : rotuloDaTemperatura(k as Temperatura, t);
      case "origem":
        return rotuloDaOrigem(k, t);
      case "anuncio": {
        if (!k) return t("Sem anúncio");
        const texto = porId.get(g.ids[0] ?? "")?.anuncio_texto;
        return `${t("Anúncio")} …${k.slice(-4)}${texto ? ` · ${texto}` : ""}`;
      }
      case "etapa":
        return etapas.get(k) ?? porId.get(g.ids[0] ?? "")?.etapa ?? k;
      case "primeira_resposta":
        return rotuloDaFaixa(k, t);
      case "dia_da_semana":
        return rotuloDoDia(k, t);
      case "hora":
        return `${k}h`;
    }
  };

  const rotuloAoVivo: Record<MedidaAoVivo, string> = {
    motivo_de_perda: t("Motivo de perda"),
    parou_antes: t("Parou antes da qualificação"),
  };

  const valorDe = (g: GrupoDoExplorar): number => (medir === "nota_media" ? (g.nota_media ?? 0) : g[medir]);
  const textoDe = (g: GrupoDoExplorar): string =>
    medir === "pct_resposta" || medir === "pct_qualificacao"
      ? `${g[medir]}%`
      : medir === "em_jogo_cents"
        ? brl(g.em_jogo_cents)
        : medir === "nota_media"
          ? g.nota_media === null
            ? "—"
            : String(g.nota_media)
          : String(g[medir]);
  const maior = Math.max(1, ...grupos.map(valorDe));
  const selecionado = grupos.find((g) => g.chave === aberto) ?? null;
  const leadsDoGrupo = (selecionado?.ids ?? []).map((id) => porId.get(id)).filter((l) => l !== undefined);

  /** O grupo inteiro abre no funil quando o eixo tem filtro lá. */
  const filtroDoGrupo = (g: GrupoDoExplorar): FiltroDoPainel | null => {
    if (agrupar === "nivel" && (NIVEIS as readonly string[]).includes(g.chave)) return { nivel: g.chave as Nivel };
    if (agrupar === "temperatura" && (TEMPERATURAS as readonly string[]).includes(g.chave)) return { temp: g.chave as Temperatura };
    if (agrupar === "interesse" && g.chave) return { servico: g.chave };
    if ((agrupar === "nivel" || agrupar === "temperatura") && g.chave === "desqualificado") return { status: "lost" };
    if ((agrupar === "nivel" || agrupar === "temperatura") && g.chave === "fechado") return { status: "won" };
    return null;
  };

  const chip = (ativo: boolean) =>
    cn(
      "h-8 rounded-full border px-3 text-xs font-semibold",
      ativo ? "border-accent bg-accent text-accent-foreground" : "border-border-strong bg-surface text-text hover:border-accent",
    );

  return (
    <div className="flex flex-col gap-5">
      <section aria-label={t("Montar a análise")} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
        {aoVivo === null && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("Agrupar por")}>
          <span className="mr-1 w-24 text-xs font-semibold uppercase tracking-wide text-text-muted">{t("Agrupar por")}</span>
          {AGRUPAMENTOS.map((g) => (
            <button
              key={g}
              type="button"
              data-testid={`explorar-agrupar-${g}`}
              aria-pressed={agrupar === g}
              onClick={() => {
                setAgrupar(g);
                setAberto(null);
              }}
              className={chip(agrupar === g)}
            >
              {rotuloDoAgrupamento[g]}
            </button>
          ))}
        </div>
        )}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("Medir")}>
          <span className="mr-1 w-24 text-xs font-semibold uppercase tracking-wide text-text-muted">{t("Medir")}</span>
          {MEDIDAS.map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`explorar-medir-${m}`}
              aria-pressed={aoVivo === null && medir === m}
              onClick={() => {
                setMedir(m);
                setAoVivo(null);
              }}
              className={chip(aoVivo === null && medir === m)}
            >
              {rotuloDaMedida[m]}
            </button>
          ))}
          {MEDIDAS_AO_VIVO.map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`explorar-medir-${m}`}
              aria-pressed={aoVivo === m}
              onClick={() => setAoVivo(m)}
              className={chip(aoVivo === m)}
            >
              {rotuloAoVivo[m]}
            </button>
          ))}
        </div>
      </section>

      {aoVivo === "motivo_de_perda" && <MedidaMotivoDePerda periodo={periodo} />}
      {aoVivo === "parou_antes" && <MedidaParouAntes periodo={periodo} />}

      {aoVivo === null && (
      <div className="flex flex-wrap items-start gap-5">
        <Secao
          className="min-w-0 flex-[1_1_480px]"
          rotulo={t("Resultado")}
          titulo={t("{m} por {g}").replace("{m}", rotuloDaMedida[medir]).replace("{g}", rotuloDoAgrupamento[agrupar].toLowerCase())}
          extra={t("Clique numa barra para ver os leads do grupo")}
        >
          {grupos.length === 0 && <p className="text-sm text-text-muted">{t("Nenhum lead no retrato.")}</p>}
          <div className="flex flex-col gap-1.5" data-testid="explorar-barras">
            {grupos.map((g) => {
              const sel = g.chave === aberto;
              return (
                <button
                  key={g.chave}
                  type="button"
                  data-testid="explorar-barra"
                  data-chave={g.chave}
                  aria-pressed={sel}
                  onClick={() => setAberto(sel ? null : g.chave)}
                  className={cn(
                    "grid grid-cols-[minmax(120px,200px)_1fr_auto] items-center gap-3 rounded-md border-2 px-2 py-1.5 text-left text-xs",
                    sel ? "border-accent bg-accent/10" : "border-transparent hover:bg-muted",
                  )}
                >
                  <span className="truncate font-semibold" title={rotuloDoGrupo(g)}>
                    {rotuloDoGrupo(g)}
                  </span>
                  <span className="block h-3 overflow-hidden rounded-sm bg-muted">
                    <span className="block h-full bg-accent" style={{ width: `${Math.max(1, (valorDe(g) / maior) * 100)}%` }} />
                  </span>
                  <span className="whitespace-nowrap tabular-nums">
                    <strong>{textoDe(g)}</strong>{" "}
                    <span className="text-text-muted">· {t("{n} leads").replace("{n}", String(g.leads))}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Secao>

        <Secao
          className="min-w-0 flex-[1_1_420px]"
          rotulo={t("Leads do grupo")}
          titulo={
            selecionado
              ? `${rotuloDoGrupo(selecionado)} · ${t("{n} leads").replace("{n}", String(selecionado.leads))}`
              : t("Leads do grupo")
          }
          extra={(() => {
            if (!selecionado || !pid) return null;
            const f = filtroDoGrupo(selecionado);
            return f ? (
              <Link
                href={linkDoFunil(pid, f)}
                data-testid="explorar-abrir-grupo-no-funil"
                className="text-sm font-semibold text-accent underline-offset-2 hover:underline"
              >
                {t("Abrir os {n} no funil →").replace("{n}", String(selecionado.leads))}
              </Link>
            ) : null;
          })()}
        >
          {!selecionado ? (
            <p className="text-sm text-text-muted">{t("Escolha uma barra ao lado.")}</p>
          ) : (
            <TabelaDeLeads
              testid="explorar-lista"
              leads={leadsDoGrupo}
              pipelineId={pid}
              vazio={t("Nenhum lead neste grupo.")}
              colunas={[
                { titulo: t("Lead"), celula: (l) => <span className="whitespace-nowrap font-semibold">{nomeDoLead(l, t)}</span> },
                { titulo: t("Nível"), celula: (l) => <SeloDoNivel nivel={l.nivel} nota={l.nota} /> },
                { titulo: t("Etapa"), celula: (l) => <span className="whitespace-nowrap text-text-muted">{l.etapa}</span> },
              ]}
            />
                    )}
        </Secao>
      </div>
      )}
    </div>
  );
}
