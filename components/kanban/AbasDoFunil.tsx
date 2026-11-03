"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { useT } from "@/hooks/i18n/useT";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { usePreferenciaDoNavegador } from "@/hooks/ui/usePreferenciaDoNavegador";
import { apiClient } from "@/lib/api/client";
import { roleAtLeast } from "@/lib/auth/types";
import { searchable } from "@/lib/navigation/registry";
import { cn } from "@/lib/utils";

/**
 * As abas do funil (PC-013): Funil · Agenda · Ligações · Recuperação.
 *
 * ─── Por que abas, se cada uma é uma tela que já existe ─────────────────────
 *
 * Quem vende passa o dia entre quatro perguntas sobre o MESMO funil: onde está
 * cada negócio, o que está marcado, quem ligou e o que se perdeu. Antes, cada
 * resposta morava num canto do menu (Agenda no Atendimento, Chamadas e
 * Recuperação atrás de "Ver tudo em CRM"). As abas não criam tela nenhuma: são
 * portas para as que existem, postas no topo de cada uma delas, para que ir e
 * voltar seja um clique e não uma caça ao menu.
 *
 * ─── Quem vê cada aba ──────────────────────────────────────────────────────
 *
 * A MESMA regra do menu e do ⌘K (`searchable`): papel, telas escolhidas pela
 * empresa e cargos. Uma aba que leva a uma tela que o servidor recusaria seria
 * prometer o que não se cumpre.
 *
 * "Ligações" pede mais: a telefonia é módulo opcional e o app não sabe se ela
 * está ligada (ver o comentário de `/app/calls` em `lib/navigation/catalogo.ts`).
 * O sinal usado aqui é ter ao menos um número de telefonia ATIVO cadastrado —
 * sem número não há ligação, e a aba levaria a uma lista vazia para sempre. A
 * consulta só acontece para quem pode abrir Chamadas (gerente+, o mesmo
 * `requireRole("manager")` de `GET /api/v1/phone-numbers`) e é leitura de
 * ambiente: `semDesvioDeSuspensao`, para um 403 de organização suspensa não
 * desviar a página no meio de outra navegação.
 *
 * ─── A aba "Funil" lembra o último quadro aberto ────────────────────────────
 *
 * Na Agenda, "Funil" volta para o quadro que a pessoa estava usando, não para a
 * lista de funis. A lembrança é por navegador (`usePreferenciaDoNavegador`) e
 * quem a grava é o próprio quadro; sem ela, a aba leva à lista.
 */

export const CHAVE_ULTIMO_FUNIL = "funil-ultimo-quadro";

interface Aba {
  id: "funil" | "agenda" | "ligacoes" | "recuperacao";
  rotulo: string;
  href: string;
  ativa: (pathname: string) => boolean;
}

function comeca(pathname: string, prefixo: string): boolean {
  return pathname === prefixo || pathname.startsWith(prefixo + "/");
}

const CLASSE_DA_ABA = (ativa: boolean) =>
  cn(
    "-mb-px shrink-0 whitespace-nowrap border-b-2 px-0.5 pb-2.5 pt-1 text-sm transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    ativa ? "border-accent font-semibold text-text" : "border-transparent text-text-muted hover:text-text",
  );

function LinkDaAba({ aba, pathname }: { aba: Aba; pathname: string }) {
  const ativa = aba.ativa(pathname);
  return (
    <Link
      href={aba.href}
      aria-current={ativa ? "page" : undefined}
      data-testid={`aba-do-funil-${aba.id}`}
      className={CLASSE_DA_ABA(ativa)}
    >
      {aba.rotulo}
    </Link>
  );
}

/**
 * A aba "Ligações" num componente próprio para a consulta só EXISTIR para quem
 * pode abrir Chamadas: quem não pode nem monta este componente, e nenhuma
 * requisição sai do navegador dele.
 */
function AbaDeLigacoes({ pathname }: { pathname: string }) {
  const t = useT();
  const { data: temTelefonia } = useQuery({
    queryKey: ["abas-do-funil", "telefonia-ativa"],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const res = await apiClient.get<{ data: Array<{ is_active: boolean }> }>(
        "/api/v1/phone-numbers",
        { semDesvioDeSuspensao: true },
      );
      return (res.data ?? []).some((n) => n.is_active);
    },
  });
  if (temTelefonia !== true) return null;
  return (
    <LinkDaAba
      pathname={pathname}
      aba={{
        id: "ligacoes",
        rotulo: t("Ligações"),
        href: "/app/calls",
        ativa: (p) => comeca(p, "/app/calls"),
      }}
    />
  );
}

export function AbasDoFunil({ className }: { className?: string }) {
  const t = useT();
  const pathname = usePathname() ?? "";
  const user = useUser();
  const activeOrg = useActiveOrg();
  const [ultimoQuadro] = usePreferenciaDoNavegador(CHAVE_ULTIMO_FUNIL);

  const visiveis = new Set(
    searchable(
      Boolean(user?.is_platform_admin) && !user?.support,
      activeOrg?.role ?? null,
      activeOrg?.interface_settings,
      activeOrg?.modulos_ligados ?? [],
      activeOrg?.capacidades_ligadas ?? [],
    ).map((d) => d.href),
  );
  const podeVerLigacoes = visiveis.has("/app/calls") && roleAtLeast(activeOrg?.role, "manager");

  // Só um caminho de quadro conhecido vira destino: o valor vem do navegador
  // e um link montado a partir de texto arbitrário seria uma porta aberta.
  const quadro =
    ultimoQuadro && /^\/app\/pipelines\/[0-9a-f-]{36}$/i.test(ultimoQuadro)
      ? ultimoQuadro
      : "/app/kanban";

  return (
    <nav
      aria-label={t("Partes do funil")}
      data-testid="abas-do-funil"
      className={cn("-mt-2 flex items-end gap-6 overflow-x-auto border-b border-border", className)}
    >
      <LinkDaAba
        pathname={pathname}
        aba={{
          id: "funil",
          rotulo: t("Funil"),
          href: quadro,
          ativa: (p) => comeca(p, "/app/pipelines") || comeca(p, "/app/kanban"),
        }}
      />
      {visiveis.has("/app/agenda") && (
        <LinkDaAba
          pathname={pathname}
          aba={{ id: "agenda", rotulo: t("Agenda"), href: "/app/agenda", ativa: (p) => comeca(p, "/app/agenda") }}
        />
      )}
      {podeVerLigacoes && <AbaDeLigacoes pathname={pathname} />}
      {visiveis.has("/app/recuperacao") && (
        <LinkDaAba
          pathname={pathname}
          aba={{
            id: "recuperacao",
            rotulo: t("Recuperação"),
            href: "/app/recuperacao",
            ativa: (p) => comeca(p, "/app/recuperacao"),
          }}
        />
      )}
    </nav>
  );
}
