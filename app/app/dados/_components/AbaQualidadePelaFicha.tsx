"use client";
/**
 * Aba "Qualidade do lead" na RÉGUA V2 — Regra v2 §3 (PR 2) e PC-037 §1.
 *
 * O número sai da leitura da conversa (a ficha do lead), não da contagem de
 * mensagens: Situação, Temperatura (Quente, Morno, Agendado, Frio), Qualidade do
 * caso (A–D), Ação e Alertas da regra fixa. Quem ainda não foi lido aparece à
 * parte ("sem leitura") e não infla contador; quem a regra tirou da venda
 * (cliente, duplicado, fora da área…) vai para o bloco "Fora do funil de venda".
 *
 * Não abre o funil filtrado: o filtro do funil ainda é o da régua v1 (Regra v2
 * §5, PR 3). Cada linha abre o card do lead.
 */
import { useMemo, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { estiloDoNivel } from "@/components/kanban/SeloDaNota";
import { NIVEIS, type Nivel } from "@/lib/dados/qualidade";
import {
  FORA_DA_VENDA,
  SITUACOES_DA_FICHA,
  textoDoAlerta,
  type SituacaoDaFicha,
  type TemperaturaDaFicha,
} from "@/lib/dados/regra-da-ficha";
import { variacao } from "@/lib/dados/retrato";
import { textoDaAcaoNoRetrato } from "@/lib/dados/retrato-pela-ficha";
import type { LeadNaTela, RespostaDaQualidade } from "@/lib/dados/resposta";
import { cn } from "@/lib/utils";

import { CartaoDeNumero, COR_DA_BARRA, COR_DA_TEMPERATURA, haQuantoTempo, nomeDoLead, NumeroNoFunil, Secao, TabelaDeLeads, Variacao } from "./pecas";

type Selecao =
  | { tipo: "nivel"; valor: Nivel }
  | { tipo: "temperatura"; valor: Exclude<TemperaturaDaFicha, "—"> }
  | { tipo: "situacao"; valor: SituacaoDaFicha }
  | { tipo: "sem_leitura" }
  | { tipo: "fora" };

const TEMPERATURAS_V2 = ["Quente", "Morno", "Agendado", "Frio"] as const satisfies ReadonlyArray<Exclude<TemperaturaDaFicha, "—">>;

const COR_V2: Record<(typeof TEMPERATURAS_V2)[number], { fundo: string; texto: string; ponto: string }> = {
  Quente: COR_DA_TEMPERATURA.quente,
  Morno: COR_DA_TEMPERATURA.morno,
  Agendado: { fundo: "#ece8fb", texto: "#4b3a9c", ponto: "#7c5cd6" },
  Frio: COR_DA_TEMPERATURA.frio,
};

/** O texto de cada situação da regra fixa (chaves literais: o dicionário as acha). */
function rotuloDaSituacaoDaFicha(s: SituacaoDaFicha, t: (x: string) => string): string {
  switch (s) {
    case "Não é lead":
      return t("Não é lead");
    case "Já é cliente":
      return t("Já é cliente");
    case "Duplicado":
      return t("Duplicado");
    case "Fora da área":
      return t("Fora da área");
    case "Sem caso":
      return t("Sem caso");
    case "Sem requisito":
      return t("Sem requisito");
    case "Recusou":
      return t("Recusou");
    case "Já atendido por outro":
      return t("Já atendido por outro");
    case "Aguardando evento":
      return t("Aguardando evento");
    case "Fechado":
      return t("Fechado");
    case "Contrato enviado":
      return t("Contrato enviado");
    case "Proposta feita":
      return t("Proposta feita");
    case "Qualificado":
      return t("Qualificado");
    case "Em qualificação":
      return t("Em qualificação");
    case "Sem leitura":
      // A SITUAÇÃO da ficha (o Leitor leu e não entendeu) — não confundir com o lead não lido.
      return t("Ilegível");
    case "Só chegou":
      return t("Só chegou");
  }
}

function pct(parte: number, todo: number): number {
  return todo === 0 ? 0 : Math.round((parte / todo) * 100);
}

export function AbaQualidadePelaFicha({ dados }: { dados: RespostaDaQualidade }) {
  const t = useT();
  const r = dados.resumo!;
  const pf = r.pela_ficha;
  // As porcentagens da PC-037 são SOBRE OS LIDOS: lead sem ficha não é "não respondeu".
  const lidos = pf?.lidos ?? 0;
  const pid = dados.pipeline_id;
  const interesse = dados.rotulo_do_interesse ?? t("Interesse");
  const [selecao, setSelecao] = useState<Selecao>({ tipo: "nivel", valor: "A" });

  const abertos = useMemo(() => dados.leads.filter((l) => l.status === "open"), [dados.leads]);
  const lista = useMemo(
    () =>
      abertos.filter((l) => {
        const f = l.ficha ?? null;
        switch (selecao.tipo) {
          case "nivel":
            return l.nivel === selecao.valor;
          case "temperatura":
            return f !== null && f.temperatura === selecao.valor;
          case "situacao":
            return f !== null && f.situacao === selecao.valor;
          case "sem_leitura":
            return f === null;
          case "fora":
            return f !== null && FORA_DA_VENDA.has(f.situacao);
        }
      }),
    [abertos, selecao],
  );

  const semLeitura = pf?.sem_leitura ?? 0;
  const abertosLidos = Math.max(0, r.abertos - semLeitura);
  const ontem = dados.ontem;
  const sete = dados.sete_dias;

  const descricao: Record<Nivel, string> = {
    A: t("requisitos atendem, ou já tem proposta ou contrato"),
    B: t("contou o caso, sem requisito em risco"),
    C: t("contou parte do caso, ou há requisito em risco"),
    D: t("ainda não contou o caso"),
  };
  const rotuloDaTemp: Record<(typeof TEMPERATURAS_V2)[number], string> = {
    Quente: t("Quente"),
    Morno: t("Morno"),
    Agendado: t("Agendado"),
    Frio: t("Frio"),
  };
  const contagemDaTemp = (v: (typeof TEMPERATURAS_V2)[number]): number =>
    v === "Agendado" ? (pf?.agendados ?? 0) : r.temperaturas[v === "Quente" ? "quente" : v === "Morno" ? "morno" : "frio"];

  const tituloDaLista = (() => {
    const n = t("{n} leads").replace("{n}", String(lista.length));
    switch (selecao.tipo) {
      case "nivel":
        return `${t("Qualidade")} ${selecao.valor} · ${n}`;
      case "temperatura":
        return `${rotuloDaTemp[selecao.valor]} · ${n}`;
      case "situacao":
        return `${rotuloDaSituacaoDaFicha(selecao.valor, t)} · ${n}`;
      case "sem_leitura":
        return `${t("Sem leitura")} · ${n}`;
      case "fora":
        return `${t("Fora do funil de venda")} · ${n}`;
    }
  })();

  const situacoesComLead = SITUACOES_DA_FICHA.filter((s) => (pf?.situacoes[s] ?? 0) > 0);
  const maiorInteresse = Math.max(1, ...(dados.paineis?.por_interesse ?? []).map((x) => x.leads));

  return (
    <div className="flex flex-col gap-5" data-testid="aba-qualidade-pela-ficha">
      <p className="text-xs text-text-muted" data-testid="regua-do-painel">
        <span className="font-semibold text-text">{t("Régua v2")}</span>
        {" · "}
        {t("os números vêm da leitura da conversa (a ficha do lead), não da contagem de mensagens.")}
      </p>

      <section aria-label={t("Resumo")} className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <CartaoDeNumero
          testid="cartao-leitura"
          rotulo={t("Leads abertos lidos")}
          valor={`${pct(abertosLidos, r.abertos)}%`}
          complemento={t("{a} de {b} · {n} sem leitura")
            .replace("{a}", String(abertosLidos))
            .replace("{b}", String(r.abertos))
            .replace("{n}", String(semLeitura))}
        />
        <CartaoDeNumero
          rotulo={t("Responderam com as próprias palavras")}
          valor={`${pct(r.responderam, lidos)}%`}
          complemento={t("{a} de {b} lidos").replace("{a}", String(r.responderam)).replace("{b}", String(lidos))}
        />
        <CartaoDeNumero
          rotulo={t("Engajados (contaram o caso)")}
          valor={`${pct(r.engajados, lidos)}%`}
          complemento={
            <>
              {t("{n} leads").replace("{n}", String(r.engajados))} ·{" "}
              <Variacao diferenca={variacao(r.engajados, ontem?.engajados)} rotulo={t("vs ontem")} />
            </>
          }
        />
        <CartaoDeNumero
          rotulo={`${interesse} ${t("identificado na conversa")}`}
          valor={`${pct(r.interesse_identificado, lidos)}%`}
          complemento={
            <>
              {t("{n} leads").replace("{n}", String(r.interesse_identificado))} ·{" "}
              <Variacao diferenca={variacao(r.interesse_identificado, sete?.interesse_identificado)} rotulo={t("vs 7 dias")} />
            </>
          }
        />
        <CartaoDeNumero
          testid="cartao-desqualificados"
          rotulo={t("Desqualificados")}
          valor={
            <NumeroNoFunil pipelineId={pid} filtro={{ status: "lost" }} className="text-text" testid="link-desqualificados">
              {r.desqualificados}
            </NumeroNoFunil>
          }
          complemento={<Variacao diferenca={variacao(r.desqualificados, ontem?.desqualificados)} rotulo={t("vs ontem")} melhorQuandoSobe={false} />}
        />
      </section>

      <Secao
        titulo={t("Qualidade do caso")}
        rotulo={t("Qualidade e temperatura")}
        extra={t("Clique num grupo para ver a lista abaixo; cada linha abre o card do lead.")}
      >
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
          {NIVEIS.map((n) => {
            const ativo = selecao.tipo === "nivel" && selecao.valor === n;
            const estilo = estiloDoNivel(n, true);
            return (
              <button
                key={n}
                type="button"
                data-testid={`cartao-qualidade-${n}`}
                aria-pressed={ativo}
                onClick={() => setSelecao({ tipo: "nivel", valor: n })}
                className="flex flex-col gap-1.5 rounded-lg border-2 p-4 text-left focus-visible:outline-2 focus-visible:outline-accent"
                style={{ ...estilo, borderColor: ativo ? estilo.borderColor : "transparent" }}
              >
                <span className="text-[15px] font-bold">{`${t("Qualidade")} ${n}`}</span>
                <span className="text-3xl font-bold tabular-nums text-text" data-testid={`cartao-qualidade-${n}-valor`}>
                  {r.niveis[n]}
                </span>
                <span className="text-xs font-semibold">{descricao[n]}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs text-text-muted">{t("Temperatura:")}</span>
          {TEMPERATURAS_V2.map((v) => {
            const c = COR_V2[v];
            const ativo = selecao.tipo === "temperatura" && selecao.valor === v;
            return (
              <button
                key={v}
                type="button"
                data-testid={`chip-temperatura-v2-${v}`}
                aria-pressed={ativo}
                onClick={() => setSelecao({ tipo: "temperatura", valor: v })}
                className="inline-flex items-center gap-1.5 rounded-full border-2 px-3 py-1.5 text-xs font-semibold"
                style={{ backgroundColor: c.fundo, color: c.texto, borderColor: ativo ? c.ponto : "transparent" }}
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c.ponto }} aria-hidden />
                {rotuloDaTemp[v]} {contagemDaTemp(v)}
              </button>
            );
          })}
          <button
            type="button"
            data-testid="chip-sem-leitura"
            aria-pressed={selecao.tipo === "sem_leitura"}
            onClick={() => setSelecao({ tipo: "sem_leitura" })}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border-2 bg-muted px-3 py-1.5 text-xs font-semibold text-text-muted",
              selecao.tipo === "sem_leitura" ? "border-text-muted" : "border-transparent",
            )}
          >
            {t("Sem leitura")} {semLeitura}
          </button>
          <button
            type="button"
            data-testid="chip-fora-do-funil"
            aria-pressed={selecao.tipo === "fora"}
            onClick={() => setSelecao({ tipo: "fora" })}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border-2 bg-muted px-3 py-1.5 text-xs font-semibold text-text-muted",
              selecao.tipo === "fora" ? "border-text-muted" : "border-transparent",
            )}
          >
            {t("Fora do funil de venda")} {pf?.fora_do_funil ?? 0}
          </button>
        </div>
      </Secao>

      <div className="flex flex-wrap items-start gap-5">
        <Secao
          className="min-w-0 flex-[999_1_640px]"
          rotulo={t("Lista filtrada")}
          titulo={<span data-testid="titulo-da-lista">{tituloDaLista}</span>}
        >
          <TabelaDeLeads
            testid="lista-da-qualidade"
            leads={lista}
            pipelineId={pid}
            vazio={t("Nenhum lead aberto neste grupo.")}
            colunas={[
              {
                titulo: t("Qualidade"),
                celula: (l) =>
                  l.nivel ? (
                    <span className="inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold" style={estiloDoNivel(l.nivel)}>
                      {l.nivel}
                    </span>
                  ) : (
                    <span className="text-xs text-text-muted">—</span>
                  ),
              },
              { titulo: t("Lead"), celula: (l) => <span className="whitespace-nowrap font-semibold">{nomeDoLead(l, t)}</span> },
              { titulo: t("Situação"), celula: (l) => <span className="whitespace-nowrap">{l.ficha ? rotuloDaSituacaoDaFicha(l.ficha.situacao, t) : t("Sem leitura")}</span> },
              {
                titulo: t("Temperatura"),
                celula: (l) => (
                  <span className="whitespace-nowrap text-text-muted">
                    {l.ficha && l.ficha.temperatura !== "—" ? rotuloDaTemp[l.ficha.temperatura] : "—"}
                  </span>
                ),
              },
              { titulo: t("Ação"), celula: (l: LeadNaTela) => <span className="text-xs">{l.ficha ? textoDaAcaoNoRetrato(l.ficha.acao, t) : t("Aguardando a leitura")}</span> },
              {
                titulo: t("Alertas"),
                celula: (l: LeadNaTela) => (
                  <span className="text-xs text-text-muted">{l.ficha ? l.ficha.alertas.map((a) => textoDoAlerta(a, t)).join(" · ") : ""}</span>
                ),
              },
              {
                titulo: t("Última resposta"),
                celula: (l: LeadNaTela) => (
                  <span className="whitespace-nowrap text-text-muted">{haQuantoTempo(l.ultima_resposta_em, dados.agora, t)}</span>
                ),
              },
            ]}
          />
        </Secao>

        <Secao className="min-w-0 flex-[1_1_380px]" titulo={t("Situação dos leads abertos")} rotulo={t("Situação dos leads abertos")}>
          {situacoesComLead.length === 0 ? (
            <p className="text-sm text-text-muted">{t("Nenhum lead aberto lido ainda.")}</p>
          ) : (
            <ul className="flex flex-col gap-1.5" data-testid="situacoes-pela-ficha">
              {situacoesComLead.map((s) => {
                const ativo = selecao.tipo === "situacao" && selecao.valor === s;
                return (
                  <li key={s}>
                    <button
                      type="button"
                      aria-pressed={ativo}
                      onClick={() => setSelecao({ tipo: "situacao", valor: s })}
                      className={cn("flex w-full justify-between rounded-md px-2 py-1 text-left text-sm hover:bg-muted", ativo && "bg-muted")}
                    >
                      <span>
                        {rotuloDaSituacaoDaFicha(s, t)}
                        {FORA_DA_VENDA.has(s) ? <span className="ml-1 text-xs text-text-muted">· {t("fora da venda")}</span> : null}
                      </span>
                      <span className="tabular-nums text-text-muted">{pf?.situacoes[s] ?? 0}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Secao>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <Secao className="min-w-0 flex-[999_1_560px]" titulo={t("Leads por {x}").replace("{x}", interesse.toLowerCase())} rotulo={t("Leads por interesse")}>
          <div className="flex flex-col gap-3" data-testid="leads-por-interesse">
            {(dados.paineis?.por_interesse ?? []).map((x) => {
              const total = x.leads;
              const larg = (n: number) => `${total === 0 ? 0 : (n / total) * 100}%`;
              const nome = x.interesse ?? t("Não identificado");
              return (
                <div key={nome} className="flex flex-col gap-1.5 p-1">
                  <span className="flex justify-between text-xs">
                    <span className="font-semibold text-text">{nome}</span>
                    <span className="tabular-nums text-text-muted">{total}</span>
                  </span>
                  <span className="flex h-3.5 overflow-hidden rounded-sm bg-muted" style={{ width: `${(total / maiorInteresse) * 100}%` }}>
                    {NIVEIS.map((n) => (
                      <span key={n} style={{ width: larg(x.niveis[n]), backgroundColor: COR_DA_BARRA[n] }} />
                    ))}
                    <span style={{ width: larg(x.desqualificados), backgroundColor: COR_DA_BARRA.desqualificado }} />
                    <span style={{ width: larg(x.fechados), backgroundColor: COR_DA_BARRA.fechado }} />
                  </span>
                </div>
              );
            })}
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
        </Secao>
      </div>
    </div>
  );
}
