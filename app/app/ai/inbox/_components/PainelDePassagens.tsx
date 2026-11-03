"use client";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { usePainelDePassagens } from "@/hooks/ai/usePainelDePassagens";

const PERIODOS = [1, 7, 30] as const;

/**
 * PC-014: o painel de passagens entre agentes, no topo da Central. Só aparece
 * quando a organização tem roteador ativo (ou já teve passagem no período).
 * Quatro números: passagens, sem resposta do destino em 2 min, laços (3ª
 * passagem em 1 hora) e roteador × ferramenta; e a lista de quem passou para quem.
 */
export function PainelDePassagens() {
  const t = useT();
  const [dias, setDias] = useState<1 | 7 | 30>(1);
  const { data } = usePainelDePassagens(dias);
  if (!data) return null;
  const { totais } = data;
  const houveAlgo = totais.passagens > 0 || totais.lacos > 0;
  if (!data.tem_roteador && !houveAlgo) return null;

  const numeros = [
    { rotulo: t("Passagens"), valor: totais.passagens, testid: "passagens-total" },
    { rotulo: t("Sem resposta do destino em 2 min"), valor: totais.semRespostaEm2Min, testid: "passagens-sem-resposta" },
    { rotulo: t("Viraram laço"), valor: totais.lacos, testid: "passagens-lacos" },
    {
      rotulo: t("Roteador × ferramenta"),
      valor: `${totais.peloRoteador} × ${totais.pelaFerramenta}`,
      testid: "passagens-roteador-ferramenta",
    },
  ];

  return (
    <section
      className="rounded-lg border border-border bg-surface p-4"
      aria-labelledby="painel-de-passagens-titulo"
      data-testid="painel-de-passagens"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="painel-de-passagens-titulo" className="text-base font-semibold">
          {t("Passagens entre agentes")}
        </h2>
        <div className="flex gap-1" role="group" aria-label={t("Período")}>
          {PERIODOS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={dias === p}
              onClick={() => setDias(p)}
              className={
                "rounded-md border px-2 py-1 text-xs " +
                (dias === p ? "border-accent bg-accent text-accent-foreground" : "border-border")
              }
            >
              {p === 1 ? t("Hoje") : p === 7 ? t("7 dias") : t("30 dias")}
            </button>
          ))}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {numeros.map((n) => (
          <div key={n.testid} className="rounded-md border border-border p-2">
            <dt className="text-xs text-text-muted">{n.rotulo}</dt>
            <dd className="text-xl font-semibold" data-testid={n.testid}>
              {n.valor}
            </dd>
          </div>
        ))}
      </dl>
      {totais.pelaEquipe > 0 ? (
        <p className="mt-2 text-xs text-text-muted">
          {t("Devolvidas pela equipe")}: {totais.pelaEquipe}
        </p>
      ) : null}
      {data.pares.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm" data-testid="passagens-pares">
          {data.pares.slice(0, 8).map((p) => (
            <li key={`${p.de}→${p.para}`} className="flex justify-between gap-2">
              <span>
                {p.de} → {p.para}
              </span>
              <span className="text-text-muted">{p.total}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-text-muted">{t("Nenhuma passagem no período.")}</p>
      )}
    </section>
  );
}
