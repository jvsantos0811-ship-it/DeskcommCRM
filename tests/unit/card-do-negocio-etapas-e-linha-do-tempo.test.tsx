import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * PC-013 — o card do negócio com o nome de cada etapa na régua e a linha do
 * tempo num botão que abre o painel.
 *
 *  - RÉGUA: toda etapa leva o nome à vista (antes só a atual), o `aria-label`
 *    "N. Nome" de cada botão continua (as specs de tela clicam por ele) e
 *    clicar continua só ESCOLHENDO — mover pede o "Mover" da confirmação.
 *  - BOTÃO: diz quantos registros há e qual foi o último; sem isso, esconder a
 *    linha do tempo tiraria do card a resposta a "de onde veio este negócio?".
 *  - PAINEL: o filtro só oferece tipo que tem registro (um botão que leva a
 *    lista vazia é clique gasto) e "voltar" devolve a coluna.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));

import { EtapasDoNegocio } from "@/components/kanban/EtapasDoNegocio";
import { BotaoDaLinhaDoTempo, PainelDaLinhaDoTempo } from "@/components/kanban/LinhaDoTempoDoNegocio";
import type { TimelineItemView } from "@/lib/types/contacts";

afterEach(cleanup);

const etapas = [
  { id: "e1", name: "Recepção", is_won: false, is_lost: false },
  { id: "e2", name: "Triagem IA", is_won: false, is_lost: false },
  { id: "e3", name: "Proposta de honorários", is_won: false, is_lost: false },
];

function registro(id: string, type: string, quando: string, extra: Partial<TimelineItemView> = {}): TimelineItemView {
  return {
    id,
    organization_id: "org-1",
    lead_id: "lead-1",
    contact_id: null,
    source_module: "crm",
    source_id: null,
    type,
    payload: {},
    metadata: {},
    performed_at: quando,
    performed_by_user_id: null,
    actor_kind: "system",
    ...extra,
  } as TimelineItemView;
}

describe("régua de etapas com nome", () => {
  it("toda etapa mostra o nome, e o aria-label continua 'N. Nome'", () => {
    render(<EtapasDoNegocio etapas={etapas} etapaAtualId="e1" podeMover movendo={false} onMover={() => {}} />);
    const regua = screen.getByRole("list", { name: "Etapas do funil" });
    for (const nome of ["Recepção", "Triagem IA", "Proposta de honorários"]) {
      expect(regua).toHaveTextContent(nome);
    }
    expect(screen.getByRole("button", { name: "3. Proposta de honorários" })).toHaveAttribute(
      "title",
      "Mover para Proposta de honorários",
    );
  });

  it("clicar só escolhe; mover pede a confirmação", () => {
    const onMover = vi.fn();
    render(<EtapasDoNegocio etapas={etapas} etapaAtualId="e1" podeMover movendo={false} onMover={onMover} />);
    fireEvent.click(screen.getByRole("button", { name: "2. Triagem IA" }));
    expect(onMover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Mover" }));
    expect(onMover).toHaveBeenCalledWith("e2");
  });
});

describe("linha do tempo em botão + painel", () => {
  const itens = [
    registro("a1", "lead_created", "2026-10-30T14:20:00Z"),
    registro("a2", "stage_changed", "2026-11-03T12:12:00Z"),
    registro("a3", "lead_cooled", "2026-11-02T21:00:00Z"),
  ];

  it("o botão diz quantos registros há e qual foi o último", () => {
    const onAbrir = vi.fn();
    render(
      <BotaoDaLinhaDoTempo itens={itens} chegouAoVivo={new Set()} isLoading={false} isError={false} onAbrir={onAbrir} />,
    );
    const botao = screen.getByTestId("botao-linha-do-tempo");
    expect(botao).toHaveTextContent("Linha do tempo");
    expect(botao).toHaveTextContent("3");
    expect(botao).toHaveTextContent("Mudou de estágio");
    expect(botao).not.toHaveTextContent("agora");
    fireEvent.click(botao);
    expect(onAbrir).toHaveBeenCalledOnce();
  });

  it("registro que chega ao vivo ganha o selo 'agora'", () => {
    render(
      <BotaoDaLinhaDoTempo
        itens={itens}
        chegouAoVivo={new Set(["a2"])}
        isLoading={false}
        isError={false}
        onAbrir={() => {}}
      />,
    );
    expect(screen.getByTestId("botao-linha-do-tempo")).toHaveTextContent("agora");
  });

  it("sem registro, o botão diz que nada aconteceu ainda", () => {
    render(<BotaoDaLinhaDoTempo itens={[]} chegouAoVivo={new Set()} isLoading={false} isError={false} onAbrir={() => {}} />);
    expect(screen.getByTestId("botao-linha-do-tempo")).toHaveTextContent("Nada aconteceu com este negócio ainda.");
  });

  it("o painel filtra por tipo e só oferece filtro com registro", () => {
    const onFechar = vi.fn();
    render(
      <PainelDaLinhaDoTempo itens={itens} chegouAoVivo={new Set()} isLoading={false} isError={false} onFechar={onFechar} />,
    );
    const filtros = screen.getByRole("group", { name: "Filtrar a linha do tempo" });
    const nomes = Array.from(filtros.querySelectorAll("button")).map((b) => b.textContent);
    expect(nomes).toEqual(["Tudo", "Etapas", "Sistema"]);

    const painel = screen.getByTestId("painel-linha-do-tempo");
    expect(painel).toHaveTextContent("Negócio esfriou");
    fireEvent.click(screen.getByRole("button", { name: "Etapas" }));
    expect(screen.getByRole("button", { name: "Etapas" })).toHaveAttribute("aria-pressed", "true");
    expect(painel).not.toHaveTextContent("Negócio esfriou");
    expect(painel).toHaveTextContent("Mudou de estágio");

    fireEvent.click(screen.getByRole("button", { name: "Voltar para tarefas e contratos" }));
    expect(onFechar).toHaveBeenCalledOnce();
  });
});
