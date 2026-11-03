"use client";
/**
 * PC-020: "sem fonte, não afirma" — a porta de `settings.conversa.sem_fonte`.
 * A regra mora em `lib/agent-engine/guardrails/sem-fonte.ts`; a gravação, em
 * `/api/v1/settings/conversa`.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import type { EstadoSemFonte } from "@/lib/agent-engine/guardrails/sem-fonte";

export function SemFonteForm({ inicial }: { inicial: EstadoSemFonte }) {
  const t = useT();
  const [estado, setEstado] = useState<EstadoSemFonte>(inicial);
  const [salvo, setSalvo] = useState<EstadoSemFonte>(inicial);
  const [isPending, startTransition] = useTransition();

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/conversa", { sem_fonte: { estado } });
        setSalvo(estado);
        toast.success(t("Conferência de fonte salva."));
      } catch {
        toast.error(t("Não consegui salvar."));
      }
    });
  }

  const opcoes: { valor: EstadoSemFonte; rotulo: string }[] = [
    { valor: "decidindo", rotulo: t("Barrar e reescrever (recomendado)") },
    { valor: "observando", rotulo: t("Só registrar, sem barrar") },
    { valor: "desligada", rotulo: t("Desligada") },
  ];

  return (
    <form onSubmit={salvar} className="flex max-w-3xl flex-col gap-4" data-testid="form-sem-fonte">
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Sem fonte, não afirma")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Antes de enviar, o sistema confere se a regra que a IA afirma (benefício, prazo, valor, documento) está no material do escritório e se o que ela diz que o cliente falou ele falou mesmo. Sem fonte, a IA reescreve a partir do material ou diz que vai confirmar com a equipe. Uma chamada de modelo barato só nas mensagens que afirmam algo.",
            )}
          </p>
        </div>
        <fieldset className="space-y-2">
          <Label className="block">{t("Quando a afirmação não tem fonte")}</Label>
          {opcoes.map((o) => (
            <label key={o.valor} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="sem-fonte-estado"
                value={o.valor}
                data-testid={`sem-fonte-${o.valor}`}
                checked={estado === o.valor}
                disabled={isPending}
                onChange={() => setEstado(o.valor)}
              />
              {o.rotulo}
            </label>
          ))}
        </fieldset>
      </Card>
      <div className="flex gap-2">
        <Button type="submit" disabled={estado === salvo || isPending} data-testid="sem-fonte-salvar">
          {isPending ? t("Salvando...") : t("Salvar")}
        </Button>
      </div>
    </form>
  );
}
