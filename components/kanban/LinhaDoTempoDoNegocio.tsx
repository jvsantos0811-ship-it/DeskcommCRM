"use client";
import { useMemo, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { CaretLeft, CaretRight, ClockCounterClockwise } from "@/lib/ui/icons";
import { activityLabel, actorName } from "@/lib/leads/activity-vocabulary";
import {
  CATEGORIAS_DO_REGISTRO,
  categoriaDoRegistro,
  type CategoriaDoRegistro,
} from "@/lib/leads/categoria-do-registro";
import type { TimelineItemView } from "@/lib/types/contacts";
import { cn } from "@/lib/utils";
import { LeadTimeline } from "./LeadTimeline";

/**
 * A linha do tempo do negócio como BOTÃO + PAINEL (PC-013).
 *
 * ─── Por que deixou de ficar à vista ────────────────────────────────────────
 *
 * Ela ficava aberta na coluna da direita, abaixo de tarefas e contratos — e em
 * negócio com histórico (o sistema registra cada sugestão de retomada que vence,
 * cada "negócio esfriou") ela empurrava Propostas para fora da tela e virava a
 * maior coisa do card. O dono pediu um botão: a coluna fica com o que é AÇÃO
 * (tarefas, contratos, propostas), e o histórico abre quando alguém pergunta
 * por ele.
 *
 * O botão não esconde o que importa: mostra QUANTOS registros há e o ÚLTIMO
 * deles (o que aconteceu, quem fez, quando), e ganha o selo "agora" quando um
 * registro chega ao vivo com o card aberto — a pergunta "de onde veio este
 * card?" continua a um clique, e "aconteceu algo agora?" continua à vista.
 *
 * ─── O painel ──────────────────────────────────────────────────────────────
 *
 * Ocupa a coluna da direita inteira (e a aba "Tarefas" no celular), com voltar,
 * a contagem e filtros por tipo — Tudo, Etapas, Conversa, Tarefas, Contratos e
 * propostas, Sistema (`categoriaDoRegistro`). A lista é a MESMA `LeadTimeline`
 * de antes, com o agrupamento por dia dela; o filtro só escolhe o que entra.
 */

type Filtro = "tudo" | CategoriaDoRegistro;

/**
 * Quantos registros a consulta da linha do tempo traz de uma vez
 * (`GET /api/v1/leads/[id]/timeline`, limite padrão 50, sem paginação no
 * `useLeadTimeline`). Com essa quantidade ou mais, a contagem diz "50+" — dizer
 * "50" seria afirmar um total que a tela não mediu.
 */
const TETO_DA_CONSULTA = 50;

function contagemLegivel(n: number): string {
  return n >= TETO_DA_CONSULTA ? `${TETO_DA_CONSULTA}+` : String(n);
}

interface Props {
  itens: TimelineItemView[];
  chegouAoVivo: Set<string>;
  isLoading: boolean;
  isError: boolean;
}

function rotuloDoFiltro(filtro: Filtro, t: (texto: string) => string): string {
  switch (filtro) {
    case "tudo":
      return t("Tudo");
    case "etapas":
      return t("Etapas");
    case "conversa":
      return t("Conversa");
    case "tarefas":
      return t("Tarefas");
    case "contratos":
      return t("Contratos e propostas");
    case "sistema":
      return t("Sistema");
  }
}

function maisRecente(itens: TimelineItemView[]): TimelineItemView | null {
  let ultimo: TimelineItemView | null = null;
  for (const item of itens) {
    if (!ultimo || item.performed_at > ultimo.performed_at) ultimo = item;
  }
  return ultimo;
}

export function BotaoDaLinhaDoTempo({
  itens,
  chegouAoVivo,
  isLoading,
  isError,
  onAbrir,
}: Props & { onAbrir: () => void }) {
  const t = useT();
  const idioma = useTagDeIdioma();
  const ultimo = maisRecente(itens);
  const temNovidade = chegouAoVivo.size > 0;

  let resumo: string;
  if (isLoading) resumo = t("Carregando a linha do tempo…");
  else if (isError) resumo = t("Não consegui carregar a linha do tempo. Tente de novo em instantes.");
  else if (!ultimo) resumo = t("Nada aconteceu com este negócio ainda.");
  else {
    let quando = "";
    try {
      quando = new Intl.DateTimeFormat(idioma, {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(ultimo.performed_at));
    } catch {
      quando = ultimo.performed_at;
    }
    const quem = actorName(
      ultimo.actor_kind ?? null,
      { agente: ultimo.actor_agent_name ?? null, usuario: ultimo.actor_user_name ?? null },
      t,
    );
    resumo = `${t("Último")}: ${t(activityLabel(ultimo.type))} · ${quem} · ${quando}`;
  }

  return (
    <button
      type="button"
      onClick={onAbrir}
      data-testid="botao-linha-do-tempo"
      aria-label={`${t("Abrir a linha do tempo")} (${contagemLegivel(itens.length)})`}
      className="my-3 flex w-full items-center gap-3 rounded-lg border border-border-strong bg-surface p-3 text-left shadow-sm transition-colors hover:border-primary hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-text"
      >
        <ClockCounterClockwise size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text">{t("Linha do tempo")}</span>
          <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-text">
            {contagemLegivel(itens.length)}
          </span>
          {temNovidade && (
            <span className="text-[10px] uppercase tracking-wide text-accent">{t("agora")}</span>
          )}
        </span>
        <span className="truncate text-xs text-text-muted">{resumo}</span>
      </span>
      <CaretRight size={16} aria-hidden className="shrink-0 text-text-muted" />
    </button>
  );
}

export function PainelDaLinhaDoTempo({
  itens,
  chegouAoVivo,
  isLoading,
  isError,
  onFechar,
}: Props & { onFechar: () => void }) {
  const t = useT();
  const [filtro, setFiltro] = useState<Filtro>("tudo");

  const contagem = useMemo(() => {
    const porCategoria = new Map<CategoriaDoRegistro, number>();
    for (const item of itens) {
      const c = categoriaDoRegistro(item.type);
      porCategoria.set(c, (porCategoria.get(c) ?? 0) + 1);
    }
    return porCategoria;
  }, [itens]);

  const visiveis = useMemo(
    () => (filtro === "tudo" ? itens : itens.filter((i) => categoriaDoRegistro(i.type) === filtro)),
    [itens, filtro],
  );

  // Só oferece filtro que tem o que mostrar — um botão que leva a uma lista
  // vazia é um clique gasto. "Tudo" está sempre lá.
  const filtros: Filtro[] = ["tudo", ...CATEGORIAS_DO_REGISTRO.filter((c) => (contagem.get(c) ?? 0) > 0)];

  return (
    <section
      aria-label={t("Linha do tempo")}
      data-testid="painel-linha-do-tempo"
      className="flex min-h-full flex-col py-3"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onFechar}
          aria-label={t("Voltar para tarefas e contratos")}
          title={t("Voltar para tarefas e contratos")}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          <CaretLeft size={16} aria-hidden />
        </button>
        <h3 className="text-sm font-semibold text-text">{t("Linha do tempo")}</h3>
        <span className="text-xs tabular-nums text-text-muted">
          {contagemLegivel(itens.length)} {itens.length === 1 ? t("registro") : t("registros")}
        </span>
      </div>
      {filtros.length > 1 && (
        <div role="group" aria-label={t("Filtrar a linha do tempo")} className="mt-2 flex flex-wrap gap-1.5">
          {filtros.map((f) => {
            const ligado = filtro === f;
            return (
              <button
                key={f}
                type="button"
                aria-pressed={ligado}
                onClick={() => setFiltro(f)}
                className={cn(
                  "h-7 rounded-full border px-2.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-accent",
                  ligado
                    ? "border-primary bg-primary font-medium text-primary-foreground"
                    : "border-border text-text hover:border-primary/60",
                )}
              >
                {rotuloDoFiltro(f, t)}
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-3 flex-1">
        <LeadTimeline itens={visiveis} chegouAoVivo={chegouAoVivo} isLoading={isLoading} isError={isError} />
      </div>
    </section>
  );
}
