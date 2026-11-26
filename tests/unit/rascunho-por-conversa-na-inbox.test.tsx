import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O TEXTO DE UMA CONVERSA NÃO VAI PARA OUTRA (PC-057, 26/11/2026).
 *
 * Achado da revisão do PC-055: o campo de resposta tinha chave fixa e o texto
 * mora no estado dele. Escrever na conversa A e clicar em B deixava o texto de
 * A no campo de B — a um Enter do cliente errado. Agora a chave é por conversa
 * e o rascunho de cada uma é guardado e volta quando ela é reaberta.
 *
 * A sonda do campo faz o que o real faz nos pontos que importam: o texto nasce
 * de `initialDraft`, o modo de `initialMode`, e cada mudança sai por
 * `onDraftChange` num efeito.
 */

const { ORG, CONV_A, CONV_B, linha } = vi.hoisted(() => {
  const ORG = "00000000-0000-4000-8000-0000000000aa";
  const CONV_A = "00000000-0000-4000-8000-00000000000a";
  const CONV_B = "00000000-0000-4000-8000-00000000000b";
  const linha = (id: string) => ({
    id,
    organization_id: ORG,
    contact_id: `${id.slice(0, -2)}c1`,
    status: "open",
    tags: [],
    contacts: { id: `${id.slice(0, -2)}c1`, display_name: `Cliente ${id.slice(-1)}`, name: null, phone_number: null, tags: [] },
  });
  return { ORG, CONV_A, CONV_B, linha };
});

const get = vi.fn(async (bruta?: string): Promise<unknown> => {
  const url = bruta ?? "";
  if (url.startsWith("/api/v1/conversations?")) return { data: [linha(CONV_A), linha(CONV_B)], meta: { has_more: false } };
  if (url === `/api/v1/conversations/${CONV_A}`) return { data: linha(CONV_A) };
  if (url === `/api/v1/conversations/${CONV_B}`) return { data: linha(CONV_B) };
  if (url === "/api/v1/ai/automatico-ativo") return { data: { ativo: true } };
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
vi.mock("@/components/inbox/Composer", () => ({
  Composer: function SondaDoComposer({
    conversationId,
    initialDraft = "",
    initialMode = "reply",
    onDraftChange,
  }: {
    conversationId: string;
    initialDraft?: string;
    initialMode?: "reply" | "note";
    onDraftChange?: (texto: string, modo: "reply" | "note") => void;
  }) {
    const [texto, setTexto] = useState(initialDraft);
    const [modo, setModo] = useState(initialMode);
    useEffect(() => {
      onDraftChange?.(texto, modo);
    }, [texto, modo, onDraftChange]);
    return (
      <div data-testid="campo" data-conversa={conversationId} data-modo={modo}>
        <textarea aria-label="campo de resposta" value={texto} onChange={(e) => setTexto(e.target.value)} />
        <button onClick={() => setModo("note")}>Nota interna</button>
        <button onClick={() => setTexto("")}>Enviar</button>
      </div>
    );
  },
}));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/ConversationList", () => ({
  ConversationList: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <>
      <button onClick={() => onSelect(CONV_A)}>Abrir A</button>
      <button onClick={() => onSelect(CONV_B)}>Abrir B</button>
    </>
  ),
}));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/NumeroForaDoAr", () => ({ NumeroForaDoAr: () => null }));
vi.mock("@/components/inbox/MensagensAgendadas", () => ({ MensagensAgendadas: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";
import { esquecerTodosOsRascunhos } from "@/lib/inbox/rascunho-por-conversa";

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InboxLayout initialSelectedId={CONV_A} />
    </QueryClientProvider>,
  );
}

async function campoDa(conversa: string) {
  await waitFor(() => expect(screen.getByTestId("campo")).toHaveAttribute("data-conversa", conversa));
  return screen.getByLabelText("campo de resposta");
}

describe("rascunho por conversa na Inbox", () => {
  beforeEach(() => {
    esquecerTodosOsRascunhos();
    window.history.replaceState(null, "", `/app/inbox?filter=all&id=${CONV_A}`);
  });

  it("o texto escrito em A não aparece em B, e volta quando A é reaberta", async () => {
    montar();
    fireEvent.change(await campoDa(CONV_A), { target: { value: "Oi, seu benefício saiu" } });

    fireEvent.click(screen.getByRole("button", { name: "Abrir B" }));
    expect(await campoDa(CONV_B)).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Abrir A" }));
    expect(await campoDa(CONV_A)).toHaveValue("Oi, seu benefício saiu");
  });

  it("cada conversa guarda o próprio modo (resposta ou nota)", async () => {
    montar();
    await campoDa(CONV_A);
    fireEvent.click(screen.getByRole("button", { name: "Nota interna" }));
    fireEvent.change(screen.getByLabelText("campo de resposta"), { target: { value: "ligar amanhã" } });

    fireEvent.click(screen.getByRole("button", { name: "Abrir B" }));
    await campoDa(CONV_B);
    expect(screen.getByTestId("campo")).toHaveAttribute("data-modo", "reply");

    fireEvent.click(screen.getByRole("button", { name: "Abrir A" }));
    expect(await campoDa(CONV_A)).toHaveValue("ligar amanhã");
    expect(screen.getByTestId("campo")).toHaveAttribute("data-modo", "note");
  });

  it("depois do envio o rascunho some: reabrir a conversa traz o campo vazio", async () => {
    montar();
    fireEvent.change(await campoDa(CONV_A), { target: { value: "vai sair agora" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));

    fireEvent.click(screen.getByRole("button", { name: "Abrir B" }));
    await campoDa(CONV_B);
    fireEvent.click(screen.getByRole("button", { name: "Abrir A" }));
    expect(await campoDa(CONV_A)).toHaveValue("");
  });
});
