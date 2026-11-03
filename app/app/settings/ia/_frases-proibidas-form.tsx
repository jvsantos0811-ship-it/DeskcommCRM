"use client";
/**
 * PC-022: as frases proibidas da organização — a porta de
 * `settings.conversa.frases_proibidas`. A regra mora em
 * `lib/agent-engine/agent/frases-proibidas.ts`; a gravação, em
 * `/api/v1/settings/conversa` (só o admin muda a lista). Embaixo, quantas vezes
 * cada frase apareceu por semana (`frases_proibidas_na_semana`).
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

export interface ContagemDaFraseNaTela {
  frase: string;
  semana: string;
  barradas: number;
  removidas: number;
  enviadas: number;
}

interface Props {
  inicial: string[];
  padrao: string[];
  contagem: ContagemDaFraseNaTela[];
  podeEditar: boolean;
}

const paraTexto = (lista: string[]) => lista.join("\n");
const paraLista = (texto: string) =>
  texto
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 2);

function dataCurta(iso: string): string {
  const [a, m, d] = iso.split("-");
  return a && m && d ? `${d}/${m}` : iso;
}

export function FrasesProibidasForm({ inicial, padrao, contagem, podeEditar }: Props) {
  const t = useT();
  const [texto, setTexto] = useState(paraTexto(inicial));
  const [salvo, setSalvo] = useState(paraTexto(inicial));
  const [isPending, startTransition] = useTransition();
  const sujo = texto.trim() !== salvo.trim();

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    const lista = paraLista(texto);
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/conversa", { frases_proibidas: { lista } });
        setTexto(paraTexto(lista));
        setSalvo(paraTexto(lista));
        toast.success(t("Frases proibidas salvas."));
      } catch {
        toast.error(t("Não consegui salvar."));
      }
    });
  }

  const semanas = [...new Set(contagem.map((c) => c.semana))].sort().reverse().slice(0, 4);
  const frases = [...new Set(contagem.map((c) => c.frase))];
  const total = (frase: string, semana: string) => {
    const c = contagem.find((x) => x.frase === frase && x.semana === semana);
    return c ? c.barradas + c.removidas + c.enviadas : 0;
  };
  const tituloSemana = t("Semana de");

  return (
    <form onSubmit={salvar} className="flex max-w-3xl flex-col gap-4" data-testid="form-frases-proibidas">
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Frases proibidas")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Antes de enviar, o sistema procura estas frases na mensagem da IA, sem diferença de maiúscula, acento ou pontuação (\"sem pressa\" pega \"sem pressa nenhuma\"). Achou: a IA reescreve sem ela. Se ainda ficar e for só uma muleta no começo (\"Perfeito!\"), a frase sai; senão a mensagem sai e fica contada abaixo.",
            )}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="frases-proibidas-lista" className="block">
            {t("Uma frase por linha")}
          </Label>
          <Textarea
            id="frases-proibidas-lista"
            data-testid="frases-proibidas-lista"
            rows={10}
            value={texto}
            disabled={isPending || !podeEditar}
            onChange={(e) => setTexto(e.target.value)}
          />
          {!podeEditar ? (
            <p className="text-xs text-muted-foreground">{t("Só o administrador da empresa muda esta lista.")}</p>
          ) : null}
        </div>
        {podeEditar ? (
          <div className="flex gap-2">
            <Button type="submit" disabled={!sujo || isPending} data-testid="frases-proibidas-salvar">
              {isPending ? t("Salvando...") : t("Salvar")}
            </Button>
            <Button type="button" variant="outline" disabled={isPending} onClick={() => setTexto(paraTexto(padrao))}>
              {t("Voltar ao padrão")}
            </Button>
          </div>
        ) : null}
      </Card>
      <Card className="space-y-2 p-4" data-testid="frases-proibidas-contagem">
        <h2 className="text-sm font-semibold">{t("Quantas vezes apareceram")}</h2>
        {frases.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("Nenhuma frase proibida apareceu nas últimas 4 semanas.")}</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                <th className="py-1 font-medium">{t("Frase")}</th>
                {semanas.map((s) => (
                  <th key={s} className="py-1 font-medium">
                    {tituloSemana} {dataCurta(s)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {frases.map((f) => (
                <tr key={f} className="border-t border-border">
                  <td className="py-1">{f}</td>
                  {semanas.map((s) => (
                    <td key={s} className="py-1 tabular-nums">
                      {total(f, s)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </form>
  );
}
