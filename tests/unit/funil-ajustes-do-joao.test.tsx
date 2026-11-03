import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { quando, TarefasDoCard } from "@/components/kanban/TarefasDoCard";
import { anexarTarefasAosNegocios } from "@/lib/kanban/tarefas-no-quadro";
import { filtroLigado } from "@/lib/kanban/filters";
import { proximasTarefas } from "@/lib/tarefas/tipos";
import type { Lead } from "@/lib/types/leads";

/**
 * Ajustes do funil pedidos pelo João em 03/11/2026, com o Venda Tech de
 * referência:
 *
 *  - TAREFAS NO CARD: até duas em aberto, pelo nome, atrasadas primeiro (a mais
 *    antiga), depois o prazo mais próximo, as sem prazo por último; "+N" para o
 *    resto; e o card sem tarefa não ganha linha nenhuma.
 *  - BARRA DE FILTROS: recolhe sem o mouse — EXCETO com um filtro ligado, senão
 *    o quadro mostraria menos negócios sem dizer por quê.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));

afterEach(cleanup);

const AGORA = new Date("2026-11-03T15:00:00-03:00");
const tarefa = (id: string, title: string, due_date: string | null, status = "pending" as const) => ({
  id,
  title,
  due_date,
  status,
});

describe("as próximas tarefas do card", () => {
  it("atrasadas primeiro (a mais antiga), depois o prazo mais próximo; sem prazo e encerradas por último/fora", () => {
    const r = proximasTarefas(
      [
        tarefa("sem", "Sem prazo", null),
        tarefa("sex", "Ligar na sexta", "2026-11-06T12:00:00-03:00"),
        tarefa("ontem", "Pedir laudo", "2026-11-02T12:00:00-03:00"),
        tarefa("semana", "Cobrar documento", "2026-10-27T12:00:00-03:00"),
        { ...tarefa("feita", "Já feita", "2026-10-01T12:00:00-03:00"), status: "done" as const },
        tarefa("amanha", "Retorno", "2026-11-04T10:00:00-03:00"),
      ],
      AGORA,
      10,
    );
    expect(r.map((t) => t.id)).toEqual(["semana", "ontem", "amanha", "sex", "sem"]);
    expect(r.filter((t) => t.atrasada).map((t) => t.id)).toEqual(["semana", "ontem"]);
  });

  it("o quadro anexa as duas primeiras pelo nome e mantém a contagem", () => {
    const lead = { id: "l1" } as Lead;
    const [comTarefas] = anexarTarefasAosNegocios(
      [lead],
      [
        { ...tarefa("a", "Pedir laudo", "2026-11-02T12:00:00-03:00"), lead_id: "l1" },
        { ...tarefa("b", "Retorno", "2026-11-04T10:00:00-03:00"), lead_id: "l1" },
        { ...tarefa("c", "Ligar na sexta", "2026-11-06T12:00:00-03:00"), lead_id: "l1" },
      ],
      AGORA,
    );
    expect(comTarefas!.tarefas).toEqual({
      abertas: 3,
      atrasadas: 1,
      proximas: [
        { id: "a", titulo: "Pedir laudo", prazo: "2026-11-02T12:00:00-03:00", atrasada: true },
        { id: "b", titulo: "Retorno", prazo: "2026-11-04T10:00:00-03:00", atrasada: false },
      ],
    });
  });

  it("linha sem nome (leitura antiga) fica só no selo de contagem", () => {
    const [l] = anexarTarefasAosNegocios(
      [{ id: "l1" } as Lead],
      [{ lead_id: "l1", due_date: null, status: "pending" }],
      AGORA,
    );
    expect(l!.tarefas).toEqual({ abertas: 1, atrasadas: 0 });
  });

  it("o card mostra as duas, a atrasada em vermelho, e +N do resto", () => {
    render(
      <TarefasDoCard
        tarefas={{
          abertas: 3,
          atrasadas: 1,
          proximas: [
            { id: "a", titulo: "Pedir laudo", prazo: "2026-11-02T12:00:00-03:00", atrasada: true },
            { id: "b", titulo: "Retorno", prazo: null, atrasada: false },
          ],
        }}
      />,
    );
    const linhas = screen.getAllByTestId("tarefa-do-card");
    expect(linhas.map((l) => l.textContent)).toEqual(["Pedir laudoatrasada", "Retornosem prazo"]);
    expect(linhas[0]).toHaveAttribute("data-atrasada", "true");
    expect(linhas[0]!.className).toContain("text-destructive");
    expect(screen.getByTestId("tarefas-do-card-resto")).toHaveTextContent("+1 tarefa");
  });

  it("sem tarefa em aberto, nada", () => {
    const { container } = render(<TarefasDoCard tarefas={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("o prazo em palavras: hoje, amanhã, data curta", () => {
    const t = (s: string) => s;
    expect(quando({ prazo: "2026-11-03T20:00:00-03:00", atrasada: false }, "pt-BR", t, AGORA)).toBe("hoje");
    expect(quando({ prazo: "2026-11-04T09:00:00-03:00", atrasada: false }, "pt-BR", t, AGORA)).toBe("amanhã");
    expect(quando({ prazo: "2026-11-12T09:00:00-03:00", atrasada: false }, "pt-BR", t, AGORA)).toBe("12/11");
  });
});

describe("a barra de filtros recolhe só sem filtro ligado", () => {
  it("nenhum filtro: recolhe", () => {
    expect(filtroLigado({})).toBe(false);
    expect(filtroLigado({ owner: "any", status: "all", tag: [], search: "  " })).toBe(false);
  });
  it("qualquer filtro ligado: fica à vista", () => {
    for (const f of [
      { owner: "unassigned" },
      { status: "won" as const },
      { tag: ["cliente"] },
      { search: "maria" },
      { overdueOnly: true },
      { lostReason: "preço" },
      { valueCentsMin: 0 },
    ]) {
      expect(filtroLigado(f), JSON.stringify(f)).toBe(true);
    }
  });
});
