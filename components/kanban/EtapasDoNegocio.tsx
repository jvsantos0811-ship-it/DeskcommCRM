"use client";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { CaretDown, Check } from "@/lib/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** Até quantas etapas a régua mostra os números; acima disso, seletor. */
export const LIMITE_DA_REGUA = 14;

export interface EtapaDoNegocio {
  id: string;
  name: string;
  is_won: boolean;
  is_lost: boolean;
}

/**
 * A régua de etapas do pop-up do negócio.
 *
 * Mostra onde o negócio está no funil (as etapas antes da atual levam um
 * visto) e deixa mover clicando na etapa de destino.
 *
 * ─── Mover pede CONFIRMAÇÃO ─────────────────────────────────────────────────
 *
 * No quadro, mover é arrastar — um gesto deliberado. Aqui seria um clique, e
 * um clique escapa: o pop-up é cheio de alvos, e a régua fica logo acima do
 * chat. Mover de etapa não é inocente — dispara automações e follow-ups da
 * etapa de entrada e fica no histórico — então o primeiro clique só ESCOLHE o
 * destino, e a escrita acontece no "Mover". Um clique fora do lugar custa um
 * "Cancelar", nunca um follow-up disparado por engano.
 */
export function EtapasDoNegocio({
  etapas,
  etapaAtualId,
  podeMover,
  movendo,
  onMover,
}: {
  etapas: EtapaDoNegocio[];
  etapaAtualId: string;
  podeMover: boolean;
  movendo: boolean;
  onMover: (stageId: string) => void;
}) {
  const t = useT();
  const [escolhida, setEscolhida] = useState<string | null>(null);
  const indiceAtual = etapas.findIndex((e) => e.id === etapaAtualId);
  const destino = escolhida ? etapas.find((e) => e.id === escolhida) : null;

  // Mais etapas que isto e a régua de números deixa de caber com folga no
  // notebook: vira só a etapa atual + seletor, como no celular.
  const soSeletor = etapas.length > LIMITE_DA_REGUA;
  const atual = indiceAtual >= 0 ? etapas[indiceAtual] : null;

  return (
    <div className="flex flex-col gap-1.5">
      {/* RÉGUA COMPACTA (PC-011): sem barra de rolagem. Cada etapa é um número
          (o nome no `title` e no toque — tocar escolhe e a confirmação diz o
          nome); a ATUAL leva o nome à vista. No celular e em funil comprido,
          só a atual + um seletor. As regras de mover não mudam. */}
      <ol
        className={cn("flex flex-nowrap items-center gap-1", soSeletor ? "hidden" : "max-sm:hidden")}
        aria-label={t("Etapas do funil")}
        data-etapas-do-negocio
      >
        {etapas.map((etapa, i) => {
          const ehAtual = etapa.id === etapaAtualId;
          const feita = indiceAtual >= 0 && i < indiceAtual;
          const marcada = etapa.id === escolhida;
          const cor = ehAtual
            ? etapa.is_won
              ? "border-success bg-success/10 text-success"
              : etapa.is_lost
                ? "border-destructive bg-destructive/10 text-destructive"
                : "border-primary bg-primary/10 text-text"
            : marcada
              ? "border-primary text-text"
              : "border-border text-text-muted hover:border-primary/50 hover:text-text";
          return (
            <li key={etapa.id} className={ehAtual ? "min-w-0 shrink" : "shrink-0"}>
              <button
                type="button"
                disabled={!podeMover || ehAtual || movendo}
                aria-current={ehAtual ? "step" : undefined}
                aria-pressed={marcada}
                aria-label={`${i + 1}. ${etapa.name}`}
                title={ehAtual ? `${t("Etapa atual")}: ${etapa.name}` : `${t("Mover para")} ${etapa.name}`}
                onClick={() => setEscolhida(marcada ? null : etapa.id)}
                className={
                  "flex h-7 min-w-0 items-center gap-1.5 rounded-full border text-xs font-medium transition-colors disabled:cursor-default " +
                  (ehAtual ? "max-w-[14rem] pr-2.5 pl-0.5 " : "w-7 justify-center ") +
                  cor
                }
              >
                <span
                  aria-hidden
                  className={
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold " +
                    (ehAtual
                      ? "bg-primary text-primary-foreground"
                      : feita
                        ? "bg-muted text-text"
                        : "text-text-muted")
                  }
                >
                  {feita ? <Check size={12} /> : i + 1}
                </span>
                {ehAtual && (
                  <span className="truncate" aria-hidden>
                    {etapa.name}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>

      <div className={cn("flex min-w-0 items-center gap-2", soSeletor ? "flex" : "sm:hidden")}>
        <span
          className="min-w-0 truncate rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-text"
          title={atual ? `${t("Etapa atual")}: ${atual.name}` : undefined}
        >
          {atual ? `${indiceAtual + 1}. ${atual.name}` : t("Etapa atual")}
        </span>
        {podeMover && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={movendo}
                className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-text-muted hover:bg-muted hover:text-text disabled:opacity-60"
              >
                {t("Mudar etapa")}
                <CaretDown size={12} aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[60dvh] overflow-y-auto">
              {etapas.map((etapa, i) => (
                <DropdownMenuItem
                  key={etapa.id}
                  disabled={etapa.id === etapaAtualId}
                  onSelect={() => setEscolhida(etapa.id)}
                >
                  {i + 1}. {etapa.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {destino && (
        <div
          role="group"
          aria-label={t("Confirmar mudança de etapa")}
          className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs"
        >
          <span className="text-text">
            {t("Mover este negócio para")} <strong>{destino.name}</strong>?
          </span>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => setEscolhida(null)}
              className="h-8 rounded-md px-3 font-medium text-text-muted hover:bg-muted hover:text-text"
            >
              {t("Cancelar")}
            </button>
            <button
              type="button"
              disabled={movendo}
              onClick={() => {
                onMover(destino.id);
                setEscolhida(null);
              }}
              className="h-8 rounded-md bg-primary px-3 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {t("Mover")}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
