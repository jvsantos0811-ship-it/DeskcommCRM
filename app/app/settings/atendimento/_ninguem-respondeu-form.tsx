"use client";
/**
 * O aviso "Um lead escreveu e ninguém respondeu" e o alcance dos leads com
 * potencial (PM-025 §2 e §7). Porta de `settings.ninguem_respondeu` e
 * `settings.leitor` (funis e marcadores que desqualificam). Gravação em
 * `/api/v1/settings/alcance-do-leitor` e `/api/v1/settings/ninguem-respondeu`.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

export interface FunilDaTela {
  id: string;
  name: string;
  is_client_pipeline: boolean;
}

interface Inicial {
  ligado: boolean;
  ligadoEm: string | null;
  funis: string[] | null;
  marcadores: string[];
  horarioPadrao: boolean;
}

function listaDeMarcadores(texto: string): string[] {
  return [...new Set(texto.split(",").map((m) => m.trim()).filter((m) => m !== ""))];
}

export function NinguemRespondeuForm({ inicial, funis }: { inicial: Inicial; funis: FunilDaTela[] }) {
  const t = useT();
  const [ligado, setLigado] = useState(inicial.ligado);
  const [ligadoEm, setLigadoEm] = useState(inicial.ligadoEm);
  const [todos, setTodos] = useState(inicial.funis === null);
  const [escolhidos, setEscolhidos] = useState<string[]>(
    inicial.funis ?? funis.filter((f) => !f.is_client_pipeline).map((f) => f.id),
  );
  const [marcadores, setMarcadores] = useState(inicial.marcadores.join(", "));
  const [salvo, setSalvo] = useState({
    ligado: inicial.ligado,
    funis: inicial.funis,
    marcadores: inicial.marcadores.join(", "),
  });
  const [isPending, startTransition] = useTransition();

  const funisAtuais = todos ? null : escolhidos;
  const sujo =
    ligado !== salvo.ligado ||
    JSON.stringify(funisAtuais) !== JSON.stringify(salvo.funis) ||
    listaDeMarcadores(marcadores).join(",") !== listaDeMarcadores(salvo.marcadores).join(",");

  function alternarFunil(id: string, marcado: boolean) {
    setEscolhidos((atual) => (marcado ? [...new Set([...atual, id])] : atual.filter((x) => x !== id)));
  }

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    if (!todos && escolhidos.length === 0) {
      toast.error(t("Escolha ao menos um funil, ou use todos os funis de venda."));
      return;
    }
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/alcance-do-leitor", {
          funis: funisAtuais,
          marcadores_que_desqualificam: listaDeMarcadores(marcadores),
        });
        const r = await apiClient.patch<{ aviso: { ligado: boolean; ligado_em: string | null } }>(
          "/api/v1/settings/ninguem-respondeu",
          { ligado },
        );
        setLigadoEm(r.aviso.ligado_em);
        setSalvo({ ligado, funis: funisAtuais, marcadores });
        toast.success(t("Aviso e alcance salvos."));
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
      }
    });
  }

  const ligadoDesde =
    ligado && ligadoEm
      ? t("Ligado desde {quando}. Só contam as mensagens que chegaram depois disso.").replace(
          "{quando}",
          new Date(ligadoEm).toLocaleString(),
        )
      : null;
  const avisoDoHorario = inicial.horarioPadrao
    ? t("Horário da equipe não cadastrado: usando seg–sex, 8h–18h")
    : null;

  return (
    <form onSubmit={salvar} className="flex max-w-3xl flex-col gap-4" data-testid="form-ninguem-respondeu">
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Avisar quando ninguém responder")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "A Central avisa quando um lead escreve e nem a IA nem ninguém da equipe (inclusive pelo celular) responde em 1 hora de expediente. O aviso some sozinho quando alguém responde. Despedidas como \"obrigado\" não geram aviso.",
            )}
          </p>
          {avisoDoHorario ? (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="aviso-horario-padrao">
              {avisoDoHorario}
            </p>
          ) : null}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="ninguem-respondeu-ligado"
            checked={ligado}
            disabled={isPending}
            onChange={(e) => setLigado(e.target.checked)}
          />
          <span>
            {t("Ligar o aviso \"Um lead escreveu e ninguém respondeu\"")}
            {ligadoDesde ? <span className="block text-xs text-muted-foreground">{ligadoDesde}</span> : null}
          </span>
        </label>

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">{t("Quem conta como lead com potencial")}</legend>
          <p className="text-xs text-muted-foreground">
            {t(
              "Vale para este aviso e para os painéis de Dados: o lead de um funil escolhido, numa etapa que não é de ganho nem de perda, e sem nenhum dos marcadores abaixo.",
            )}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="alcance-todos-os-funis"
              checked={todos}
              disabled={isPending}
              onChange={(e) => setTodos(e.target.checked)}
            />
            <span>{t("Todos os funis de venda (menos o funil de clientes)")}</span>
          </label>
          {!todos ? (
            <div className="space-y-1 pl-6" data-testid="alcance-funis">
              {funis.map((f) => (
                <label key={f.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={escolhidos.includes(f.id)}
                    disabled={isPending}
                    onChange={(e) => alternarFunil(f.id, e.target.checked)}
                  />
                  <span>{f.name}</span>
                </label>
              ))}
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="alcance-marcadores">{t("Marcadores que tiram o lead da conta")}</Label>
            <Input
              id="alcance-marcadores"
              data-testid="alcance-marcadores"
              value={marcadores}
              placeholder={t("ex.: ja-cliente, nao-e-lead")}
              disabled={isPending}
              onChange={(e) => setMarcadores(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("Separe por vírgula. Lead perdido ou com marcador que volta a escrever também gera o aviso.")}
            </p>
          </div>
        </fieldset>
      </Card>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isPending || !sujo} data-testid="salvar-ninguem-respondeu">
          {isPending ? t("Salvando…") : t("Salvar aviso e alcance")}
        </Button>
        {sujo ? <span className="text-xs text-muted-foreground">{t("Há mudanças não salvas.")}</span> : null}
      </div>
    </form>
  );
}
