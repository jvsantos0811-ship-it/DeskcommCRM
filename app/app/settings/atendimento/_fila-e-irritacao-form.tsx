"use client";
/**
 * Frase da fila e irritação (PC-002b, itens 6 e 7): a porta de
 * `settings.frase_da_fila` e `settings.irritacao`. Gravação em
 * `/api/v1/settings/fila-e-irritacao`.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

type Irritacao = "anotar" | "passar";

export function FilaEIrritacaoForm({
  inicial,
}: {
  inicial: { frase_da_fila: string; irritacao: Irritacao };
}) {
  const t = useT();
  const [frase, setFrase] = useState(inicial.frase_da_fila);
  const [irritacao, setIrritacao] = useState<Irritacao>(inicial.irritacao);
  const [salvo, setSalvo] = useState(inicial);
  const [isPending, startTransition] = useTransition();
  const sujo = frase.trim() !== salvo.frase_da_fila.trim() || irritacao !== salvo.irritacao;

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/fila-e-irritacao", { frase_da_fila: frase, irritacao });
        setSalvo({ frase_da_fila: frase, irritacao });
        toast.success(t("Fila e irritação salvas."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  return (
    <form onSubmit={salvar} className="flex max-w-3xl flex-col gap-4" data-testid="form-fila-e-irritacao">
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Quando ninguém pode assumir")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Frase que o cliente recebe quando a IA passa a conversa para a equipe e não há ninguém disponível agora. Não prometa prazo, resultado nem valores.",
            )}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="frase-da-fila">{t("Frase da fila")}</Label>
          <Textarea
            id="frase-da-fila"
            data-testid="frase-da-fila-texto"
            value={frase}
            maxLength={300}
            rows={2}
            disabled={isPending}
            onChange={(e) => setFrase(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("Vazio usa a frase padrão do sistema.")}</p>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">{t("Quando a IA perceber irritação")}</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="irritacao"
              value="anotar"
              data-testid="irritacao-anotar"
              checked={irritacao === "anotar"}
              disabled={isPending}
              onChange={() => setIrritacao("anotar")}
            />
            <span>
              {t("Só anotar no histórico (recomendado)")}
              <span className="block text-xs text-muted-foreground">
                {t("A IA continua atendendo e a equipe vê a anotação no negócio.")}
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="irritacao"
              value="passar"
              data-testid="irritacao-passar"
              checked={irritacao === "passar"}
              disabled={isPending}
              onChange={() => setIrritacao("passar")}
            />
            <span>
              {t("Passar para a equipe")}
              <span className="block text-xs text-muted-foreground">
                {t("A conversa sai da IA e vai para a fila da equipe.")}
              </span>
            </span>
          </label>
        </fieldset>
      </Card>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isPending || !sujo}>
          {isPending ? t("Salvando…") : t("Salvar fila e irritação")}
        </Button>
        {sujo ? <span className="text-xs text-muted-foreground">{t("Há mudanças não salvas.")}</span> : null}
      </div>
    </form>
  );
}
