import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * PC-024, item 1 — assumir pelo pop-up do negócio. Prova que o botão chama o
 * MESMO serviço do Inbox (`useClaimConversation`, com a trava otimista), que
 * tirar a conversa de outra pessoa é só de gerente e com confirmação, e que
 * depois de assumir aparecem "Com você" e o MESMO "Devolver" do Inbox.
 */

const estado = vi.hoisted(() => ({
  auth: { user: { id: "u1", support: null } as Record<string, unknown>, activeOrg: { role: "agent" } },
  claim: vi.fn(),
  retomar: vi.fn(),
  roteador: false,
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => estado.auth }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: estado.claim, isPending: false }),
}));
vi.mock("@/hooks/inbox/useResumeAiAttendance", () => ({
  useResumeAiAttendance: () => ({ mutate: estado.retomar, isPending: false }),
}));
vi.mock("@/hooks/inbox/useAgentesParaDevolver", () => ({
  useAgentesParaDevolver: () => ({
    data: { tem_roteador: estado.roteador, agentes: [{ id: "a1", nome: "Laura", intencao: null }] },
    isLoading: false,
  }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: () => ({ data: true }) }));
vi.mock("@/components/inbox/DevolverParaAgenteDialog", () => ({
  DevolverParaAgenteDialog: ({ open }: { open: boolean }) => (open ? <div>escolher o agente</div> : null),
}));

import { ComandoNoNegocio } from "./ComandoNoNegocio";

function conversa(extra: Record<string, unknown> = {}): ConversationWithContact {
  return {
    id: "conv-1",
    contact_id: "c1",
    status: "open",
    assigned_to_user_id: null,
    assigned_to_user_name: null,
    assignee_kind: "ai",
    bot_silenced_until: null,
    is_group: false,
    contacts: { id: "c1", force_human: false, is_blocked: false },
    ...extra,
  } as unknown as ConversationWithContact;
}

beforeEach(() => {
  estado.claim.mockReset();
  estado.retomar.mockReset();
  estado.roteador = false;
  estado.auth = { user: { id: "u1", support: null }, activeOrg: { role: "agent" } };
});

describe("assumir pelo pop-up do negócio", () => {
  it("sem dono: um clique assume pelo serviço do Inbox (expected_assignee nulo)", () => {
    render(<ComandoNoNegocio conversa={conversa()} />);
    fireEvent.click(screen.getByTestId("assumir-no-negocio"));
    expect(estado.claim).toHaveBeenCalledWith({ conversation_id: "conv-1", expected_assignee: null });
  });

  it("com outra pessoa: o atendente vê com quem está e não consegue assumir", () => {
    render(
      <ComandoNoNegocio
        conversa={conversa({ assigned_to_user_id: "u2", assigned_to_user_name: "Bruna", assignee_kind: "user" })}
      />,
    );
    expect(screen.getByTestId("conversa-com-outra-pessoa").textContent).toContain("Bruna");
    const botao = screen.getByTestId("assumir-no-negocio") as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    expect(botao.title).toContain("gerente");
  });

  it("com outra pessoa: o gerente assume depois de confirmar, com a trava no dono atual", () => {
    estado.auth = { user: { id: "u1", support: null }, activeOrg: { role: "manager" } };
    render(
      <ComandoNoNegocio
        conversa={conversa({ assigned_to_user_id: "u2", assigned_to_user_name: "Bruna", assignee_kind: "user" })}
      />,
    );
    fireEvent.click(screen.getByTestId("assumir-no-negocio"));
    expect(estado.claim).not.toHaveBeenCalled();
    expect(screen.getByText(/A conversa está com Bruna/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirmar-assumir-no-negocio"));
    expect(estado.claim).toHaveBeenCalledWith({ conversation_id: "conv-1", expected_assignee: "u2" });
  });

  it("comigo: mostra 'Com você' e devolve para a IA pela mesma rota", () => {
    render(
      <ComandoNoNegocio
        conversa={conversa({
          assigned_to_user_id: "u1",
          assignee_kind: "user",
          status: "claimed",
          bot_silenced_until: "infinity",
        })}
      />,
    );
    expect(screen.getByTestId("com-voce-no-negocio")).toBeTruthy();
    expect(screen.queryByTestId("assumir-no-negocio")).toBeNull();
    fireEvent.click(screen.getByTestId("devolver-no-negocio"));
    expect(estado.retomar).toHaveBeenCalledWith({ conversation_id: "conv-1" });
  });

  it("comigo, com roteador: devolver abre a escolha do agente (PC-014)", () => {
    estado.roteador = true;
    render(
      <ComandoNoNegocio
        conversa={conversa({ assigned_to_user_id: "u1", assignee_kind: "user", bot_silenced_until: "infinity" })}
      />,
    );
    fireEvent.click(screen.getByTestId("devolver-no-negocio"));
    expect(estado.retomar).not.toHaveBeenCalled();
    expect(screen.getByText("escolher o agente")).toBeTruthy();
  });

  it("leitor (viewer) e suporte somente leitura não veem os botões", () => {
    estado.auth = { user: { id: "u1", support: null }, activeOrg: { role: "viewer" } };
    const { unmount } = render(<ComandoNoNegocio conversa={conversa()} />);
    expect(screen.queryByTestId("comando-no-negocio")).toBeNull();
    unmount();
    estado.auth = {
      user: { id: "u1", support: { access_mode: "support_readonly" }, is_platform_admin: true },
      activeOrg: { role: "admin" },
    };
    render(<ComandoNoNegocio conversa={conversa()} />);
    expect(screen.queryByTestId("comando-no-negocio")).toBeNull();
  });
});
