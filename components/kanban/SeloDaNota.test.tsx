import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { calcularQualidade, type SinaisDoLead } from "@/lib/dados/qualidade";
import type { LeadFilters } from "@/lib/kanban/filters";
import type { Lead } from "@/lib/types/leads";
import { FiltrosDaQualidade } from "./FiltrosDaQualidade";
import { SeloDaNota } from "./SeloDaNota";

/**
 * O selo "A · 86" e o porquê (v3 §2), e os chips da qualidade (v3 §3), na tela.
 * A prova pelo navegador de verdade está em `tests/e2e/qualidade-do-lead.spec.ts`.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

afterEach(cleanup);

const AGORA = new Date("2026-11-05T13:00:00.000Z");
const horasAtras = (h: number) => new Date(AGORA.getTime() - h * 3_600_000).toISOString();
const joana: SinaisDoLead = {
  status: "open",
  criadoEm: horasAtras(50),
  etapaDesde: horasAtras(10),
  chanceDaEtapa: 70,
  prazoDaEtapaHoras: null,
  chanceDaIa: null,
  faixaDaIa: null,
  mensagensDaEmpresa: 1,
  respostas: 4,
  ultimaRespostaEm: horasAtras(30),
  duplicadoDeDesqualificado: false,
  interesse: "Auxílio-acidente",
};

describe("o selo da nota", () => {
  it("mostra nível e nota, com rótulo acessível, e o porquê com as parcelas da prévia", () => {
    const fora = vi.fn();
    render(
      <div onClick={fora}>
        <SeloDaNota qualidade={calcularQualidade(joana, AGORA)} nome="Joana P." rotuloDoInteresse="Benefício" />
      </div>,
    );
    const selo = screen.getByTestId("selo-da-nota");
    expect(selo.textContent).toBe("A · 86");
    expect(selo.getAttribute("aria-label")).toBe("Nota de qualidade 86, nível A. Ver o porquê.");
    expect(selo.style.backgroundColor).toBe("rgb(227, 243, 234)");

    fireEvent.click(selo);
    // O clique não chega ao card (que abriria o negócio).
    expect(fora).not.toHaveBeenCalled();
    const porque = screen.getByTestId("porque-da-nota");
    expect(porque.textContent).toContain("Por que Joana P. tem nota 86");
    const linhas = [...porque.querySelectorAll("li")].map((li) => li.textContent);
    expect(linhas).toEqual([
      "Chance de fechar 70% × 0,4 · pela etapa+28",
      "Etapa com chance de 50% ou mais+15",
      "Benefício identificado+15",
      "Respondeu 3 vezes ou mais+20",
      "Respondeu nas últimas 72 h+8",
    ]);
    expect(porque.textContent).toContain("86 de 100");
    expect(porque.textContent).toContain("Nível A (65 ou mais): Fechar agora.");
  });

  it("Enter pelo teclado alterna o porquê (clique de teclado tem detail 0)", () => {
    render(<SeloDaNota qualidade={calcularQualidade(joana, AGORA)} nome="Joana P." />);
    const selo = screen.getByTestId("selo-da-nota");
    fireEvent.click(selo, { detail: 0 });
    expect(screen.queryByTestId("porque-da-nota")).not.toBeNull();
    fireEvent.click(selo, { detail: 0 });
    expect(screen.queryByTestId("porque-da-nota")).toBeNull();
  });

  it("ganho mostra 'Ganho · 100' e o porquê fixo", () => {
    render(<SeloDaNota qualidade={calcularQualidade({ ...joana, status: "won" }, AGORA)} nome="X" />);
    const selo = screen.getByTestId("selo-da-nota");
    expect(selo.textContent).toBe("Ganho · 100");
    fireEvent.click(selo);
    expect(screen.getByTestId("porque-da-nota").textContent).toContain("Negócio ganho: a nota é 100");
  });
});

describe("os chips da qualidade", () => {
  const leads = [
    { id: "a", qualidade: calcularQualidade(joana, AGORA) },
    { id: "b", qualidade: calcularQualidade({ ...joana, interesse: "BPC/LOAS" }, AGORA) },
  ] as unknown as Lead[];

  it("desligados mostram '+', e o interesse usa o nome do funil", () => {
    render(<FiltrosDaQualidade filters={{}} onChange={() => {}} leads={leads} rotuloDoInteresse="Benefício" />);
    expect(screen.getByTestId("filtro-qualidade-nivel").textContent).toBe("+ Nível");
    expect(screen.getByTestId("filtro-qualidade-temperatura").textContent).toBe("+ Temperatura");
    expect(screen.getByTestId("filtro-qualidade-servico").textContent).toBe("+ Benefício");
    expect(screen.getByTestId("filtro-qualidade-situacao").textContent).toBe("+ Situação");
    expect(screen.queryByTestId("filtro-qualidade-nivel-tirar")).toBeNull();
  });

  it("ligado mostra o valor, e o × tira só aquele filtro", () => {
    const onChange = vi.fn<(f: LeadFilters) => void>();
    render(
      <FiltrosDaQualidade
        filters={{ nivel: "A", situacao: "parado", owner: "unassigned" }}
        onChange={onChange}
        leads={leads}
      />,
    );
    const chip = screen.getByTestId("filtro-qualidade-nivel");
    expect(chip.getAttribute("data-ligado")).toBe("sim");
    expect(screen.getByTestId("filtro-qualidade-nivel-abrir").textContent).toBe("Nível: A");
    expect(screen.getByTestId("filtro-qualidade-situacao-abrir").textContent).toBe("Situação: Parado além do prazo da etapa");
    expect(screen.getByTestId("filtro-qualidade-nivel-tirar").getAttribute("aria-label")).toBe("Tirar filtro: Nível");
    fireEvent.click(screen.getByTestId("filtro-qualidade-nivel-tirar"));
    expect(onChange).toHaveBeenCalledWith({ nivel: undefined, situacao: "parado", owner: "unassigned" });
  });
});
