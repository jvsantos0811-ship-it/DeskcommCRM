"use client";
/**
 * Frase segura (PC-002b): a porta de `settings.frase_segura`. É o que o cliente
 * recebe quando uma trava barra a mensagem inteira da IA — nunca silêncio. A
 * regra mora em `lib/messaging/frase-segura.ts`; a gravação, em
 * `/api/v1/settings/frase-segura`.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

export function FraseSeguraForm({ inicial, padrao }: { inicial: string; padrao: string }) {
  const t = useT();
  const [frase, setFrase] = useState(inicial);
  const [salva, setSalva] = useState(inicial);
  const [isPending, startTransition] = useTransition();
  const sujo = frase.trim() !== salva.trim();

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/frase-segura", { frase });
        setSalva(frase);
        toast.success(t("Frase segura salva."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  return (
    <form onSubmit={salvar} className="flex max-w-3xl flex-col gap-4" data-testid="form-frase-segura">
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Frase segura da IA")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Quando uma trava de segurança barra a resposta inteira da IA, o cliente recebe esta frase em vez de ficar sem resposta, e a equipe é avisada com o texto barrado. Não prometa prazo, resultado nem quem vai atender.",
            )}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="frase-segura">{t("Frase")}</Label>
          <Textarea
            id="frase-segura"
            data-testid="frase-segura-texto"
            value={frase}
            maxLength={300}
            rows={2}
            placeholder={padrao}
            disabled={isPending}
            onChange={(e) => setFrase(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("Vazio usa a frase padrão:")} <span className="italic">{padrao}</span>
          </p>
        </div>
      </Card>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isPending || !sujo}>
          {isPending ? t("Salvando…") : t("Salvar frase segura")}
        </Button>
        {sujo ? <span className="text-xs text-muted-foreground">{t("Há mudanças não salvas.")}</span> : null}
      </div>
    </form>
  );
}
