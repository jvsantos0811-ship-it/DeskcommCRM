import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PC-013 — o funil com abas no topo e o card mais limpo.
 *
 * O que estes casos vigiam (e por quê):
 *
 *  - ETIQUETAS: até duas à vista e um "+N" — a linha tem altura fixa, então o
 *    card não cresce com dado; sem etiqueta a linha nem existe.
 *  - LIGAR: o `tel:` só leva dígitos e o "+" — um telefone com espaço, traço ou
 *    parêntese viraria um link que o discador não entende.
 *  - ABAS: cada aba segue a régua do menu (papel e telas da empresa). "Ligações"
 *    só existe para gerente com número de telefonia ATIVO — e quem não pode ver
 *    a aba não dispara a consulta (a requisição sairia do navegador de todo
 *    atendente para responder 403).
 *  - A aba "Funil" volta ao último quadro aberto, e só aceita caminho de quadro:
 *    o valor vem do navegador, e um link montado a partir de texto arbitrário
 *    seria uma porta aberta.
 */

const ROLE = vi.hoisted(() => ({ atual: "manager" as string }));
const apiGet = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app/agenda" }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...resto }: { children: ReactNode; href: string }) => (
    <a href={href} {...resto}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u-1", is_platform_admin: false }),
  useActiveOrg: () => ({ orgId: "org-1", role: ROLE.atual }),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: apiGet } }));

import { AbasDoFunil, CHAVE_ULTIMO_FUNIL } from "@/components/kanban/AbasDoFunil";
import { hrefDeLigar } from "@/components/kanban/AcoesRapidasDoCard";
import { EtiquetasNoCard, corDaEtiqueta } from "@/components/kanban/EtiquetasNoCard";

function comConsulta(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  ROLE.atual = "manager";
  apiGet.mockReset();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("etiquetas no card", () => {
  it("mostra até duas e um +N com o resto no title", () => {
    render(<EtiquetasNoCard tags={["auxílio-acidente", "INSS negado", "laudo ok", "urgente"]} />);
    const lista = screen.getByTestId("etiquetas-no-card");
    expect(lista).toHaveTextContent("auxílio-acidente");
    expect(lista).toHaveTextContent("INSS negado");
    expect(lista).not.toHaveTextContent("laudo ok");
    const mais = screen.getByText("+2");
    expect(mais).toHaveAttribute("title", "laudo ok, urgente");
  });

  it("sem etiqueta, a linha não existe", () => {
    const { container } = render(<EtiquetasNoCard tags={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("etiqueta repetida ou em branco não ocupa lugar", () => {
    render(<EtiquetasNoCard tags={["a", " a ", "", "b"]} />);
    expect(screen.queryByText(/^\+/)).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("a cor do ponto é estável pelo nome", () => {
    expect(corDaEtiqueta("INSS negado")).toBe(corDaEtiqueta("INSS negado"));
    expect(corDaEtiqueta("INSS negado")).toBe(corDaEtiqueta("inss NEGADO"));
  });
});

describe("ligar pelo card", () => {
  it("o tel: só leva dígitos e o + inicial", () => {
    expect(hrefDeLigar("+55 (31) 99123-4567")).toBe("tel:+5531991234567");
    expect(hrefDeLigar("31 99123-4567")).toBe("tel:31991234567");
  });

  it("sem telefone ou com número curto demais, não há botão", () => {
    expect(hrefDeLigar(null)).toBeNull();
    expect(hrefDeLigar(undefined)).toBeNull();
    expect(hrefDeLigar("123")).toBeNull();
  });
});

describe("abas do funil", () => {
  it("gerente com número de telefonia ativo vê as quatro abas, na ordem", async () => {
    apiGet.mockResolvedValue({ data: [{ is_active: true }] });
    comConsulta(<AbasDoFunil />);
    await waitFor(() => expect(screen.getByTestId("aba-do-funil-ligacoes")).toBeInTheDocument());
    const nomes = screen.getAllByRole("link").map((l) => l.textContent);
    expect(nomes).toEqual(["Funil", "Agenda", "Ligações", "Recuperação"]);
    expect(apiGet).toHaveBeenCalledWith("/api/v1/phone-numbers", { semDesvioDeSuspensao: true });
  });

  it("a aba da tela atual é a marcada", () => {
    apiGet.mockResolvedValue({ data: [] });
    comConsulta(<AbasDoFunil />);
    expect(screen.getByTestId("aba-do-funil-agenda")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("aba-do-funil-funil")).not.toHaveAttribute("aria-current");
  });

  it("sem número ATIVO, não há aba de Ligações", async () => {
    apiGet.mockResolvedValue({ data: [{ is_active: false }] });
    comConsulta(<AbasDoFunil />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(screen.queryByTestId("aba-do-funil-ligacoes")).toBeNull();
  });

  it("atendente não vê Ligações e nem dispara a consulta", () => {
    ROLE.atual = "agent";
    comConsulta(<AbasDoFunil />);
    expect(screen.queryByTestId("aba-do-funil-ligacoes")).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
    expect(screen.getByTestId("aba-do-funil-funil")).toBeInTheDocument();
  });

  it("Funil volta ao último quadro aberto — e só aceita caminho de quadro", () => {
    apiGet.mockResolvedValue({ data: [] });
    const id = "6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";
    window.localStorage.setItem(CHAVE_ULTIMO_FUNIL, `/app/pipelines/${id}`);
    const { unmount } = comConsulta(<AbasDoFunil />);
    expect(screen.getByTestId("aba-do-funil-funil")).toHaveAttribute("href", `/app/pipelines/${id}`);
    unmount();

    window.localStorage.setItem(CHAVE_ULTIMO_FUNIL, "https://exemplo.com/fora");
    comConsulta(<AbasDoFunil />);
    expect(screen.getByTestId("aba-do-funil-funil")).toHaveAttribute("href", "/app/kanban");
  });
});
