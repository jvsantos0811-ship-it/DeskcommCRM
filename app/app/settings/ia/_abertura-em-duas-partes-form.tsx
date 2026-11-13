"use client";
/**
 * PC-035: a chave "reaproveitar o histórico entre respostas" — a porta de
 * `settings.conversa.abertura_em_duas_partes`. A regra mora em
 * `lib/agent-engine/agent/abertura/duas-partes.ts` e em `sem-passada-final.ts`;
 * a gravação, em `/api/v1/settings/conversa`. Nasce DESLIGADA.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

export function AberturaEmDuasPartesForm({ inicial, podeEditar }: { inicial: boolean; podeEditar: boolean }) {
  const t = useT();
  const [ligada, setLigada] = useState(inicial);
  const [salvo, setSalvo] = useState(inicial);
  const [isPending, startTransition] = useTransition();

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/conversa", { abertura_em_duas_partes: { ligada } });
        setSalvo(ligada);
        toast.success(t("Economia de leitura salva."));
      } catch {
        toast.error(t("Não consegui salvar."));
      }
    });
  }

  return (
    <form onSubmit={salvar} className="flex max-w-3xl flex-col gap-4" data-testid="form-abertura-em-duas-partes">
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Reaproveitar o histórico entre respostas")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Ligada, a IA recebe a conversa na ordem em que o provedor consegue reaproveitar o que já leu na resposta anterior, e o atendimento termina assim que a mensagem é enviada, sem uma última chamada só para encerrar. A resposta fica mais barata e chega alguns segundos antes. A memória do cliente, o texto do agente e as regras de envio não mudam.",
            )}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="abertura-em-duas-partes-ligada"
            checked={ligada}
            disabled={isPending || !podeEditar}
            onChange={(e) => setLigada(e.target.checked)}
          />
          {t("Ligar nesta empresa")}
        </label>
        {!podeEditar ? (
          <p className="text-xs text-muted-foreground">{t("Só o administrador da empresa muda esta chave.")}</p>
        ) : null}
      </Card>
      {podeEditar ? (
        <div className="flex gap-2">
          <Button type="submit" disabled={ligada === salvo || isPending} data-testid="abertura-em-duas-partes-salvar">
            {isPending ? t("Salvando...") : t("Salvar")}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
