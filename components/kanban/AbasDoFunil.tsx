"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useT } from "@/hooks/i18n/useT";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { usePreferenciaDoNavegador } from "@/hooks/ui/usePreferenciaDoNavegador";
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
 * "Ligações" aparece para quem pode abrir Chamadas (gerente+, o mesmo
 * `requireRole("manager")` de `GET /api/v1/phone-numbers`), com ou sem
 * telefonia ligada. Até 03/11/2026 ela só aparecia com um número ATIVO
 * cadastrado — e, como nenhuma empresa tinha, a aba nunca aparecia e parecia
 * que faltava. Decisão do João (03/11): as quatro abas sempre no topo, como no
 * Venda Tech. Sem número, a própria tela de Chamadas diz o que falta e leva a
 * Conexões › Telefone.
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

/** A aba "Ligações": só para quem pode abrir Chamadas (gerente+). */
function AbaDeLigacoes({ pathname }: { pathname: string }) {
  const t = useT();
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
