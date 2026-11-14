"use client";
/**
 * As peças comuns das abas de Dados: o cartão de número com a variação contra
 * ontem e contra 7 dias, o link para o funil filtrado, o nome do lead e os
 * formatos (dinheiro, "há 3 h"). Os textos passam todos pelo `t()`.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import { useIdioma } from "@/lib/i18n/IdiomaProvider";
import { useT } from "@/hooks/i18n/useT";
import { finalDoTelefone, linkDoFunil, type FiltroDoPainel } from "@/lib/dados/retrato";
import { chaveForaDaNota, type FichaNoRetrato } from "@/lib/dados/retrato-pela-ficha";
import type { LeadNaTela } from "@/lib/dados/resposta";
import type { Nivel, Situacao, Temperatura } from "@/lib/dados/qualidade";
import { estiloDoNivel, rotuloDaParcela } from "@/components/kanban/SeloDaNota";
import { cn } from "@/lib/utils";

export type T = (s: string) => string;

/** "R$ 167.200" — sem centavos: é painel, não extrato. */
export function useDinheiro(moeda: string): (cents: number | null | undefined) => string {
  const idioma = useIdioma();
  return (cents) => {
    if (cents === null || cents === undefined) return "—";
    try {
      return new Intl.NumberFormat(idioma, { style: "currency", currency: moeda || "BRL", maximumFractionDigits: 0 }).format(
        cents / 100,
      );
    } catch {
      return `${moeda} ${Math.round(cents / 100)}`;
    }
  };
}

/** "há 3 h", "há 2 dias", "agora há pouco". */
export function haQuantoTempo(iso: string | null, agora: string, t: T): string {
  if (!iso) return "—";
  const ms = Date.parse(agora) - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return t("há menos de 1 h");
  if (h < 24) return t("há {n} h").replace("{n}", String(h));
  const d = Math.floor(h / 24);
  return d === 1 ? t("há 1 dia") : t("há {n} dias").replace("{n}", String(d));
}

/** O nome que a tela mostra: o título do negócio; "Sem nome · final 4821" para telefone puro. */
export function nomeDoLead(l: Pick<LeadNaTela, "nome">, t: T): string {
  if (l.nome === null) return t("Lead removido");
  const final = finalDoTelefone(l.nome);
  if (final) return `${t("Sem nome")} · ${t("final")} ${final}`;
  return l.nome;
}

export function rotuloDaOrigem(origem: string, t: T): string {
  switch (origem) {
    case "meta_ads":
      return "Meta Ads";
    case "whatsapp":
      return t("WhatsApp direto");
    case "webhook":
      return t("Integração");
    case "formulario":
    case "form":
      return t("Formulário");
    case "outra":
      return t("Outra");
    default:
      return origem.charAt(0).toUpperCase() + origem.slice(1).replace(/_/g, " ");
  }
}

export function rotuloDaTemperatura(v: Temperatura, t: T): string {
  return v === "quente" ? t("Quentes") : v === "morno" ? t("Mornos") : t("Frios");
}

export function rotuloDaSituacao(v: Situacao, t: T): string {
  return v === "esperando_fechamento"
    ? t("Esperando fechamento")
    : v === "parado"
      ? t("Fora do prazo da etapa")
      : t("Nunca recebeu resposta");
}

export function acaoDoNivel(n: Nivel, t: T): string {
  return n === "A" ? t("Fechar agora") : n === "B" ? t("Empurrar") : n === "C" ? t("Reaquecer") : t("Nutrir no automático");
}

export const COR_DA_TEMPERATURA: Record<Temperatura, { fundo: string; texto: string; ponto: string }> = {
  quente: { fundo: "#fdeee4", texto: "#a8380a", ponto: "#e2581b" },
  morno: { fundo: "#fbf3d9", texto: "#7a5600", ponto: "#c99400" },
  frio: { fundo: "#e6eef5", texto: "#2f5677", ponto: "#5b87ad" },
};

/** As barras do nível (mais fortes que o fundo do selo, para a barra empilhada). */
export const COR_DA_BARRA: Record<Nivel | "desqualificado" | "fechado", string> = {
  A: "#1f7a4d",
  B: "#2563a6",
  C: "#7c5cd6",
  D: "#a3afbd",
  desqualificado: "#e5b4ad",
  fechado: "#0f7a6e",
};

/** A variação de um número: "▲ 2 vs ontem". Sem retrato anterior, "sem retrato de ontem". */
export function Variacao({
  diferenca,
  rotulo,
  unidade,
  formatar,
  melhorQuandoSobe = true,
}: {
  diferenca: number | null;
  rotulo: string;
  unidade?: string;
  formatar?: (n: number) => string;
  melhorQuandoSobe?: boolean;
}) {
  const t = useT();
  if (diferenca === null) return <span>{`${t("sem retrato")} ${rotulo}`}</span>;
  if (diferenca === 0) return <span>{`${t("igual a")} ${rotulo}`}</span>;
  const sobe = diferenca > 0;
  const bom = sobe === melhorQuandoSobe;
  const valor = formatar ? formatar(Math.abs(diferenca)) : String(Math.abs(diferenca));
  return (
    <span>
      <span className={cn("font-semibold", bom ? "text-success-fg" : "text-error-fg")}>
        {sobe ? "▲" : "▼"} {valor}
        {unidade ? ` ${unidade}` : ""}
      </span>{" "}
      {rotulo}
    </span>
  );
}

/** O cartão de um número do topo. `href` transforma o cartão em link para o funil. */
export function CartaoDeNumero({
  rotulo,
  valor,
  complemento,
  vermelho,
  href,
  onClick,
  testid,
}: {
  rotulo: string;
  valor: ReactNode;
  complemento?: ReactNode;
  vermelho?: boolean;
  href?: string;
  onClick?: () => void;
  testid?: string;
}) {
  const corpo = (
    <>
      <span className={cn("text-xs font-semibold uppercase tracking-wide", vermelho ? "text-error-fg" : "text-text-muted")}>
        {rotulo}
      </span>
      <span
        className={cn("text-3xl font-bold tabular-nums leading-tight", vermelho ? "text-error-fg" : "text-text")}
        data-testid={testid ? `${testid}-valor` : undefined}
      >
        {valor}
      </span>
      {complemento && <span className="text-xs text-text-muted">{complemento}</span>}
    </>
  );
  const classe = cn(
    "flex flex-col gap-2 rounded-xl border bg-surface px-5 py-4 text-left",
    vermelho ? "border-error-fg/40 bg-error-bg" : "border-border",
    (href || onClick) && "transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent",
  );
  if (href) {
    return (
      <Link href={href} className={classe} data-testid={testid}>
        {corpo}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classe} data-testid={testid}>
        {corpo}
      </button>
    );
  }
  return (
    <div className={classe} data-testid={testid}>
      {corpo}
    </div>
  );
}

/** Um número que é link para o funil filtrado (sempre com o recorte do painel). */
export function NumeroNoFunil({
  pipelineId,
  filtro,
  children,
  testid,
  className,
}: {
  pipelineId: string | null;
  filtro: FiltroDoPainel;
  children: ReactNode;
  testid?: string;
  className?: string;
}) {
  if (!pipelineId) return <span className={className}>{children}</span>;
  return (
    <Link
      href={linkDoFunil(pipelineId, filtro)}
      data-testid={testid}
      className={cn("font-semibold text-accent underline-offset-2 hover:underline", className)}
    >
      {children}
    </Link>
  );
}

/** O rótulo das chaves da régua v2 para o lead aberto sem nível de venda. */
export function rotuloForaDaNota(k: string, t: T): string | null {
  if (k === "sem_leitura") return t("Sem leitura");
  if (k === "agendado") return t("Agendado");
  if (k === "fora_do_funil") return t("Fora do funil de venda");
  return null;
}

/**
 * O selo do nível. Régua v2 (`ficha` presente, objeto ou nulo): sem a nota antiga,
 * e o aberto sem nível aparece como "Sem leitura", "Agendado" ou "Fora do funil de
 * venda" — nunca como "Fechado".
 */
export function SeloDoNivel({
  nivel,
  nota,
  status,
  ficha,
}: {
  nivel: Nivel | null;
  nota: number;
  status?: "open" | "won" | "lost";
  ficha?: FichaNoRetrato | null;
}) {
  const t = useT();
  if (!nivel) {
    const chave = status ? chaveForaDaNota({ status, ficha }) : null;
    const rotulo = chave ? rotuloForaDaNota(chave, t) : null;
    return (
      <span className="inline-flex whitespace-nowrap rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-text-muted">
        {rotulo ?? (ficha !== undefined && status === "lost" ? t("Desqualificado") : t("Fechado"))}
      </span>
    );
  }
  return (
    <span className="inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold" style={estiloDoNivel(nivel)}>
      {ficha === undefined ? `${nivel} · ${nota}` : nivel}
    </span>
  );
}

export function Secao({
  titulo,
  extra,
  children,
  rotulo,
  className,
}: {
  titulo: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  rotulo?: string;
  className?: string;
}) {
  return (
    <section aria-label={rotulo} className={cn("flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold text-text">{titulo}</h2>
        {extra && <div className="text-xs text-text-muted">{extra}</div>}
      </div>
      {children}
    </section>
  );
}

/** A tabela de leads com "Abrir no funil" — usada pelas quatro abas. */
export function TabelaDeLeads({
  leads,
  pipelineId,
  colunas,
  vazio,
  testid,
}: {
  leads: LeadNaTela[];
  pipelineId: string | null;
  colunas: Array<{ titulo: string; celula: (l: LeadNaTela) => ReactNode; direita?: boolean }>;
  vazio: string;
  testid?: string;
}) {
  const t = useT();
  if (leads.length === 0) return <p className="text-sm text-text-muted">{vazio}</p>;
  return (
    <div className="overflow-x-auto" data-testid={testid}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {colunas.map((c) => (
              <th
                key={c.titulo}
                className={cn(
                  "whitespace-nowrap border-b border-border px-3 py-2 text-xs font-semibold text-text-muted",
                  c.direita ? "text-right" : "text-left",
                )}
              >
                {c.titulo}
              </th>
            ))}
            <th className="border-b border-border px-3 py-2">
              <span className="sr-only">{t("Ação")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {leads.map((l) => (
            <tr key={l.id} className="border-b border-border/60 last:border-0" data-testid="linha-de-lead" data-lead={l.id}>
              {colunas.map((c) => (
                <td key={c.titulo} className={cn("px-3 py-2.5 align-middle text-text", c.direita && "text-right tabular-nums")}>
                  {c.celula(l)}
                </td>
              ))}
              <td className="px-3 py-2.5 text-right">
                {pipelineId && (
                  <Link
                    href={linkDoFunil(pipelineId, { lead: l.id })}
                    className="whitespace-nowrap text-xs font-semibold text-accent underline-offset-2 hover:underline"
                  >
                    {t("Abrir no funil")}
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** O "por que" curto da lista: as parcelas da nota (sem a base da chance), em frases. */
export function porqueCurto(l: Pick<LeadNaTela, "porque">, rotuloDoInteresse: string, t: T): string {
  const frases = l.porque
    .filter(([chave]) => chave !== "chance" && chave !== "limite")
    .map(([chave, pontos]) => rotuloDaParcela({ chave, pontos }, rotuloDoInteresse, t));
  return frases.length > 0 ? frases.join(" · ") : t("Nenhum sinal ainda.");
}
