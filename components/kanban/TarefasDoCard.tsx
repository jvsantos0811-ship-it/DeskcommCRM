"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import type { ResumoDasTarefas, TarefaNoCard } from "@/lib/tarefas/tipos";
import { ListChecks, Warning } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * As tarefas em aberto do negócio, pelo nome, na face do card (03/11/2026,
 * pedido do João com o Venda Tech de referência): até duas — atrasadas
 * primeiro, depois o prazo mais próximo — e "+N" para o resto.
 *
 * Só aparece quando há tarefa em aberto (a rota do quadro nem manda o campo
 * sem ela), como a linha do valor: o card de quem não tem tarefa não cresce.
 * Vermelho só na atrasada — é o estado que pede ação agora (Lei C do card).
 *
 * Quando o quadro veio sem os nomes (`proximas` ausente), quem fala é o selo
 * de contagem do rodapé (`TarefasNoCard`), como antes.
 */
export function TarefasDoCard({ tarefas }: { tarefas?: ResumoDasTarefas }) {
  const t = useT();
  const idioma = useTagDeIdioma();
  const proximas = tarefas?.proximas ?? [];
  if (!tarefas || proximas.length === 0) return null;
  const resto = tarefas.abertas - proximas.length;

  return (
    <ul className="flex flex-col gap-0.5" data-testid="tarefas-do-card" aria-label={t("Tarefas em aberto")}>
      {proximas.map((tarefa) => (
        <li
          key={tarefa.id}
          data-testid="tarefa-do-card"
          data-atrasada={tarefa.atrasada ? "true" : "false"}
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-xs",
            tarefa.atrasada ? "font-medium text-destructive" : "text-text-muted",
          )}
          title={`${tarefa.titulo} · ${quando(tarefa, idioma, t)}`}
        >
          {tarefa.atrasada ? (
            <Warning size={12} aria-hidden className="shrink-0" />
          ) : (
            <ListChecks size={12} aria-hidden className="shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{tarefa.titulo}</span>
          <span className="shrink-0 tabular-nums">{quando(tarefa, idioma, t)}</span>
        </li>
      ))}
      {resto > 0 && (
        <li className="text-[11px] text-text-muted" data-testid="tarefas-do-card-resto">
          {`+${resto} ${resto === 1 ? t("tarefa") : t("tarefas")}`}
        </li>
      )}
    </ul>
  );
}

/** "atrasada", "hoje", "amanhã", a data curta, ou "sem prazo". */
export function quando(
  tarefa: Pick<TarefaNoCard, "prazo" | "atrasada">,
  idioma: string,
  t: (texto: string) => string,
  agora: Date = new Date(),
): string {
  if (tarefa.atrasada) return t("atrasada");
  if (!tarefa.prazo) return t("sem prazo");
  const prazo = new Date(tarefa.prazo);
  const dia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diferenca = Math.round((dia(prazo) - dia(agora)) / 86_400_000);
  if (diferenca === 0) return t("hoje");
  if (diferenca === 1) return t("amanhã");
  return new Intl.DateTimeFormat(idioma, { day: "2-digit", month: "2-digit" }).format(prazo);
}
