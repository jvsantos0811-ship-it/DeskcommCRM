"use client";
/**
 * Horário da equipe (PC-002b, item 4): a porta de `settings.horario_da_equipe`.
 * Com ele, a IA pode dizer ao cliente QUANDO a equipe assume ("ainda hoje",
 * "a partir das 8h de amanhã") sem a trava de promessa barrar — desde que bata
 * com este horário. Gravação em `/api/v1/settings/horario-da-equipe`.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

interface Janela {
  dow: number;
  start: string;
  end: string;
}
export interface HorarioInicial {
  timezone: string;
  windows: Janela[];
}

interface Dia {
  ligado: boolean;
  inicio: string;
  fim: string;
}

function diasDe(h: HorarioInicial | null): Dia[] {
  return Array.from({ length: 7 }, (_, dow) => {
    const w = h?.windows.find((x) => x.dow === dow);
    return w ? { ligado: true, inicio: w.start, fim: w.end } : { ligado: false, inicio: "08:00", fim: "18:00" };
  });
}

export function HorarioDaEquipeForm({ inicial }: { inicial: HorarioInicial | null }) {
  const t = useT();
  const [fuso, setFuso] = useState(inicial?.timezone ?? "America/Sao_Paulo");
  const [dias, setDias] = useState<Dia[]>(() => diasDe(inicial));
  const [isPending, startTransition] = useTransition();
  const nomes = [t("Domingo"), t("Segunda"), t("Terça"), t("Quarta"), t("Quinta"), t("Sexta"), t("Sábado")];

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    const windows = dias
      .map((d, dow) => ({ dow, start: d.inicio, end: d.fim, ligado: d.ligado }))
      .filter((d) => d.ligado)
      .map(({ dow, start, end }) => ({ dow, start, end }));
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/horario-da-equipe", { horario: { timezone: fuso, windows } });
        toast.success(t("Horário da equipe salvo."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  return (
    <form onSubmit={salvar} className="flex max-w-3xl flex-col gap-4" data-testid="form-horario-da-equipe">
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Horário da equipe")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Quando a equipe atende. Com ele, a IA pode dizer ao cliente quando alguém assume (por exemplo, “ainda hoje” ou “a partir das 8h de amanhã”) e a trava só deixa passar o que bate com este horário. Sem nenhum dia marcado, a IA não promete horário.",
            )}
          </p>
        </div>
        <div className="max-w-sm space-y-1">
          <Label htmlFor="horario-fuso">{t("Fuso horário")}</Label>
          <Input id="horario-fuso" value={fuso} onChange={(e) => setFuso(e.target.value)} disabled={isPending} />
        </div>
        <div className="space-y-2">
          {dias.map((d, dow) => (
            <div key={dow} className="flex flex-wrap items-center gap-3" data-testid={`horario-dia-${dow}`}>
              <label className="flex w-28 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={d.ligado}
                  disabled={isPending}
                  onChange={(e) =>
                    setDias((atual) => atual.map((x, i) => (i === dow ? { ...x, ligado: e.target.checked } : x)))
                  }
                  className="h-4 w-4 accent-primary"
                />
                {nomes[dow]}
              </label>
              <Input
                type="time"
                className="w-32"
                aria-label={`${t("Início")} ${nomes[dow]}`}
                value={d.inicio}
                disabled={isPending || !d.ligado}
                onChange={(e) => setDias((atual) => atual.map((x, i) => (i === dow ? { ...x, inicio: e.target.value } : x)))}
              />
              <span className="text-xs text-muted-foreground">{t("até")}</span>
              <Input
                type="time"
                className="w-32"
                aria-label={`${t("Fim")} ${nomes[dow]}`}
                value={d.fim}
                disabled={isPending || !d.ligado}
                onChange={(e) => setDias((atual) => atual.map((x, i) => (i === dow ? { ...x, fim: e.target.value } : x)))}
              />
            </div>
          ))}
        </div>
      </Card>
      <div>
        <Button type="submit" disabled={isPending}>
          {isPending ? t("Salvando…") : t("Salvar horário da equipe")}
        </Button>
      </div>
    </form>
  );
}
