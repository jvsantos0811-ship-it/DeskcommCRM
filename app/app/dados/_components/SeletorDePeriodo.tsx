"use client";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { ATALHOS_DO_PERIODO, type AtalhoDoPeriodo, type PeriodoPedido } from "@/lib/dados/periodo";
import { cn } from "@/lib/utils";

/**
 * O SELETOR DE PERÍODO DO PAINEL DE DADOS (PC-025, item 2).
 *
 * "Tudo" (o padrão), os atalhos e "Personalizado" com "de" e "até". Quem chama
 * guarda o período no endereço (`?periodo=…&de=…&ate=…`): o link copiado abre
 * com o mesmo recorte. As datas são do fuso da organização — a conta é do
 * servidor, aqui só se escolhe. Quem chama monta com `key` do período: o
 * endereço que muda por fora (voltar do navegador) remonta com as datas certas.
 */
export function SeletorDePeriodo({
  valor,
  onMudar,
}: {
  valor: PeriodoPedido | null;
  onMudar: (p: PeriodoPedido | null) => void;
}) {
  const t = useT();
  const [de, setDe] = useState(valor?.atalho === "personalizado" ? (valor.de ?? "") : "");
  const [ate, setAte] = useState(valor?.atalho === "personalizado" ? (valor.ate ?? "") : "");
  const [abertoPersonalizado, setAbertoPersonalizado] = useState(valor?.atalho === "personalizado");

  const rotulos: Record<AtalhoDoPeriodo, string> = {
    hoje: t("Hoje"),
    "7d": t("7 dias"),
    "30d": t("30 dias"),
    mes: t("Mês atual"),
    mes_passado: t("Mês passado"),
    personalizado: t("Personalizado"),
  };
  const chip = (ativo: boolean) =>
    cn(
      "h-8 rounded-full border px-3 text-xs font-semibold",
      ativo
        ? "border-accent bg-accent text-accent-foreground"
        : "border-border-strong bg-surface text-text hover:border-accent",
    );
  const atual = valor?.atalho ?? null;

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label={t("Período")}
      data-testid="seletor-de-periodo"
    >
      <span className="mr-1 text-xs font-semibold tracking-wide text-text-muted uppercase">
        {t("Período")}
      </span>
      <button
        type="button"
        aria-pressed={atual === null}
        data-testid="periodo-tudo"
        className={chip(atual === null && !abertoPersonalizado)}
        onClick={() => {
          setAbertoPersonalizado(false);
          onMudar(null);
        }}
      >
        {t("Tudo")}
      </button>
      {ATALHOS_DO_PERIODO.map((a) => (
        <button
          key={a}
          type="button"
          aria-pressed={atual === a}
          data-testid={`periodo-${a}`}
          className={chip(atual === a || (a === "personalizado" && abertoPersonalizado))}
          onClick={() => {
            if (a === "personalizado") {
              setAbertoPersonalizado(true);
              if (de && ate) onMudar({ atalho: "personalizado", de, ate });
              return;
            }
            setAbertoPersonalizado(false);
            onMudar({ atalho: a });
          }}
        >
          {rotulos[a]}
        </button>
      ))}
      {abertoPersonalizado && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (de && ate) onMudar({ atalho: "personalizado", de, ate });
          }}
        >
          <label className="flex items-center gap-1 text-xs text-text-muted">
            {t("de")}
            <Input
              type="date"
              value={de}
              onChange={(e) => setDe(e.target.value)}
              className="h-8 w-[9.5rem] text-xs"
              data-testid="periodo-de"
              aria-label={t("Data inicial")}
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-text-muted">
            {t("até")}
            <Input
              type="date"
              value={ate}
              onChange={(e) => setAte(e.target.value)}
              className="h-8 w-[9.5rem] text-xs"
              data-testid="periodo-ate"
              aria-label={t("Data final")}
            />
          </label>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className="h-8"
            disabled={!de || !ate}
            data-testid="periodo-aplicar"
          >
            {t("Aplicar")}
          </Button>
        </form>
      )}
    </div>
  );
}
