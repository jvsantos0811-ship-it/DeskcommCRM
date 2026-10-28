import type React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConversationHeader } from "./ConversationHeader";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * PARIDADE E GUIA DA BARRA DE AÇÕES DO CABEÇALHO (#3003).
 *
 * ─── O que este arquivo prova, e o que ele NÃO prova ─────────────────────────
 *
 * A issue pedia duas coisas: (1) menu "⋯" para as ações menos usadas e (2) guia
 * curta em cada botão. A (2) entrou no #3003. A (1) era regra de PRODUTO, e quem
 * a decidiu foi o dono deste fork no PC-011 (28/10/2026): Assumir e Fechar
 * ficam à vista; Transferir, Lembrar, Arquivar e Marcar como pessoal vão para o
 * "⋯", com o mesmo efeito e a mesma confirmação. A paridade abaixo mede o
 * CABEÇALHO inteiro (barra + menu): mudar o lugar de uma ação é permitido,
 * fazê-la sumir não.
 *
 * ─── Por que a paridade é por CENÁRIO, e não uma lista só ────────────────────
 *
 * A barra é CONDICIONAL: "Liberar" só existe para o dono, "Reabrir" só em
 * conversa encerrada, "Arquivar" some na já arquivada. Uma lista única mediria o
 * pior caso e não veria a ação que sumiu de UM estado. Por isso cada cenário
 * declara o seu conjunto EXATO, e um caso à parte afirma que a UNIÃO dos
 * cenários cobre o inventário inteiro: é isso que pega a ação removida do
 * componente (ela deixa de aparecer em qualquer cenário, e a união encolhe).
 *
 * ─── Dublês ─────────────────────────────────────────────────────────────────
 *
 * `useAuth` e `useAutomaticoAtivo` são mutáveis: o estado do cenário decide o
 * que eles devolvem, senão não haveria como montar "com dono, automático de pé".
 * `SnoozeButton`, `DialButton` e `VideoCallButton` são componentes PRÓPRIOS e
 * ficam fora do escopo do #3003 (que é `ConversationHeader.tsx`); o dublê do
 * `SnoozeButton` preserva só o que a PARIDADE mede — que o cabeçalho continua
 * MONTANDO a ação. A guia deles é trabalho dos componentes deles.
 */

const estado = vi.hoisted(() => ({
  auth: {
    user: { id: "u1", support: null } as Record<string, unknown>,
  },
  automaticoDaOrg: true as boolean | undefined,
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => estado.auth,
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useReleaseConversation", () => ({
  useReleaseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useReopenConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useResumeAiAttendance", () => ({
  useResumeAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/usePauseAiAttendance", () => ({
  usePauseAiAttendance: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/contacts/usePersonalContact", () => ({
  useMarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
  useUnmarkPersonalContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({
  useAutomaticoAtivo: () => ({ data: estado.automaticoDaOrg }),
}));
vi.mock("@/components/kanban/OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("@/components/inbox/FaixaDaCarteira", () => ({ FaixaDaCarteira: () => null }));
vi.mock("@/components/inbox/ReassignDialog", () => ({ ReassignDialog: () => null }));
vi.mock("@/components/inbox/JanelaSelo", () => ({ JanelaSelo: () => null }));
vi.mock("@/components/inbox/ChannelLogo", () => ({ ChannelLogo: () => null }));
vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => null }));
vi.mock("@/components/inbox/VideoCallButton", () => ({ VideoCallButton: () => null }));
vi.mock("@/components/inbox/SnoozeButton", () => ({
  SnoozeSubmenu: () => (
    <div role="menuitem" data-dentro-do-menu>
      Lembrar
    </div>
  ),
}));
/**
 * O "⋯" é um menu do Radix, que só monta o conteúdo ao abrir e abre por evento
 * de ponteiro — o jsdom não o abre de forma confiável. O dublê desenha o
 * conteúdo SEMPRE, marcado com `data-dentro-do-menu`, para a paridade enxergar
 * o que o menu oferece e o caso do PC-011 saber o que está dentro e o que está
 * fora dele. O `onSelect` vira `onClick`, que é o que o Radix chama no clique.
 */
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div role="menu" data-dentro-do-menu>
      {children}
    </div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    asChild,
    disabled,
    ...resto
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    asChild?: boolean;
    disabled?: boolean;
    [k: string]: unknown;
  }) =>
    asChild ? (
      <>{children}</>
    ) : (
      <div role="menuitem" aria-disabled={disabled} onClick={onSelect} {...resto}>
        {children}
      </div>
    ),
}));

/**
 * O INVENTÁRIO — toda ação que a barra do cabeçalho oferece hoje.
 *
 * Ele é a régua da paridade: a união dos cenários tem de ser EXATAMENTE isto.
 * Apagar uma ação do componente encolhe a união de um cenário E desta lista (o
 * caso "a união cobre o inventário" reprova nos dois lados).
 */
const INVENTARIO = [
  "Buscar nesta conversa",
  "Assumir",
  "Liberar",
  "Devolver ao automático",
  "Pausar o automático",
  "Transferir",
  "Lembrar",
  "Fechar",
  "Reabrir",
  "Arquivar",
  "Marcar como pessoal",
  "Desmarcar pessoal",
  "Ver contato",
] as const;

/**
 * Botões que a barra RENDERIZA mas que pertencem a outros componentes — a guia
 * deles não está neste arquivo e não pode ser cobrada aqui. Estão nomeados um a
 * um, de propósito: a lista é curta e qualquer botão NOVO que este arquivo
 * desenhe cai fora dela e é cobrado.
 */
const GUIAS_DE_OUTROS_COMPONENTES = ["Lembrar"];

const CONTATO = {
  id: "contato-1",
  display_name: "Fulana",
  name: null,
  phone_number: "5511999",
  tags: [],
  is_blocked: false,
  is_personal: false,
  is_anonymized: false,
  force_human: false,
};

interface Cenario {
  nome: string;
  /** Sobrescreve a conversa base. */
  conversa?: Record<string, unknown>;
  contato?: Record<string, unknown>;
  /** Sobrescreve `estado.auth`. */
  auth?: typeof estado.auth;
  automaticoDaOrg?: boolean | undefined;
  /** Rótulo de uma ação (ou de qualquer texto) que ancora a barra neste cenário. */
  ancora: string;
  /** O conjunto EXATO de ações que este cenário oferece. */
  esperadas: string[];
  comBusca?: boolean;
}

/**
 * O cenário que oferece MAIS ações de uma vez: é ele que ancora o caso "a guia
 * não renomeou nenhum botão" (abaixo) e precisa de nome próprio — `CENARIOS[1]`
 * é `Cenario | undefined` sob `noUncheckedIndexedAccess`.
 */
const CENARIO_MAIS_COMPLETO: Cenario = {
  nome: "minha, com o automático calado — o estado que devolve as duas voltas",
  conversa: {
    assigned_to_user_id: "u1",
    assignee_kind: "user",
    bot_silenced_until: new Date(Date.now() + 10 * 60_000).toISOString(),
  },
  ancora: "Liberar",
  esperadas: [
    "Assumir",
    "Liberar",
    "Devolver ao automático",
    "Transferir",
    "Lembrar",
    "Fechar",
    "Arquivar",
    "Marcar como pessoal",
    "Ver contato",
  ],
};

const CENARIOS: Cenario[] = [
  {
    nome: "aberta e sem dono — a fila",
    ancora: "Assumir",
    comBusca: true,
    esperadas: [
      "Buscar nesta conversa",
      "Assumir",
      "Transferir",
      "Lembrar",
      "Fechar",
      "Arquivar",
      "Marcar como pessoal",
      "Ver contato",
    ],
  },
  CENARIO_MAIS_COMPLETO,
  {
    nome: "com dono e o automático de pé — pausar é gesto PRÓPRIO aqui",
    conversa: { assigned_to_user_id: "u2", assignee_kind: "user" },
    ancora: "Pausar o automático",
    esperadas: [
      "Assumir",
      "Pausar o automático",
      "Transferir",
      "Lembrar",
      "Fechar",
      "Arquivar",
      "Marcar como pessoal",
      "Ver contato",
    ],
  },
  {
    nome: "encerrada — o par Fechar/Reabrir vira Reabrir",
    conversa: { status: "closed" },
    ancora: "Reabrir",
    esperadas: ["Assumir", "Reabrir", "Arquivar", "Marcar como pessoal", "Ver contato"],
  },
  {
    nome: "arquivada — arquivar de novo não é gesto que exista",
    conversa: { status: "archived" },
    ancora: "Reabrir",
    esperadas: ["Assumir", "Reabrir", "Marcar como pessoal", "Ver contato"],
  },
  {
    nome: "contato marcado como pessoal — o par inverte",
    contato: { is_personal: true },
    auth: { user: { id: "u1", support: null, is_platform_admin: true } },
    // "Desmarcar pessoal" mora no ⋯ desde o PC-011; a âncora é um botão à vista.
    ancora: "Assumir",
    esperadas: [
      "Assumir",
      "Transferir",
      "Lembrar",
      "Fechar",
      "Arquivar",
      "Desmarcar pessoal",
      "Ver contato",
    ],
  },
];

function montar(cenario: Cenario) {
  estado.auth = cenario.auth ?? {
    user: { id: "u1", support: null, is_platform_admin: true },
  };
  estado.automaticoDaOrg = cenario.automaticoDaOrg ?? true;

  const conversa = {
    id: "conv-1",
    organization_id: "org-1",
    contact_id: "contato-1",
    status: "open",
    assigned_to_user_id: null,
    assigned_to_user_name: null,
    assignee_kind: "ai",
    bot_silenced_until: null,
    snooze_until: null,
    service_revision: 3,
    is_group: false,
    tags: [],
    contacts: { ...CONTATO, ...cenario.contato },
    channel_sessions: null,
    ...cenario.conversa,
  } as unknown as ConversationWithContact;

  return render(
    <ConversationHeader conversation={conversa} onBuscar={cenario.comBusca ? () => {} : undefined} />,
  );
}

/**
 * As ações do cabeçalho — a barra E o "⋯" (PC-011). Ancorada por rótulo, nunca
 * por índice fixo: sobe do botão-âncora até o elemento que contém o menu.
 */
function barraDeAcoes(ancora: string): HTMLElement {
  const botao = screen.getByText(ancora).closest("button");
  expect(botao, `a âncora "${ancora}" não renderizou um botão`).toBeTruthy();
  const barra = (botao as HTMLElement).parentElement;
  expect(barra, "a barra de ações não renderizou").toBeTruthy();
  expect(
    within(barra as HTMLElement).queryByRole("menu"),
    "o menu \"⋯\" saiu da barra de ações",
  ).not.toBeNull();
  return barra as HTMLElement;
}

/** "Esta ação está alcançável no cabeçalho?" — botão, link ou item do "⋯". */
function naBarra(barra: HTMLElement, rotulo: string): boolean {
  return (
    within(barra).queryAllByText(rotulo).length > 0 ||
    within(barra).queryByRole("button", { name: rotulo }) !== null ||
    within(barra).queryByRole("link", { name: rotulo }) !== null ||
    within(barra).queryByRole("menuitem", { name: rotulo }) !== null
  );
}

describe("#3003 — paridade: nenhuma ação da barra desaparece", () => {
  for (const cenario of CENARIOS) {
    it(`${cenario.nome}: continua oferecendo exatamente ${cenario.esperadas.length} ações`, () => {
      montar(cenario);
      const barra = barraDeAcoes(cenario.ancora);

      const presentes = INVENTARIO.filter((rotulo) => naBarra(barra, rotulo));
      expect(
        [...presentes].sort(),
        `o conjunto de ações do cenário "${cenario.nome}" mudou — ação a menos (ou a mais) quebra a paridade do #3003`,
      ).toEqual([...cenario.esperadas].sort());
    });
  }

  it("a união dos cenários cobre TODA ação do inventário — é aqui que a ação removida do componente reprova", () => {
    const vistas = new Set<string>();
    for (const cenario of CENARIOS) {
      const { unmount } = montar(cenario);
      const barra = barraDeAcoes(cenario.ancora);
      for (const rotulo of INVENTARIO) if (naBarra(barra, rotulo)) vistas.add(rotulo);
      unmount();
    }

    expect(
      [...INVENTARIO].filter((rotulo) => !vistas.has(rotulo)),
      "ação do inventário que NENHUM cenário oferece: ela saiu do componente, não do estado",
    ).toEqual([]);
    // Controle de não-vacuidade: a varredura varreu de verdade.
    expect(vistas.size, "a união não pode ser maior que o inventário").toBe(INVENTARIO.length);
  });
});

describe("#3003 — guia curta: todo botão da barra diz o que faz", () => {
  for (const cenario of CENARIOS) {
    it(`${cenario.nome}: nome acessível e guia, em cada botão`, () => {
      montar(cenario);
      const barra = barraDeAcoes(cenario.ancora);

      const alvos = Array.from(
        barra.querySelectorAll<HTMLElement>('button, a[href], [role="menuitem"]'),
      );
      expect(alvos.length, "a barra não renderizou botão nenhum").toBeGreaterThan(0);

      for (const el of alvos) {
        const nome = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
        expect(nome, `botão sem nome acessível na barra: ${el.outerHTML}`).not.toBe("");

        if (GUIAS_DE_OUTROS_COMPONENTES.includes(nome)) continue;

        // A guia vai em `title` e NÃO em `aria-label`: o `aria-label` SUBSTITUI o
        // nome acessível, e a catraca do mantenedor acha estes botões por
        // `getByRole("button", { name: "Fechar" })`. Guia que renomeia o botão
        // quebraria a régua em vez de ajudar quem está começando.
        expect(
          (el.getAttribute("title") ?? "").trim(),
          `"${nome}" não tem guia curta (#3003): quem está começando não sabe o que ele faz`,
        ).not.toBe("");
      }
    });
  }

  it("a guia não renomeou nenhum botão — o nome acessível continua sendo o rótulo visível", () => {
    montar(CENARIO_MAIS_COMPLETO);
    const barra = barraDeAcoes("Liberar");
    for (const rotulo of ["Assumir", "Liberar", "Fechar"]) {
      const botao = within(barra).getByRole("button", { name: rotulo });
      expect(botao.textContent?.trim()).toBe(rotulo);
    }
    expect(within(barra).getByRole("menuitem", { name: "Transferir" }).textContent?.trim()).toBe(
      "Transferir",
    );
    // PC-011: abaixo do `2xl` o rótulo VISÍVEL encurta para "Devolver"; o nome
    // acessível segue o completo, que é o que a régua e os e2e procuram.
    expect(within(barra).getByRole("button", { name: "Devolver ao automático" })).toBeTruthy();
  });
});

/**
 * A GUIA DE "LIBERAR" DIZ PARA ONDE A CONVERSA VAI — e isso depende do estado.
 *
 * `fn_conversation_assign` (dono → null) só limpa `bot_silenced_until` quando não
 * houve escalação (`last_handoff_at is null`); trava do contato, opt-out e org sem
 * automático também deixam a conversa na fila. Uma guia fixa prometendo "o
 * automático assume de novo" mentiria em todos esses estados.
 */
describe("#3003 — a guia de Liberar não promete o automático quando ele não volta", () => {
  const VOLTA = "Solta esta conversa: ela fica sem dono e o atendimento automático volta a responder.";
  const FILA = "Solta esta conversa: ela fica sem dono e volta para a fila, esperando um atendente.";
  const minha = { assigned_to_user_id: "u1", assignee_kind: "user", bot_silenced_until: "infinity" };

  const casos: Array<{ nome: string; cenario: Partial<Cenario>; guia: string }> = [
    { nome: "assumida sem escalação, org com automático", cenario: { conversa: minha }, guia: VOLTA },
    {
      nome: "assumida DEPOIS de uma escalação — a RPC mantém o silêncio",
      cenario: { conversa: { ...minha, last_handoff_at: "2026-10-01T10:00:00Z" } },
      guia: FILA,
    },
    { nome: "org sem automático no ar", cenario: { conversa: minha, automaticoDaOrg: false }, guia: FILA },
    {
      nome: "contato travado (force_human) — Liberar não destrava",
      cenario: { conversa: minha, contato: { force_human: true } },
      guia: FILA,
    },
  ];

  for (const caso of casos) {
    it(caso.nome, () => {
      montar({ nome: caso.nome, ancora: "Liberar", esperadas: [], ...caso.cenario });
      expect(screen.getByRole("button", { name: "Liberar" }).getAttribute("title")).toBe(caso.guia);
    });
  }
});

/**
 * PC-011 — O QUE FICA À VISTA E O QUE VAI PARA O "⋯".
 *
 * Decisão do dono (28/10/2026): no notebook o cabeçalho comia a altura da
 * conversa. Assumir e Fechar ficam como botões, sem abrir menu; Transferir,
 * Lembrar, Arquivar e Marcar como pessoal moram no "⋯". Os gestos de quem
 * manda (Liberar, Devolver/Pausar o automático) ficam à vista: são eles que
 * respondem "a IA está falando com este cliente?".
 */
describe("PC-011 — Assumir e Fechar à vista; o resto no ⋯", () => {
  function dentroDoMenu(el: HTMLElement | null): boolean {
    return el?.closest("[data-dentro-do-menu]") != null;
  }

  it("Assumir e Fechar são botões fora do menu", () => {
    montar(CENARIOS[0]!);
    for (const rotulo of ["Assumir", "Fechar"]) {
      const botao = screen.getByRole("button", { name: rotulo });
      expect(dentroDoMenu(botao), `"${rotulo}" foi parar dentro do ⋯`).toBe(false);
    }
  });

  it("Transferir, Lembrar, Arquivar e Marcar como pessoal estão no ⋯", () => {
    montar(CENARIOS[0]!);
    expect(screen.getByRole("button", { name: "Mais ações" })).toBeTruthy();
    for (const rotulo of ["Transferir", "Lembrar", "Arquivar", "Marcar como pessoal"]) {
      const item = screen.getByText(rotulo);
      expect(dentroDoMenu(item), `"${rotulo}" deveria estar no ⋯`).toBe(true);
      expect(screen.queryByRole("button", { name: rotulo }), `"${rotulo}" ainda é botão solto`).toBeNull();
    }
  });

  it("os gestos de quem manda continuam à vista", () => {
    montar(CENARIO_MAIS_COMPLETO);
    for (const rotulo of ["Liberar", "Devolver ao automático"]) {
      expect(dentroDoMenu(screen.getByRole("button", { name: rotulo }))).toBe(false);
    }
  });
});
