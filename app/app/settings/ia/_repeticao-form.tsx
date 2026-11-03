"use client";
/**
 * PC-018: a trava de repetição entre respostas e no follow-up — a porta de
 * `settings.conversa.repeticao`. A regra mora em
 * `lib/agent-engine/agent/repeticao-entre-respostas.ts`; a gravação, em
 * `/api/v1/settings/conversa`.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import type { AjustesDeRepeticaoGravados } from "@/lib/agent-engine/agent/repeticao-entre-respostas";

interface Props {
  inicial: AjustesDeRepeticaoGravados;
  padrao: AjustesDeRepeticaoGravados;
}

export function RepeticaoForm({ inicial, padrao }: Props) {
  const t = useT();
  const [valor, setValor] = useState(inicial);
  const [salvo, setSalvo] = useState(inicial);
  const [isPending, startTransition] = useTransition();
  const sujo = JSON.stringify(valor) !== JSON.stringify(salvo);

  function campo<K extends keyof AjustesDeRepeticaoGravados>(k: K, v: AjustesDeRepeticaoGravados[K]) {
    setValor((atual) => ({ ...atual, [k]: v }));
  }

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/conversa", { repeticao: valor });
        setSalvo(valor);
        toast.success(t("Regras de repetição salvas."));
      } catch {
        toast.error(t("Não consegui salvar."));
      }
    });
  }

  return (
    <form onSubmit={salvar} className="flex max-w-3xl flex-col gap-4" data-testid="form-repeticao">
      <Card className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">{t("Não repetir pergunta nem mensagem")}</h2>
            <p className="text-xs text-muted-foreground">
              {t(
                "Antes de enviar, a IA confere as últimas mensagens que já mandou para o cliente. Pergunta já respondida, ou feita duas vezes sem resposta, não sai de novo; mensagem quase igual também não. Quando o cliente pede para repetir, repete.",
              )}
            </p>
          </div>
          <Switch
            data-testid="repeticao-ligada"
            checked={valor.ligada}
            disabled={isPending}
            onCheckedChange={(v) => campo("ligada", v)}
            aria-label={t("Não repetir pergunta nem mensagem")}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="repeticao-mensagens" className="block">
              {t("Últimas mensagens conferidas")}
            </Label>
            <Input
              id="repeticao-mensagens"
              data-testid="repeticao-mensagens"
              type="number"
              min={3}
              max={30}
              value={valor.janela_mensagens}
              disabled={isPending || !valor.ligada}
              onChange={(e) => campo("janela_mensagens", Number(e.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="repeticao-horas" className="block">
              {t("Até quantas horas para trás")}
            </Label>
            <Input
              id="repeticao-horas"
              data-testid="repeticao-horas"
              type="number"
              min={6}
              max={168}
              value={valor.janela_horas}
              disabled={isPending || !valor.ligada}
              onChange={(e) => campo("janela_horas", Number(e.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="repeticao-limiar-texto" className="block">
              {t("Semelhança de mensagem (0,60 a 0,95)")}
            </Label>
            <Input
              id="repeticao-limiar-texto"
              data-testid="repeticao-limiar-texto"
              type="number"
              step={0.01}
              min={0.6}
              max={0.95}
              value={valor.limiar_texto}
              disabled={isPending || !valor.ligada}
              onChange={(e) => campo("limiar_texto", Number(e.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="repeticao-limiar-pergunta" className="block">
              {t("Semelhança de pergunta (0,70 a 0,95)")}
            </Label>
            <Input
              id="repeticao-limiar-pergunta"
              data-testid="repeticao-limiar-pergunta"
              type="number"
              step={0.01}
              min={0.7}
              max={0.95}
              value={valor.limiar_pergunta}
              disabled={isPending || !valor.ligada}
              onChange={(e) => campo("limiar_pergunta", Number(e.target.value))}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("Padrão")}: {padrao.janela_mensagens} {t("mensagens")} · {padrao.janela_horas} h · {padrao.limiar_texto} ·{" "}
          {padrao.limiar_pergunta}
        </p>
      </Card>
      <div className="flex gap-2">
        <Button type="submit" disabled={!sujo || isPending} data-testid="repeticao-salvar">
          {isPending ? t("Salvando...") : t("Salvar")}
        </Button>
        <Button type="button" variant="outline" disabled={isPending} onClick={() => setValor(padrao)}>
          {t("Voltar ao padrão")}
        </Button>
      </div>
    </form>
  );
}
