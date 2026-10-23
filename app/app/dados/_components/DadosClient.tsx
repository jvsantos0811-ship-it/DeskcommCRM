"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { painelModelo, type Painel, type Widget } from "@/lib/dados/widgets";
import { CaretDown, CaretUp, PencilSimple, Plus, Trash } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { EditorDeWidget } from "./EditorDeWidget";
import { usePaineis } from "./useDados";
import { WidgetCard } from "./WidgetCard";

/**
 * A tela de Dados: as abas dos painéis no topo, os gráficos do painel aberto
 * em grade (número ocupa uma coluna, gráfico ocupa a largura), e — para quem
 * pode montar — adicionar, editar, mover e tirar gráficos.
 *
 * Primeiro acesso sem painel nenhum: um botão cria o "Painel comercial" modelo,
 * em vez de deixar a pessoa diante de uma tela vazia sem saber por onde começar.
 */
export function DadosClient({ podeEditar }: { podeEditar: boolean }) {
  const t = useT();
  const { lista, criar, salvar, apagar } = usePaineis();
  const paineis = lista.data ?? [];
  const [abertoId, setAbertoId] = useState<string | null>(null);
  const aberto: Painel | undefined = paineis.find((p) => p.id === abertoId) ?? paineis[0];
  const [editando, setEditando] = useState<Widget | "novo" | null>(null);
  const [renomeando, setRenomeando] = useState(false);
  const [nome, setNome] = useState("");

  const gravar = (widgets: Widget[], extra?: { nome?: string }) => {
    if (!aberto) return;
    salvar.mutate({
      id: aberto.id,
      input: { nome: extra?.nome ?? aberto.nome, descricao: aberto.descricao ?? null, widgets },
    });
  };

  const mover = (i: number, d: -1 | 1) => {
    if (!aberto) return;
    const ws = [...aberto.widgets];
    const j = i + d;
    if (j < 0 || j >= ws.length) return;
    [ws[i], ws[j]] = [ws[j]!, ws[i]!];
    gravar(ws);
  };

  return (
    <div className="flex flex-col gap-6 p-6" data-dados>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Dados")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Monte painéis com os números que importam para você: o que medir, como agrupar e qual a meta.")}
          </p>
        </div>
        {podeEditar && (
          <Button
            variant="outline"
            disabled={criar.isPending}
            onClick={() =>
              criar.mutate(
                { nome: t("Novo painel"), descricao: null, widgets: [] },
                { onSuccess: (p) => setAbertoId(p.id) },
              )
            }
          >
            <Plus size={14} aria-hidden /> {t("Novo painel")}
          </Button>
        )}
      </header>

      {lista.isLoading && <p className="text-sm text-text-muted">{t("Carregando…")}</p>}

      {!lista.isLoading && paineis.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-10 text-center">
          <p className="text-sm text-text-muted">{t("Nenhum painel ainda.")}</p>
          {podeEditar ? (
            <Button
              disabled={criar.isPending}
              onClick={() => criar.mutate({ ...painelModelo(), nome: t("Painel comercial") }, { onSuccess: (p) => setAbertoId(p.id) })}
            >
              {t("Criar o painel comercial modelo")}
            </Button>
          ) : (
            <p className="text-xs text-text-muted">{t("Peça a um gestor para montar o primeiro painel.")}</p>
          )}
        </div>
      )}

      {paineis.length > 0 && (
        <nav className="flex flex-wrap gap-1.5" aria-label={t("Painéis")}>
          {paineis.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setAbertoId(p.id)}
              aria-current={aberto?.id === p.id ? "page" : undefined}
              className={cn(
                "h-9 rounded-md border px-3 text-sm",
                aberto?.id === p.id ? "border-primary bg-primary/10 text-text" : "border-border text-text-muted hover:text-text",
              )}
            >
              {p.nome}
            </button>
          ))}
        </nav>
      )}

      {aberto && (
        <section className="flex flex-col gap-4" aria-label={aberto.nome}>
          {podeEditar && (
            <div className="flex flex-wrap items-center gap-2">
              {renomeando ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (nome.trim()) gravar(aberto.widgets, { nome: nome.trim() });
                    setRenomeando(false);
                  }}
                >
                  <input
                    autoFocus
                    value={nome}
                    onChange={(e) => setNome(e.target.value)}
                    maxLength={80}
                    aria-label={t("Nome do painel")}
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm text-text"
                  />
                  <Button type="submit" size="sm">
                    {t("Salvar")}
                  </Button>
                </form>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setNome(aberto.nome);
                    setRenomeando(true);
                  }}
                >
                  <PencilSimple size={14} aria-hidden /> {t("Renomear")}
                </Button>
              )}
              <Button size="sm" onClick={() => setEditando("novo")} disabled={aberto.widgets.length >= 24}>
                <Plus size={14} aria-hidden /> {t("Adicionar gráfico")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto text-destructive"
                disabled={apagar.isPending}
                onClick={() =>
                  apagar.mutate(aberto.id, {
                    onSuccess: () => {
                      setAbertoId(null);
                      toast.success(t("Painel apagado. Nenhum dado foi apagado, só a montagem."));
                    },
                  })
                }
              >
                <Trash size={14} aria-hidden /> {t("Apagar painel")}
              </Button>
            </div>
          )}

          {aberto.widgets.length === 0 && (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">
              {podeEditar ? t("Este painel está vazio. Use “Adicionar gráfico”.") : t("Este painel está vazio.")}
            </p>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {aberto.widgets.map((w, i) => (
              <WidgetCard
                key={w.id}
                widget={w}
                acoes={
                  podeEditar ? (
                    <div className="flex shrink-0 gap-0.5">
                      <button
                        type="button"
                        aria-label={t("Mover para trás")}
                        onClick={() => mover(i, -1)}
                        disabled={i === 0}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted disabled:opacity-40"
                      >
                        <CaretUp size={14} aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label={t("Mover para frente")}
                        onClick={() => mover(i, 1)}
                        disabled={i === aberto.widgets.length - 1}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted disabled:opacity-40"
                      >
                        <CaretDown size={14} aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label={t("Editar gráfico")}
                        onClick={() => setEditando(w)}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted"
                      >
                        <PencilSimple size={14} aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label={t("Tirar gráfico")}
                        onClick={() => gravar(aberto.widgets.filter((x) => x.id !== w.id))}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted"
                      >
                        <Trash size={14} aria-hidden />
                      </button>
                    </div>
                  ) : null
                }
              />
            ))}
          </div>
        </section>
      )}

      {editando && aberto && (
        <EditorDeWidget
          inicial={editando === "novo" ? null : editando}
          onCancelar={() => setEditando(null)}
          onSalvar={(w) => {
            const existe = aberto.widgets.some((x) => x.id === w.id);
            gravar(existe ? aberto.widgets.map((x) => (x.id === w.id ? w : x)) : [...aberto.widgets, w]);
            setEditando(null);
          }}
        />
      )}
    </div>
  );
}
