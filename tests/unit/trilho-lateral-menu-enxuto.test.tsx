import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PC-013 — o trilho lateral recolhido, que abre por cima com o mouse e mostra o
 * menu enxuto.
 *
 *  - MENU ENXUTO: os destinos do dia a dia, na ordem, e nenhum que o menu
 *    completo esconderia (a régua é a mesma: `destinosDaInterface`).
 *  - TRILHO: nasce fechado (só ícones); o mouse abre DEPOIS de uma espera curta
 *    (quem só atravessa a barra não a abre) e sair fecha; o foco do teclado abre
 *    na hora.
 *  - "Menu completo" grava a barra aberta (`toggleSidebar(true)`), o mesmo
 *    cookie de "Fixar o menu aberto".
 */

import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

const authRef: { user: Pick<AuthUser, "is_platform_admin">; activeOrg: ActiveOrg | null } = {
  user: { is_platform_admin: false },
  activeOrg: null,
};

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => authRef,
  usePermission: () => false,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/app/inbox" }));
vi.mock("@/components/connections/ConnectionHealthDot", () => ({ ConnectionHealthDot: () => null }));
vi.mock("@/components/shell/ContadorDeCasos", () => ({ ContadorDeCasos: () => null }));
vi.mock("@/components/shell/ContadorDaFila", () => ({ ContadorDaFila: () => null }));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({ toggleSidebar: vi.fn() }));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));

import { Sidebar } from "@/components/shell/Sidebar";
import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";
import { menuEnxuto } from "@/lib/navigation/menu-enxuto";

function comoPapel(role: ActiveOrg["role"]) {
  authRef.user = { is_platform_admin: false };
  authRef.activeOrg = { orgId: "org-1", name: "Org", role } as ActiveOrg;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(toggleSidebar).mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("menu enxuto", () => {
  it("admin: os destinos do dia a dia, nesta ordem", () => {
    expect(menuEnxuto(false, "admin").map((i) => i.href)).toEqual([
      "/app/inbox",
      "/app/kanban",
      "/app/agenda",
      "/app/contacts",
      "/app/tasks",
      "/app/ai/cases",
      "/app/ai",
      "/app/dados",
    ]);
  });

  it("nunca mostra destino que o papel não alcança", () => {
    const doViewer = menuEnxuto(false, "viewer").map((i) => i.href);
    const doAdmin = new Set(menuEnxuto(false, "admin").map((i) => i.href));
    for (const href of doViewer) expect(doAdmin.has(href)).toBe(true);
    // Casos é `agent`+ no catálogo.
    expect(doViewer).not.toContain("/app/ai/cases");
  });

  it("sem papel e sem ser dono da instalação, não mostra nada", () => {
    expect(menuEnxuto(false, null)).toEqual([]);
  });
});

describe("trilho lateral", () => {
  it("nasce fechado, só com ícones e sem grupos", () => {
    comoPapel("admin");
    render(<Sidebar collapsed />);
    const barra = document.querySelector("[data-trilho-lateral] aside")!;
    expect(barra).toHaveAttribute("data-menu-aberto", "false");
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
    expect(screen.queryByText("Tarefas")).toBeNull();
    expect(document.querySelector('a[href="/app/tasks"]')).toHaveAttribute("title", "Tarefas");
    expect(document.querySelector('a[href="/app/webhooks"]')).toBeNull();
  });

  it("o mouse abre depois de uma espera curta, e sair fecha", () => {
    comoPapel("admin");
    render(<Sidebar collapsed />);
    const barra = document.querySelector("[data-trilho-lateral] aside")!;
    fireEvent.mouseEnter(barra);
    expect(barra).toHaveAttribute("data-menu-aberto", "false");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(barra).toHaveAttribute("data-menu-aberto", "true");
    expect(screen.getByText("Tarefas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fixar o menu aberto" })).toBeInTheDocument();

    fireEvent.mouseLeave(barra);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(barra).toHaveAttribute("data-menu-aberto", "false");
  });

  it("o mouse que só atravessa a barra não a abre", () => {
    comoPapel("admin");
    render(<Sidebar collapsed />);
    const barra = document.querySelector("[data-trilho-lateral] aside")!;
    fireEvent.mouseEnter(barra);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    fireEvent.mouseLeave(barra);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(barra).toHaveAttribute("data-menu-aberto", "false");
  });

  it("o foco do teclado abre na hora", () => {
    comoPapel("admin");
    render(<Sidebar collapsed />);
    const barra = document.querySelector("[data-trilho-lateral] aside")!;
    act(() => {
      (document.querySelector('a[href="/app/inbox"]') as HTMLElement).focus();
    });
    expect(barra).toHaveAttribute("data-menu-aberto", "true");
  });

  it("'Menu completo' grava a barra aberta", () => {
    comoPapel("admin");
    render(<Sidebar collapsed />);
    fireEvent.click(screen.getByRole("button", { name: "Menu completo" }));
    expect(vi.mocked(toggleSidebar)).toHaveBeenCalledWith(true);
  });

  it("fixada aberta, volta o menu de sempre, com os grupos", () => {
    comoPapel("admin");
    render(<Sidebar collapsed={false} />);
    expect(document.querySelector("[data-trilho-lateral]")).toBeNull();
    expect(screen.getAllByRole("heading").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Menu completo" })).toBeNull();
  });
});
