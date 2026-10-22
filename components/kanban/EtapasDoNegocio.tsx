"use client";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Check } from "@/lib/ui/icons";

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

  return (
    <div className="flex flex-col gap-2">
      <ol
        className="flex gap-1.5 overflow-x-auto pb-1"
        aria-label={t("Etapas do funil")}
        data-etapas-do-negocio
      >
        {etapas.map((etapa, i) => {
          const atual = etapa.id === etapaAtualId;
          const feita = indiceAtual >= 0 && i < indiceAtual;
          const marcada = etapa.id === escolhida;
          const cor = atual
            ? etapa.is_won
              ? "border-success bg-success/10 text-success"
              : etapa.is_lost
                ? "border-destructive bg-destructive/10 text-destructive"
                : "border-primary bg-primary/10 text-text"
            : marcada
              ? "border-primary text-text"
              : "border-border text-text-muted hover:border-primary/50 hover:text-text";
          return (
            <li key={etapa.id} className="shrink-0">
              <button
                type="button"
                disabled={!podeMover || atual || movendo}
                aria-current={atual ? "step" : undefined}
                aria-pressed={marcada}
                title={atual ? t("Etapa atual") : `${t("Mover para")} ${etapa.name}`}
                onClick={() => setEscolhida(marcada ? null : etapa.id)}
                className={
                  "flex h-9 max-w-[11rem] items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors disabled:cursor-default " +
                  cor
                }
              >
                <span
                  aria-hidden
                  className={
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold " +
                    (atual
                      ? "bg-primary text-primary-foreground"
                      : feita
                        ? "bg-muted text-text"
                        : "bg-muted text-text-muted")
                  }
                >
                  {feita ? <Check size={12} /> : i + 1}
                </span>
                <span className="truncate">{etapa.name}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {destino && (
        <div
          role="group"
          aria-label={t("Confirmar mudança de etapa")}
          className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs"
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
