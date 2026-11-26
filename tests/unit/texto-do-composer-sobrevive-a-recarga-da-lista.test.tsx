import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O TEXTO QUE ESTÁ SENDO DIGITADO SOBREVIVE À RECARGA DA LISTA.
 *
 * Relato de cliente (25/11/2026): "mando a mensagem e, quando atualiza, apaga o
 * que eu estava escrevendo".
 *
 * O envio muda a conversa e a recarga da lista que vem atrás pode deixá-la de
 * fora (na Fila ela desce na ordem da espera e cai para além das 50 da página;
 * na aba IA o envio humano a tira da aba; com "Só não lidas" ela deixa de ser
 * não lida). Enquanto a busca por id não volta, a conversa aberta virava `null`
 * por um render, o painel trocava pelo "Selecione uma conversa" e o composer
 * DESMONTAVA — o texto mora no estado dele.
 *
 * Aqui o composer é uma sonda com estado próprio, igual ao real nesse ponto: se
 * ele desmontar, o texto some e o caso reprova. A busca por id fica no ar para
 * sempre, que é o pior caso da janela.
 */

const { ORG, CONVERSA, CONVERSA_ROW, estado } = vi.hoisted(() => {
  const ORG = "00000000-0000-4000-8000-0000000000aa";
  const CONVERSA = "00000000-0000-4000-8000-0000000000cc";
  const CONTATO = "00000000-0000-4000-8000-0000000000c1";
  return {
    ORG,
    CONVERSA,
    estado: { conversaNaLista: true },
    CONVERSA_ROW: {
      id: CONVERSA,
      organization_id: ORG,
      contact_id: CONTATO,
      status: "open",
      tags: [],
      contacts: {
        id: CONTATO,
        display_name: "Cliente Teste",
        name: null,
        phone_number: "+5511999887666",
        tags: [],
      },
    },
  };
});

const get = vi.fn(async (bruta?: string): Promise<unknown> => {
  const url = bruta ?? "";
  if (url.startsWith("/api/v1/conversations?")) {
    return { data: estado.conversaNaLista ? [CONVERSA_ROW] : [], meta: { has_more: false } };
  }
  // A busca por id nunca volta: a janela entre "saiu da lista" e "chegou por id"
  // fica aberta durante todo o caso.
  if (url === `/api/v1/conversations/${CONVERSA}`) return new Promise(() => {});
  if (url === "/api/v1/ai/automatico-ativo") return { data: { ativo: true } };
  if (url === "/api/v1/conversations/counts") return { data: {} };
  if (url === "/api/v1/conversation-tags") return { data: [] };
  return { data: [] };
});

vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => get(url) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: vi.fn().mockResolvedValue(undefined),
  createClient: () => ({
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "admin" }, activeOrg: { orgId: ORG } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

/** Sonda do composer: o texto vive no estado DELE, como no real. */
vi.mock("@/components/inbox/Composer", () => ({
  Composer: function SondaDoComposer() {
    const [texto, setTexto] = useState("");
    return <textarea aria-label="campo de resposta" value={texto} onChange={(e) => setTexto(e.target.value)} />;
  },
}));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/ConversationList", () => ({ ConversationList: () => null }));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/NumeroForaDoAr", () => ({ NumeroForaDoAr: () => null }));
vi.mock("@/components/inbox/MensagensAgendadas", () => ({ MensagensAgendadas: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({
  InboxKeyboardShortcuts: () => null,
}));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";

describe("recarga da lista com texto no campo", () => {
  beforeEach(() => {
    get.mockClear();
    estado.conversaNaLista = true;
    window.history.replaceState(null, "", `/app/inbox?filter=all&id=${CONVERSA}`);
  });

  it("a conversa sai da lista depois do envio e o que estava sendo digitado continua no campo", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <InboxLayout initialSelectedId={CONVERSA} />
      </QueryClientProvider>,
    );

    const campo = await screen.findByLabelText("campo de resposta");
    fireEvent.change(campo, { target: { value: "segunda mensagem, ainda escrevendo" } });

    // A recarga que vem com o realtime já não traz a conversa.
    estado.conversaNaLista = false;
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["conversations"] });
    });
    await waitFor(() =>
      expect(get.mock.calls.map((c) => c[0])).toContain(`/api/v1/conversations/${CONVERSA}`),
    );

    expect(screen.queryByText("Selecione uma conversa")).toBeNull();
    expect(screen.getByLabelText("campo de resposta")).toHaveValue("segunda mensagem, ainda escrevendo");
  });
});
