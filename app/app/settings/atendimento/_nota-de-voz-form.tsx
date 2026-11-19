"use client";
/**
 * PC-043: a chave "nota de voz no formato do WhatsApp" — a porta de
 * `settings.nota_de_voz.formato_whatsapp`. A regra mora em
 * `lib/messaging/media/voice-transcode.ts`; a gravação, em
 * `/api/v1/settings/nota-de-voz`. Nasce DESLIGADA.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

export function NotaDeVozForm({ inicial }: { inicial: boolean }) {
  const t = useT();
  const [ligada, setLigada] = useState(inicial);
  const [salvo, setSalvo] = useState(inicial);
  const [isPending, startTransition] = useTransition();

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/nota-de-voz", { formato_whatsapp: ligada });
        setSalvo(ligada);
        toast.success(t("Formato da nota de voz salvo."));
      } catch {
        toast.error(t("Não consegui salvar."));
      }
    });
  }

  return (
    <form
      onSubmit={salvar}
      className="flex max-w-3xl flex-col gap-4"
      data-testid="form-nota-de-voz"
    >
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Nota de voz no formato do WhatsApp")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Ligada, o áudio que a equipe grava no CRM é convertido para o formato da nota de voz do WhatsApp antes de sair: um canal só, voz em 32 kbps e quadros curtos. O arquivo fica cerca de quatro vezes menor e toca no celular do cliente como um áudio gravado no próprio WhatsApp. Útil sobretudo no canal oficial, que entrega o arquivo do jeito que o navegador gravou.",
            )}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="nota-de-voz-formato-whatsapp"
            checked={ligada}
            disabled={isPending}
            onChange={(e) => setLigada(e.target.checked)}
          />
          {t("Ligar nesta empresa")}
        </label>
      </Card>
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={ligada === salvo || isPending}
          data-testid="nota-de-voz-salvar"
        >
          {isPending ? t("Salvando...") : t("Salvar")}
        </Button>
      </div>
    </form>
  );
}
