/**
 * O MENU ENXUTO do trilho lateral (PC-013).
 *
 * ─── O que é ───────────────────────────────────────────────────────────────
 *
 * Desde o PC-013 a barra lateral do computador nasce RECOLHIDA, num trilho de
 * ícones, e abre por cima do conteúdo quando o mouse passa — com poucas
 * opções, as do dia a dia de um escritório: Inbox, Funis, Agenda, Contatos,
 * Tarefas, Casos, Agente de IA e Dados (Configurações fica no rodapé, como
 * sempre). O menu completo, com os grupos e os "Ver tudo em…", continua a um
 * clique ("Menu completo", que fixa a barra aberta) e no ⌘K.
 *
 * ─── A régua de quem vê cada item ──────────────────────────────────────────
 *
 * A MESMA do menu completo: `destinosDaInterface` (papel, telas escolhidas pela
 * empresa, cargos, módulos e capacidades). O menu enxuto nunca mostra destino
 * que o menu completo esconderia — ele só escolhe, entre os visíveis, quais
 * ficam no trilho.
 *
 * Os dois itens de grupo ("Agente de IA" e "Dados") apontam para o lugar que
 * abre o assunto inteiro: o hub da IA (`/app/ai`) e o construtor de painéis
 * (`/app/dados`). "Agente de IA" só aparece se a pessoa vê alguma tela do grupo
 * IA; "Dados", se vê `/app/dados`.
 *
 * "Casos" entra além do desenho aprovado (que tinha oito itens) por um motivo
 * operacional: é o contador de conversas que a IA passou para uma pessoa — tirá-lo
 * do trilho esconderia o aviso de cliente esperando atendimento humano.
 */

import type { Role } from "@/lib/auth/types";
import type { CapacidadeDaOrganizacao } from "@/lib/organizacao/capacidades";
import type { ModuloOpcional } from "@/lib/instalacao/modulos";

import type { NavGroupId } from "./catalogo";
import { destinosDaInterface, type InterfaceSettings } from "./interface";
import { NAV_DESTINATIONS, type NavDestination } from "./registry";

/** Os destinos do trilho, nesta ordem. */
export const HREFS_DO_MENU_ENXUTO = [
  "/app/inbox",
  "/app/kanban",
  "/app/agenda",
  "/app/contacts",
  "/app/tasks",
  "/app/ai/cases",
] as const;

/** Item de grupo: aparece se a pessoa vê alguma tela do grupo. */
export const GRUPOS_DO_MENU_ENXUTO: ReadonlyArray<{
  grupo: NavGroupId;
  href: string;
  label: string;
  /** Destino que precisa estar visível; sem ele, vale qualquer um do grupo. */
  exige?: string;
}> = [
  { grupo: "ia", href: "/app/ai", label: "Agente de IA" },
  { grupo: "analise", href: "/app/dados", label: "Dados", exige: "/app/dados" },
];

export interface ItemDoMenuEnxuto {
  href: string;
  label: string;
  icon: NavDestination["icon"];
  contador?: NavDestination["contador"];
}

export function menuEnxuto(
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
  modulos?: readonly ModuloOpcional[],
  capacidades?: readonly CapacidadeDaOrganizacao[],
): ItemDoMenuEnxuto[] {
  const visiveis = destinosDaInterface(settings, isPlatformAdmin, role, modulos, capacidades);
  const hrefs = new Set(visiveis.map((d) => d.href));
  const porHref = new Map(NAV_DESTINATIONS.map((d) => [d.href, d]));

  const itens: ItemDoMenuEnxuto[] = [];
  for (const href of HREFS_DO_MENU_ENXUTO) {
    const d = porHref.get(href);
    if (!d || !hrefs.has(href)) continue;
    itens.push({ href: d.href, label: d.label, icon: d.icon, contador: d.contador });
  }
  for (const g of GRUPOS_DO_MENU_ENXUTO) {
    const doGrupo = NAV_DESTINATIONS.filter((d) => d.group === g.grupo && hrefs.has(d.href));
    if (doGrupo.length === 0) continue;
    if (g.exige && !hrefs.has(g.exige)) continue;
    const icone = (g.exige ? porHref.get(g.exige)?.icon : undefined) ?? doGrupo[0]!.icon;
    itens.push({ href: g.href, label: g.label, icon: icone });
  }
  return itens;
}
