"use client";
import Link from "next/link";
import { useMemo } from "react";

import { useT } from "@/hooks/i18n/useT";
import { linkDoFunil, variacao, type PassoDoFunil } from "@/lib/dados/retrato";
import type { LeadNaTela, RespostaDaQualidade } from "@/lib/dados/resposta";
import { cn } from "@/lib/utils";

import { CartaoDeNumero, haQuantoTempo, nomeDoLead, NumeroNoFunil, rotuloDaSituacao, Secao, TabelaDeLeads, Variacao, type T } from "./pecas";

function duracao(seg: number | null, t: T): string {
  if (seg === null) return "—";
  if (seg < 60) return t("{n} s").replace("{n}", String(seg));
  if (seg < 3600) return t("{n} min").replace("{n}", (seg / 60).toFixed(1).replace(".", ",").replace(",0", ""));
  return t("{n} h").replace("{n}", (seg / 3600).toFixed(1).replace(".", ",").replace(",0", ""));
}

function diasOuHoras(h: number | null, t: T): string {
  if (h === null) return "—";
  if (h < 24) return t("{n} h").replace("{n}", String(h));
  const d = Math.floor(h / 24);
  return d === 1 ? t("1 dia") : t("{n} dias").replace("{n}", String(d));
}

/** "Há quanto tempo" na tabela de ação: o que explica a urgência de cada um. */
function tempoDaAcao(l: LeadNaTela, agora: string, t: T): string {
  if (l.situacoes.includes("sem_resposta")) return `${t("entrou")} ${haQuantoTempo(l.criado_em, agora, t)}`;
  if (l.situacoes.includes("parado") || l.situacoes.includes("esperando_fechamento")) {
    const naEtapa = t("{x} na etapa").replace("{x}", diasOuHoras(l.horas_na_etapa, t));
    return l.prazo_da_etapa_horas !== null
      ? `${naEtapa} (${t("prazo")}: ${diasOuHoras(Math.round(l.prazo_da_etapa_horas), t)})`
      : naEtapa;
  }
  return `${t("sem responder")} ${haQuantoTempo(l.ultima_resposta_em, agora, t)}`;
}

/** Aba "Gestão" (v3 §4): o dia, a semana, o funil do lead ao contrato e quem precisa de ação. */
export function AbaGestao({ dados }: { dados: RespostaDaQualidade }) {
  const t = useT();
  const r = dados.resumo!;
  const pid = dados.pipeline_id;
  const porId = useMemo(() => new Map(dados.leads.map((l) => [l.id, l])), [dados.leads]);
  const acao = (dados.paineis?.precisam_de_acao ?? []).map((id) => porId.get(id)).filter((l) => l !== undefined);
  const maiorDia = Math.max(1, ...dados.por_dia.map((d) => d.leads));
  const totalDias = dados.por_dia.reduce((a, d) => a + d.leads, 0);
  const maiorEtapa = Math.max(1, ...dados.por_etapa.map((e) => e.leads));

  const rotuloDoPasso: Record<PassoDoFunil, string> = {
    entraram: t("Entraram"),
    responderam: t("Responderam à IA"),
    engajaram: t("Engajaram (3+ respostas)"),
    qualificados: t("Qualificados"),
    fechados: t("Fechados"),
  };
  const perdas = dados.funil.map((p, i) => (i === 0 ? 0 : (dados.funil[i - 1]?.leads ?? 0) - p.leads));
  const maiorPerda = Math.max(...perdas);
  const passoDaMaiorPerda = maiorPerda > 0 ? perdas.indexOf(maiorPerda) : -1;
  const primeiro = dados.funil[0]?.leads ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <section aria-label={t("Números do dia")} className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-4">
        <CartaoDeNumero
          testid="cartao-leads-hoje"
          rotulo={t("Leads hoje")}
          valor={r.leads_hoje}
          complemento={t("ontem: {n}").replace("{n}", String(r.leads_ontem))}
        />
        <CartaoDeNumero
          rotulo={t("Últimos 7 dias")}
          valor={r.leads_7_dias}
          complemento={<Variacao diferenca={variacao(r.leads_7_dias, r.leads_7_dias_anteriores)} rotulo={t("vs os 7 dias anteriores")} />}
        />
        <CartaoDeNumero
          rotulo={t("Qualificados")}
          valor={r.qualificados}
          complemento={t("{n} nos últimos 7 dias").replace("{n}", String(r.qualificados_7_dias))}
        />
        <CartaoDeNumero
          testid="cartao-esperando"
          rotulo={t("Esperando fechamento")}
          valor={
            <NumeroNoFunil pipelineId={pid} filtro={{ situacao: "esperando_fechamento" }} className="text-text" testid="link-esperando">
              {r.esperando_fechamento}
            </NumeroNoFunil>
          }
          complemento={
            <NumeroNoFunil pipelineId={pid} filtro={{ situacao: "parado" }} className="text-error-fg" testid="link-fora-do-prazo">
              {t("{n} fora do prazo da etapa").replace("{n}", String(r.parado))}
            </NumeroNoFunil>
          }
        />
        <CartaoDeNumero
          rotulo={t("Fechados")}
          valor={
            <NumeroNoFunil pipelineId={pid} filtro={{ status: "won" }} className="text-text">
              {r.ganhos}
            </NumeroNoFunil>
          }
          complemento={<Variacao diferenca={variacao(r.ganhos, dados.sete_dias?.ganhos)} rotulo={t("vs 7 dias atrás")} />}
        />
        <CartaoDeNumero
          rotulo={t("1ª resposta (mediana)")}
          valor={duracao(r.mediana_primeira_resposta_seg, t)}
          complemento={t("do 1º contato à 1ª resposta")}
        />
      </section>

      <div className="flex flex-wrap items-start gap-5">
        <Secao
          className="min-w-0 flex-[999_1_560px]"
          rotulo={t("Leads por dia")}
          titulo={t("Leads por dia · últimos {n} dias").replace("{n}", String(dados.por_dia.length))}
          extra={t("Total {n}").replace("{n}", String(totalDias))}
        >
          <div className="flex h-44 items-end gap-1.5" data-testid="leads-por-dia">
            {dados.por_dia.map((d, i) => (
              <div key={d.dia} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${d.dia.slice(8)}/${d.dia.slice(5, 7)}: ${d.leads}`}>
                <span className="text-xs tabular-nums text-text-muted">{d.leads}</span>
                <span
                  className={cn("w-full rounded-t-sm", i === dados.por_dia.length - 1 ? "bg-accent" : "bg-accent/40")}
                  style={{ height: `${Math.max(2, (d.leads / maiorDia) * 130)}px` }}
                />
                <span className="text-[10px] text-text-muted">{`${d.dia.slice(8)}/${d.dia.slice(5, 7)}`}</span>
              </div>
            ))}
          </div>
        </Secao>

        <Secao className="min-w-0 flex-[1_1_380px]" rotulo={t("Funil")} titulo={t("Do lead ao contrato")}>
          {dados.funil.map((p, i) => (
            <div key={p.passo} className="flex flex-col gap-1">
              <span className="flex justify-between text-xs">
                <span className="font-semibold">{rotuloDoPasso[p.passo]}</span>
                <span className="tabular-nums">
                  <strong>{p.leads}</strong>{" "}
                  {i > 0 && (
                    <span className={cn(i === passoDaMaiorPerda ? "font-bold text-error-fg" : "text-text-muted")} data-testid={i === passoDaMaiorPerda ? "maior-perda" : undefined}>
                      −{perdas[i]}
                    </span>
                  )}
                </span>
              </span>
              <span className="block h-2.5 overflow-hidden rounded-sm bg-muted">
                <span className="block h-full bg-accent" style={{ width: `${primeiro === 0 ? 0 : (p.leads / primeiro) * 100}%` }} />
              </span>
            </div>
          ))}
          {passoDaMaiorPerda > 0 && (
            <span className="text-xs font-semibold text-error-fg">
              {t("Maior perda: entre “{a}” e “{b}” ({n} leads).")
                .replace("{a}", rotuloDoPasso[dados.funil[passoDaMaiorPerda - 1]!.passo])
                .replace("{b}", rotuloDoPasso[dados.funil[passoDaMaiorPerda]!.passo])
                .replace("{n}", String(maiorPerda))}
            </span>
          )}
        </Secao>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <Secao className="min-w-0 flex-[1_1_380px]" rotulo={t("Leads por etapa")} titulo={t("Leads por etapa")}>
          {dados.por_etapa.map((e) => (
            <div key={e.etapa_id} className="flex items-center gap-3 text-xs">
              <span className="w-40 shrink-0 truncate font-semibold" title={e.etapa}>
                {e.etapa}
              </span>
              <span className="block h-2.5 flex-1 overflow-hidden rounded-sm bg-muted">
                <span className="block h-full bg-info-fg" style={{ width: `${(e.leads / maiorEtapa) * 100}%` }} />
              </span>
              <span className="w-8 text-right tabular-nums">{e.leads}</span>
            </div>
          ))}
          {pid && (
            <Link href={linkDoFunil(pid)} className="text-xs font-semibold text-accent underline-offset-2 hover:underline">
              {t("Abrir o funil com o recorte do painel →")}
            </Link>
          )}
        </Secao>

        <Secao className="min-w-0 flex-[999_1_640px]" rotulo={t("Precisam de ação")} titulo={t("Precisam de ação")}>
          <TabelaDeLeads
            testid="precisam-de-acao"
            leads={acao}
            pipelineId={pid}
            vazio={t("Nenhum lead parado agora.")}
            colunas={[
              { titulo: t("Lead"), celula: (l) => <span className="whitespace-nowrap font-semibold">{nomeDoLead(l, t)}</span> },
              {
                titulo: t("Situação"),
                celula: (l) => (
                  <span className="text-xs font-semibold">
                    {l.situacoes.length > 0
                      ? l.situacoes.map((s) => rotuloDaSituacao(s, t)).join(" · ")
                      : t("Esfriou · conversou {n} vezes").replace("{n}", String(l.respostas))}
                  </span>
                ),
              },
              { titulo: t("Etapa"), celula: (l) => <span className="whitespace-nowrap text-text-muted">{l.etapa}</span> },
              { titulo: t("Há quanto tempo"), celula: (l) => <span className="whitespace-nowrap text-text-muted">{tempoDaAcao(l, dados.agora, t)}</span> },
            ]}
          />
        </Secao>
      </div>
    </div>
  );
}
