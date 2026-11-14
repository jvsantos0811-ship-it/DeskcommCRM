"use client";
import Link from "next/link";
import { useMemo, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { estiloDoNivel } from "@/components/kanban/SeloDaNota";
import { NIVEIS, NOTA_MINIMA_DO_NIVEL, TEMPERATURAS, type Nivel, type Temperatura } from "@/lib/dados/qualidade";
import { linkDoFunil, variacao, variacaoEmPontos } from "@/lib/dados/retrato";
import type { LeadNaTela, RespostaDaQualidade } from "@/lib/dados/resposta";
import { REGUA_PELA_FICHA } from "@/lib/dados/retrato-pela-ficha";
import { cn } from "@/lib/utils";

import {
  acaoDoNivel,
  CartaoDeNumero,
  COR_DA_BARRA,
  COR_DA_TEMPERATURA,
  haQuantoTempo,
  nomeDoLead,
  NumeroNoFunil,
  porqueCurto,
  rotuloDaOrigem,
  rotuloDaTemperatura,
  Secao,
  SeloDoNivel,
  TabelaDeLeads,
  Variacao,
} from "./pecas";
import { AbaQualidadePelaFicha } from "./AbaQualidadePelaFicha";

type Selecao = { tipo: "nivel"; valor: Nivel } | { tipo: "temperatura"; valor: Temperatura };

/** Aba "Qualidade do lead" (v3 §4). */
export function AbaQualidade({ dados }: { dados: RespostaDaQualidade }) {
  // Régua v2 (Regra v2 §3, PC-037): o painel pela ficha tem a tela própria.
  if (dados.resumo?.versao_regra === REGUA_PELA_FICHA) return <AbaQualidadePelaFicha dados={dados} />;
  return <AbaQualidadePorMensagens dados={dados} />;
}

function AbaQualidadePorMensagens({ dados }: { dados: RespostaDaQualidade }) {
  const t = useT();
  const r = dados.resumo!;
  const pid = dados.pipeline_id;
  const interesse = dados.rotulo_do_interesse ?? t("Interesse");
  const [selecao, setSelecao] = useState<Selecao>({ tipo: "nivel", valor: "A" });

  const lista = useMemo(
    () =>
      dados.leads.filter((l) =>
        l.status === "open" && (selecao.tipo === "nivel" ? l.nivel === selecao.valor : l.temperatura === selecao.valor),
      ),
    [dados.leads, selecao],
  );
  const ontem = dados.ontem;
  const sete = dados.sete_dias;
  const vsOntem = t("vs ontem");
  const vs7 = t("vs 7 dias");

  const faixa = (n: Nivel) =>
    n === "A"
      ? t("nota ≥ {n}").replace("{n}", String(NOTA_MINIMA_DO_NIVEL.A))
      : n === "B"
        ? t("{a} a {b}").replace("{a}", String(NOTA_MINIMA_DO_NIVEL.B)).replace("{b}", String(NOTA_MINIMA_DO_NIVEL.A - 1))
        : n === "C"
          ? t("{a} a {b}").replace("{a}", String(NOTA_MINIMA_DO_NIVEL.C)).replace("{b}", String(NOTA_MINIMA_DO_NIVEL.B - 1))
          : t("abaixo de {n}").replace("{n}", String(NOTA_MINIMA_DO_NIVEL.C));

  const tituloDaLista =
    selecao.tipo === "nivel"
      ? `${t("Nível")} ${selecao.valor} · ${t("{n} leads").replace("{n}", String(lista.length))}`
      : `${rotuloDaTemperatura(selecao.valor, t)} · ${t("{n} leads").replace("{n}", String(lista.length))}`;
  const filtroDaLista = selecao.tipo === "nivel" ? { nivel: selecao.valor } : { temp: selecao.valor };

  const maiorInteresse = Math.max(1, ...(dados.paineis?.por_interesse ?? []).map((x) => x.leads));

  return (
    <div className="flex flex-col gap-5">
      <section aria-label={t("Resumo")} className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <CartaoDeNumero
          testid="cartao-nota-media"
          rotulo={t("Nota média dos abertos")}
          valor={
            <>
              {r.nota_media_abertos ?? "—"}
              <span className="text-base font-medium text-text-muted"> / 100</span>
            </>
          }
          complemento={
            <>
              <Variacao diferenca={variacao(r.nota_media_abertos, ontem?.nota_media_abertos)} rotulo={vsOntem} /> ·{" "}
              <Variacao diferenca={variacao(r.nota_media_abertos, sete?.nota_media_abertos)} rotulo={vs7} />
            </>
          }
        />
        <CartaoDeNumero
          rotulo={t("Responderam à IA")}
          valor={`${pct(r.responderam, r.leads)}%`}
          complemento={
            <>
              {t("{a} de {b}").replace("{a}", String(r.responderam)).replace("{b}", String(r.leads))} ·{" "}
              <Variacao
                diferenca={variacaoEmPontos(r.responderam, r.leads, sete?.responderam, sete?.leads)}
                rotulo={vs7}
                unidade={t("pts")}
              />
            </>
          }
        />
        <CartaoDeNumero
          rotulo={t("Engajados (3+ respostas)")}
          valor={`${pct(r.engajados, r.leads)}%`}
          complemento={
            <>
              {t("{n} leads").replace("{n}", String(r.engajados))} ·{" "}
              <Variacao diferenca={variacao(r.engajados, ontem?.engajados)} rotulo={vsOntem} />
            </>
          }
        />
        <CartaoDeNumero
          rotulo={`${interesse} ${t("identificado")}`}
          valor={`${pct(r.interesse_identificado, r.leads)}%`}
          complemento={t("{n} leads · {g} gravados pela IA")
            .replace("{n}", String(r.interesse_identificado))
            .replace("{g}", String(r.interesse_registrado))}
        />
        <CartaoDeNumero
          testid="cartao-desqualificados"
          rotulo={t("Desqualificados")}
          valor={
            <NumeroNoFunil pipelineId={pid} filtro={{ status: "lost" }} className="text-text" testid="link-desqualificados">
              {r.desqualificados}
            </NumeroNoFunil>
          }
          complemento={<Variacao diferenca={variacao(r.desqualificados, ontem?.desqualificados)} rotulo={vsOntem} melhorQuandoSobe={false} />}
        />
      </section>

      <Secao
        titulo={t("Nível de qualidade")}
        rotulo={t("Níveis e temperatura")}
        extra={t("Clique num nível para ver a lista abaixo; o link da lista abre o funil já filtrado.")}
      >
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
          {NIVEIS.map((n) => {
            const ativo = selecao.tipo === "nivel" && selecao.valor === n;
            const estilo = estiloDoNivel(n, true);
            return (
              <button
                key={n}
                type="button"
                data-testid={`cartao-nivel-${n}`}
                aria-pressed={ativo}
                onClick={() => setSelecao({ tipo: "nivel", valor: n })}
                className="flex flex-col gap-1.5 rounded-lg border-2 p-4 text-left focus-visible:outline-2 focus-visible:outline-accent"
                style={{ ...estilo, borderColor: ativo ? estilo.borderColor : "transparent" }}
              >
                <span className="flex items-center justify-between">
                  <span className="text-[15px] font-bold">{`${t("Nível")} ${n}`}</span>
                  <span className="text-xs">{faixa(n)}</span>
                </span>
                <span className="text-3xl font-bold tabular-nums text-text" data-testid={`cartao-nivel-${n}-valor`}>
                  {r.niveis[n]}
                </span>
                <span className="text-xs font-semibold">
                  {acaoDoNivel(n, t)}
                  {ontem ? (
                    <>
                      {" · "}
                      <Variacao diferenca={variacao(r.niveis[n], ontem.niveis?.[n])} rotulo={t("vs ontem")} />
                    </>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs text-text-muted">{t("Temperatura:")}</span>
          {TEMPERATURAS.map((v) => {
            const c = COR_DA_TEMPERATURA[v];
            const ativo = selecao.tipo === "temperatura" && selecao.valor === v;
            return (
              <button
                key={v}
                type="button"
                data-testid={`chip-temperatura-${v}`}
                aria-pressed={ativo}
                onClick={() => setSelecao({ tipo: "temperatura", valor: v })}
                className={cn("inline-flex items-center gap-1.5 rounded-full border-2 px-3 py-1.5 text-xs font-semibold")}
                style={{ backgroundColor: c.fundo, color: c.texto, borderColor: ativo ? c.ponto : "transparent" }}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c.ponto }} aria-hidden />
                {rotuloDaTemperatura(v, t)} {r.temperaturas[v]}
              </button>
            );
          })}
        </div>
      </Secao>

      <div className="flex flex-wrap items-start gap-5">
        <Secao
          className="min-w-0 flex-[999_1_640px]"
          rotulo={t("Lista filtrada")}
          titulo={<span data-testid="titulo-da-lista">{tituloDaLista}</span>}
          extra={
            pid && lista.length > 0 ? (
              <Link
                href={linkDoFunil(pid, filtroDaLista)}
                data-testid="abrir-lista-no-funil"
                className="text-sm font-semibold text-accent underline-offset-2 hover:underline"
              >
                {t("Abrir os {n} no funil →").replace("{n}", String(lista.length))}
              </Link>
            ) : null
          }
        >
          <TabelaDeLeads
            testid="lista-da-qualidade"
            leads={lista}
            pipelineId={pid}
            vazio={t("Nenhum lead aberto neste grupo.")}
            colunas={[
              { titulo: t("Nota"), celula: (l) => <SeloDoNivel nivel={l.nivel} nota={l.nota} /> },
              { titulo: t("Lead"), celula: (l) => <span className="whitespace-nowrap font-semibold">{nomeDoLead(l, t)}</span> },
              { titulo: interesse, celula: (l) => <span className="whitespace-nowrap">{l.interesse ?? t("Não identificado")}</span> },
              { titulo: t("Etapa"), celula: (l) => <span className="whitespace-nowrap text-text-muted">{l.etapa}</span> },
              { titulo: t("Por que"), celula: (l) => <span className="text-xs text-text-muted">{porqueCurto(l, interesse, t)}</span> },
              {
                titulo: t("Última resposta"),
                celula: (l: LeadNaTela) => (
                  <span className="whitespace-nowrap text-text-muted">{haQuantoTempo(l.ultima_resposta_em, dados.agora, t)}</span>
                ),
              },
            ]}
          />
        </Secao>

        <Secao className="min-w-0 flex-[1_1_380px]" titulo={t("Leads por {x}").replace("{x}", interesse.toLowerCase())} rotulo={t("Leads por interesse")}>
          <div className="flex flex-wrap gap-3 text-xs text-text-muted">
            {(["A", "B", "C", "D", "desqualificado"] as const).map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: COR_DA_BARRA[k] }} aria-hidden />
                {k === "desqualificado" ? t("Desqualificado") : k}
              </span>
            ))}
          </div>
          <div className="flex flex-col gap-3" data-testid="leads-por-interesse">
            {(dados.paineis?.por_interesse ?? []).map((x) => {
              const total = x.leads;
              const larg = (n: number) => `${total === 0 ? 0 : (n / total) * 100}%`;
              const nome = x.interesse ?? t("Não identificado");
              const conteudo = (
                <>
                  <span className="flex justify-between text-xs">
                    <span className="font-semibold text-text">{nome}</span>
                    <span className="tabular-nums text-text-muted" data-testid="interesse-total">
                      {total}
                    </span>
                  </span>
                  <span className="flex h-3.5 overflow-hidden rounded-sm bg-muted" style={{ width: `${(total / maiorInteresse) * 100}%` }}>
                    {NIVEIS.map((n) => (
                      <span key={n} style={{ width: larg(x.niveis[n]), backgroundColor: COR_DA_BARRA[n] }} />
                    ))}
                    <span style={{ width: larg(x.desqualificados), backgroundColor: COR_DA_BARRA.desqualificado }} />
                    <span style={{ width: larg(x.fechados), backgroundColor: COR_DA_BARRA.fechado }} />
                  </span>
                </>
              );
              return x.interesse && pid ? (
                <Link
                  key={nome}
                  href={linkDoFunil(pid, { servico: x.interesse })}
                  data-testid="interesse-no-funil"
                  data-interesse={x.interesse}
                  className="flex flex-col gap-1.5 rounded-md p-1 hover:bg-muted"
                >
                  {conteudo}
                </Link>
              ) : (
                <div key={nome} className="flex flex-col gap-1.5 p-1">
                  {conteudo}
                </div>
              );
            })}
          </div>
        </Secao>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <Secao className="min-w-0 flex-[999_1_560px]" titulo={t("Qualidade por origem")} rotulo={t("Qualidade por origem")}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-xs text-text-muted">
                  <th className="border-b border-border px-3 py-2 text-left font-semibold">{t("Origem")}</th>
                  <th className="border-b border-border px-3 py-2 text-right font-semibold">{t("Leads")}</th>
                  <th className="border-b border-border px-3 py-2 text-right font-semibold">{t("Responderam")}</th>
                  <th className="border-b border-border px-3 py-2 text-right font-semibold">{t("A ou B")}</th>
                  <th className="border-b border-border px-3 py-2 text-right font-semibold">{t("Nota média")}</th>
                </tr>
              </thead>
              <tbody>
                {(dados.paineis?.por_origem ?? []).map((o) => (
                  <tr key={o.origem} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2.5 font-semibold">{rotuloDaOrigem(o.origem, t)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{o.leads}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{pct(o.responderam, o.leads)}%</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{o.leads_ab}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{o.nota_media ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Secao>
        <Secao className="min-w-0 flex-[1_1_380px]" titulo={t("Motivos de desqualificação")} rotulo={t("Motivos de desqualificação")}>
          {dados.motivos.length === 0 ? (
            <p className="text-sm text-text-muted">{t("Nenhum lead desqualificado.")}</p>
          ) : (
            dados.motivos.map((m) => {
              const maior = Math.max(1, ...dados.motivos.map((x) => x.leads));
              return (
                <div key={m.motivo} className="flex flex-col gap-1.5">
                  <span className="flex justify-between text-xs">
                    <span className="font-semibold">{m.motivo === "" ? t("Sem motivo") : m.motivo === "other" ? t("Outro") : m.motivo}</span>
                    <NumeroNoFunil pipelineId={pid} filtro={{ status: "lost", ...(m.motivo ? { motivo: m.motivo } : {}) }}>
                      {m.leads}
                    </NumeroNoFunil>
                  </span>
                  <span
                    className="block h-2.5 rounded-sm"
                    style={{ width: `${(m.leads / maior) * 100}%`, backgroundColor: COR_DA_BARRA.desqualificado }}
                  />
                </div>
              );
            })
          )}
          <span className="text-xs text-text-muted">{t("Os motivos vêm do botão “Perdido” do funil.")}</span>
        </Secao>
      </div>
    </div>
  );
}

function pct(parte: number, todo: number): number {
  return todo === 0 ? 0 : Math.round((parte / todo) * 100);
}
