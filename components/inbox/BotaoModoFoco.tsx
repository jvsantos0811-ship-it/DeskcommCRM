"use client";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { ArrowsInSimple, ArrowsOutSimple } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * O botão "Modo foco" das telas de conversa (PC-011) — o mesmo no Inbox e no
 * card do negócio. Liga e desliga; o Esc também desliga (`useModoFoco`).
 */
export function BotaoModoFoco({
  ligado,
  onAlternar,
  className,
}: {
  ligado: boolean;
  onAlternar: () => void;
  className?: string;
}) {
  const t = useT();
  const rotulo = ligado ? t("Sair do modo foco (Esc)") : t("Modo foco: só a conversa na tela");
  return (
    <Button
      type="button"
      size="sm"
      variant={ligado ? "secondary" : "ghost"}
      className={cn("w-11 px-0 lg:w-8", className)}
      onClick={onAlternar}
      aria-pressed={ligado}
      aria-label={ligado ? t("Sair do modo foco") : t("Modo foco")}
      title={rotulo}
      data-testid="modo-foco"
    >
      {ligado ? <ArrowsInSimple size={16} aria-hidden /> : <ArrowsOutSimple size={16} aria-hidden />}
    </Button>
  );
}
