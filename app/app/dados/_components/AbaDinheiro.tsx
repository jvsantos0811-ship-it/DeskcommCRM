"use client";
import Link from "next/link";
import { useMemo, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { linkDoFunil, valorEsperado, variacao } from "@/lib/dados/retrato";
import type { RespostaDaQualidade } from "@/lib/dados/resposta";
import { REGUA_PELA_FICHA } from "@/lib/dados/retrato-pela-ficha";

import {
  CartaoDeNumero,
  nomeDoLead,
  rotuloDaSituacao,
  Secao,
  SeloDoNivel,
  TabelaDeLeads,
  useDinheiro,
  Variacao,
} from "./pecas";

/** A tela do catálogo de valores (v3 §1.1). */
const TELA_DO_CATALOGO = "/app/settings/tenant/tipos-de-lead";

/**
 * Aba "Dinheiro em jogo" (v3 §4): quanto vale o que está aberto, a previsão
 * (valor × chance), o que está parado e o que esfriou. Os valores são SÓ os que
 * o escritório cadastrou em "Valor por tipo de lead" (ou digitou no negócio) —
 * nenhum número aqui é promessa de resultado.
 */
export function AbaDinheiro({ dados }: { dados: RespostaDaQualidade }) {
  const t = useT();
  const r = dados.resumo!;
  const pid = dados.pipeline_id;
  const brl = useDinheiro(r.moeda);
  const interesse = dados.rotulo_do_interesse ?? t("Interesse");
  const [lista, setLista] = useState<"parado" | "esfriou" | null>(null);
  const porId = useMemo(() => new Map(dados.leads.map((l) => [l.id, l])), [dados.leads]);
  const top = (dados.paineis?.onde_esta_o_dinheiro ?? []).map((id) => porId.get(id)).filter((l) => l !== undefined);
  const daLista = dados.leads.filter((l) => l.status === "open" && (lista === "parado" ? l.parado_na_fila : lista === "esfriou" && l.esfriou));
  const linhas = dados.paineis?.por_interesse ?? [];
  const maiorEmJogo = Math.max(1, ...linhas.map((x) => x.em_jogo_cents));
  const formatar = (n: number) => brl(n);

  return (
    <div className="flex flex-col gap-5">
      {r.abertos_sem_valor > 0 && (
        <div
          role="note"
          data-testid="aviso-sem-valor"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning-fg/40 bg-warning-bg px-4 py-3 text-sm text-warning-fg"
        >
          <span>
            <strong>
              {r.abertos_sem_valor === 1
                ? t("1 lead aberto está sem valor:")
                : t("{n} leads abertos estão sem valor:").replace("{n}", String(r.abertos_sem_valor))}
            </strong>{" "}
            {t(
              "o interesse dele ainda não foi identificado ou o tipo de lead não tem valor cadastrado. O dinheiro em jogo real é maior que o mostrado.",
            )}
          </span>
          <Link href={TELA_DO_CATALOGO} className="whitespace-nowrap font-semibold underline-offset-2 hover:underline">
            {t("Valor por tipo de lead →")}
          </Link>
        </div>
      )}

      <section aria-label={t("Resumo do dinheiro")} className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
        <CartaoDeNumero
          testid="cartao-em-jogo"
          rotulo={t("Dinheiro em jogo")}
          valor={brl(r.em_jogo_cents)}
          complemento={
            <>
              {t("{n} leads abertos com valor").replace("{n}", String(r.abertos_com_valor))} ·{" "}
              <Variacao diferenca={variacao(r.em_jogo_cents, dados.ontem?.em_jogo_cents)} rotulo={t("vs ontem")} formatar={formatar} />
            </>
          }
        />
        <CartaoDeNumero
          testid="cartao-previsao"
          rotulo={t("Previsão de faturamento")}
          valor={brl(r.previsao_cents)}
          complemento={
            <>
              {t("estimativa: valor × chance de fechar")} ·{" "}
              <Variacao diferenca={variacao(r.previsao_cents, dados.sete_dias?.previsao_cents)} rotulo={t("vs 7 dias")} formatar={formatar} />
            </>
          }
        />
        <CartaoDeNumero
          testid="cartao-parado"
          vermelho
          rotulo={t("Parado na fila")}
          valor={brl(r.parado_na_fila_cents)}
          onClick={() => setLista(lista === "parado" ? null : "parado")}
          complemento={t("{n} leads · esperando fechamento, fora do prazo ou sem resposta").replace(
            "{n}",
            String(r.parado_na_fila_leads),
          )}
        />
        <CartaoDeNumero
          testid="cartao-esfriou"
          vermelho
          rotulo={t("Esfriou")}
          valor={brl(r.esfriou_cents)}
          onClick={() => setLista(lista === "esfriou" ? null : "esfriou")}
          complemento={(r.versao_regra === REGUA_PELA_FICHA
            ? t("{n} leads contaram o caso e estão frios")
            : t("{n} leads conversaram 3 vezes ou mais e estão frios")
          ).replace("{n}", String(r.esfriou_leads))}
        />
      </section>

      {lista && (
        <Secao
          rotulo={lista === "parado" ? t("Parado na fila") : t("Esfriou")}
          titulo={`${lista === "parado" ? t("Parado na fila") : t("Esfriou")} · ${t("{n} leads").replace("{n}", String(daLista.length))}`}
        >
          <TabelaDeLeads
            testid="lista-do-dinheiro"
            leads={daLista}
            pipelineId={pid}
            vazio={t("Nenhum lead neste grupo.")}
            colunas={[
              { titulo: t("Lead"), celula: (l) => <span className="whitespace-nowrap font-semibold">{nomeDoLead(l, t)}</span> },
              { titulo: t("Nível"), celula: (l) => <SeloDoNivel nivel={l.nivel} nota={l.nota} status={l.status} ficha={l.ficha} /> },
              { titulo: t("Situação"), celula: (l) => <span className="text-xs">{l.situacoes.map((s) => rotuloDaSituacao(s, t)).join(" · ") || t("Esfriou")}</span> },
              { titulo: t("Etapa"), celula: (l) => <span className="whitespace-nowrap text-text-muted">{l.etapa}</span> },
              { titulo: t("Valor do caso"), direita: true, celula: (l) => brl(l.valor_cents) },
            ]}
          />
        </Secao>
      )}

      <Secao
        rotulo={t("Por tipo de lead")}
        titulo={t("Por {x}").replace("{x}", interesse.toLowerCase())}
        extra={t("Clique no nome para abrir o funil filtrado por ele")}
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm" data-testid="tabela-por-tipo">
            <thead>
              <tr className="text-xs text-text-muted">
                <th className="border-b border-border px-3 py-2 text-left font-semibold">{interesse}</th>
                <th className="border-b border-border px-3 py-2 text-right font-semibold">{t("Valor médio do caso")}</th>
                <th className="border-b border-border px-3 py-2 text-right font-semibold">{t("Leads")}</th>
                <th className="border-b border-border px-3 py-2 text-right font-semibold">{t("Abertos")}</th>
                <th className="border-b border-border px-3 py-2 text-right font-semibold">{t("Em jogo")}</th>
                <th className="border-b border-border px-3 py-2">
                  <span className="sr-only">{t("Barra")}</span>
                </th>
                <th className="border-b border-border px-3 py-2 text-right font-semibold">{t("Previsão")}</th>
                <th className="border-b border-border px-3 py-2 text-right font-semibold">{t("Parado")}</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((x) => (
                <tr key={x.interesse ?? ""} className="border-b border-border/60" data-testid="linha-por-tipo">
                  <td className="whitespace-nowrap px-3 py-2.5 font-semibold">
                    {x.interesse && pid ? (
                      <Link href={linkDoFunil(pid, { servico: x.interesse })} className="text-accent underline-offset-2 hover:underline">
                        {x.interesse}
                      </Link>
                    ) : (
                      (x.interesse ?? t("Não identificado"))
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {x.valor_medio_cents !== null ? brl(x.valor_medio_cents) : <span className="text-text-muted">{t("sem valor")}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{x.leads}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{x.abertos}</td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{x.em_jogo_cents > 0 ? brl(x.em_jogo_cents) : "—"}</td>
                  <td className="w-32 px-3 py-2.5">
                    <span className="block h-2.5 overflow-hidden rounded-sm bg-muted">
                      <span className="block h-full bg-accent" style={{ width: `${(x.em_jogo_cents / maiorEmJogo) * 100}%` }} />
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{x.previsao_cents > 0 ? brl(x.previsao_cents) : "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-error-fg">{x.parado_cents > 0 ? brl(x.parado_cents) : "—"}</td>
                </tr>
              ))}
              <tr className="font-bold">
                <td className="px-3 py-2.5">{t("Total")}</td>
                <td />
                <td className="px-3 py-2.5 text-right tabular-nums">{r.leads}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{r.abertos}</td>
                <td className="px-3 py-2.5 text-right tabular-nums" data-testid="total-em-jogo">
                  {brl(r.em_jogo_cents)}
                </td>
                <td />
                <td className="px-3 py-2.5 text-right tabular-nums">{brl(r.previsao_cents)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-error-fg">{brl(r.parado_na_fila_cents)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Secao>

      <Secao
        rotulo={t("Onde está o dinheiro")}
        titulo={t("Onde está o dinheiro")}
        extra={t("Os 10 leads de maior valor esperado (valor do caso × chance de fechar)")}
      >
        <TabelaDeLeads
          testid="onde-esta-o-dinheiro"
          leads={top}
          pipelineId={pid}
          vazio={t("Nenhum lead aberto com valor ainda.")}
          colunas={[
            { titulo: t("Lead"), celula: (l) => <span className="whitespace-nowrap font-semibold">{nomeDoLead(l, t)}</span> },
            { titulo: t("Nível"), celula: (l) => <SeloDoNivel nivel={l.nivel} nota={l.nota} status={l.status} ficha={l.ficha} /> },
            { titulo: interesse, celula: (l) => <span className="whitespace-nowrap">{l.interesse ?? t("Não identificado")}</span> },
            { titulo: t("Etapa"), celula: (l) => <span className="whitespace-nowrap text-text-muted">{l.etapa}</span> },
            { titulo: t("Valor do caso"), direita: true, celula: (l) => brl(l.valor_cents) },
            { titulo: t("Chance"), direita: true, celula: (l) => `${l.chance}%` },
            { titulo: t("Valor esperado"), direita: true, celula: (l) => <strong>{brl(valorEsperado(l))}</strong> },
          ]}
        />
      </Secao>
    </div>
  );
}
