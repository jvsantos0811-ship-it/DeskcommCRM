/**
 * O REVEZAMENTO entre agendas de um mesmo responsável (PC-054).
 *
 * ─── O caso ────────────────────────────────────────────────────────────────
 *
 * Um escritório conecta UMA conta Google (a de quem atende no CRM) e, dentro
 * dela, tem a agenda de cada especialista. As especialistas não têm usuário no
 * CRM. O rodízio de responsáveis (PC-052, `rodizio.ts`) não serve: ele troca de
 * PESSOA do CRM. Aqui a pessoa é a mesma, e o que alterna é a AGENDA do Google
 * em que o compromisso é gravado.
 *
 * ─── A régua ───────────────────────────────────────────────────────────────
 *
 * - Um horário está livre quando PELO MENOS UMA agenda do revezamento está livre
 *   nele. Cada agenda é ocupada só pelos eventos do Google dela e pelos
 *   compromissos do CRM gravados nela (`agendaDoCompromisso`).
 * - A vez é a mesma do rodízio de responsáveis (`ordemDaVez`): depois da agenda
 *   que recebeu o compromisso mais recente deste tipo. Quem não tem o horário
 *   cede a vez à próxima.
 * - Só entra a agenda UTILIZÁVEL: disponível, que aceita publicação e que conta
 *   para conflito. Sem contar para conflito, os eventos pessoais dela não são
 *   lidos (a leitura do Google só traz agenda que conta) e o horário pareceria livre por
 *   ignorância — o erro caro é marcar por cima de um compromisso que existe.
 * - Remarcar fica na MESMA agenda: o evento do Google é atualizado, não movido
 *   (`alterarAgendamentoHandler` reescreve a mesma linha).
 *
 * ─── Lista vazia = desligado ───────────────────────────────────────────────
 *
 * Sem agendas no tipo (ou nenhuma utilizável), `revezamentoDoTipo` devolve
 * `null` e a consulta segue a regra de sempre: a ocupação do DONO inteiro, e o
 * compromisso vai para a agenda de destino dele.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isServiceRoleConfigured } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { listaDoRodizio, ordemDaVez } from "./rodizio";

/** Uma agenda do revezamento, já utilizável. `nome` é o que a IA diz ao cliente (a especialista). */
export interface AgendaDoRevezamento {
  id: string;
  connectionId: string;
  externalCalendarId: string;
  nome: string;
}

export type MotivoDoDescarte = "fora_da_conta" | "indisponivel" | "sem_escrita" | "nao_conta_conflito";

export interface Revezamento {
  /** As utilizáveis, NA ORDEM DA VEZ. Nunca vazia: sem nenhuma, não há revezamento (`null`). */
  agendas: AgendaDoRevezamento[];
  /**
   * A agenda de destino de quem atende — onde cai o compromisso sem agenda
   * escolhida. `null` quando não há uma só (nenhuma, ou o dado está torto).
   */
  destino: { id: string; connectionId: string; externalCalendarId: string } | null;
  /** As da lista que ficaram de fora, e por quê. É o aviso de quem configura. */
  descartadas: Array<{ id: string; motivo: MotivoDoDescarte }>;
}

/** Uma linha de `fn_agenda_revezamento_do_dono` (migration 9045). */
export interface LinhaDaAgendaDoDono {
  agenda_id: string;
  connection_id: string;
  external_calendar_id: string;
  nome: string | null;
  na_lista: boolean;
  destino: boolean;
  disponivel: boolean;
  aceita_escrita: boolean;
  conta_conflito: boolean;
}

/** A lista do tipo, sem repetidos e sem vazio. Nulo/vazio = sem revezamento. */
export function listaDoRevezamento(bruto: unknown): string[] {
  return listaDoRodizio(bruto);
}

/** Por que uma agenda da lista não entra. `null` = entra. */
export function motivoDoDescarte(
  linha: Pick<LinhaDaAgendaDoDono, "disponivel" | "aceita_escrita" | "conta_conflito"> | undefined,
): MotivoDoDescarte | null {
  if (!linha) return "fora_da_conta";
  if (!linha.disponivel) return "indisponivel";
  if (!linha.aceita_escrita) return "sem_escrita";
  if (!linha.conta_conflito) return "nao_conta_conflito";
  return null;
}

/**
 * O revezamento, PURO: a lista do tipo, as linhas que a função devolveu para o
 * dono e a agenda que recebeu o compromisso mais recente deste tipo.
 *
 * A ordem da lista é a ordem da vez; quem foi descartado sai dela sem mudar a
 * ordem das demais.
 */
export function montarRevezamento(
  lista: readonly string[],
  linhas: readonly LinhaDaAgendaDoDono[],
  ultimaAgenda: string | null,
): Revezamento | null {
  const unicos = listaDoRevezamento(lista);
  if (unicos.length === 0) return null;

  const porId = new Map(linhas.map((l) => [l.agenda_id, l]));
  const utilizaveis: AgendaDoRevezamento[] = [];
  const descartadas: Revezamento["descartadas"] = [];
  for (const id of unicos) {
    const linha = porId.get(id);
    const motivo = motivoDoDescarte(linha && linha.na_lista ? linha : undefined);
    if (motivo || !linha) {
      descartadas.push({ id, motivo: motivo ?? "fora_da_conta" });
      continue;
    }
    utilizaveis.push({
      id,
      connectionId: linha.connection_id,
      externalCalendarId: linha.external_calendar_id,
      // Sem nome legível, a IA ao menos não inventa um: "agenda" genérico.
      nome: (linha.nome ?? "").trim() || "agenda",
    });
  }
  if (utilizaveis.length === 0) return null;

  const ordem = ordemDaVez(
    utilizaveis.map((a) => a.id),
    ultimaAgenda,
  );
  const agendas = ordem.map((id) => utilizaveis.find((a) => a.id === id) as AgendaDoRevezamento);

  const destinos = linhas.filter((l) => l.destino);
  const destino =
    destinos.length === 1 && destinos[0]
      ? {
          id: destinos[0].agenda_id,
          connectionId: destinos[0].connection_id,
          externalCalendarId: destinos[0].external_calendar_id,
        }
      : null;

  return { agendas, destino, descartadas };
}

/**
 * A UNIÃO dos horários das agendas, PURA. Entra na ordem da vez; um horário que
 * duas agendas têm fica com a primeira (a da vez). Sai em ordem de início.
 */
export function unirHorariosDasAgendas<S extends { inicio: Date }>(
  porAgenda: ReadonlyArray<{ agendaId: string; slots: readonly S[] }>,
): Array<S & { agendaId: string }> {
  const porInicio = new Map<number, S & { agendaId: string }>();
  for (const { agendaId, slots } of porAgenda) {
    for (const s of slots) {
      const chave = s.inicio.getTime();
      if (!porInicio.has(chave)) porInicio.set(chave, { ...s, agendaId });
    }
  }
  return [...porInicio.values()].sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
}

/** As colunas de `calendar_appointments` que dizem em que agenda o compromisso está. */
export interface CompromissoComAgenda {
  target_calendar_id?: string | null;
  google_connection_id?: string | null;
  google_calendar_id?: string | null;
}

/**
 * EM QUE AGENDA este compromisso está (ou vai estar), entre as do revezamento.
 *
 * - Já foi ao Google: a agenda onde o evento está (`google_*`).
 * - Ainda não foi, com agenda escolhida: a escolhida (`target_calendar_id`).
 * - Ainda não foi, sem agenda escolhida: a de destino, que é para onde o claim
 *   vai mandá-lo (`fn_google_appointment`).
 *
 * Devolve `"todas"` quando não dá para saber (sem destino e sem escolha): o
 * compromisso ocupa TODAS as agendas — o erro barato é mostrar ocupado a mais.
 * Devolve `null` quando ele está numa agenda que não é do revezamento nem o
 * destino: não ocupa nenhuma delas.
 */
export function agendaDoCompromisso(
  linha: CompromissoComAgenda,
  rev: Pick<Revezamento, "agendas" | "destino">,
): string | "todas" | null {
  const conhecidas = [...rev.agendas, ...(rev.destino ? [rev.destino] : [])];
  if (linha.google_connection_id && linha.google_calendar_id) {
    const achada = conhecidas.find(
      (a) => a.connectionId === linha.google_connection_id && a.externalCalendarId === linha.google_calendar_id,
    );
    return achada?.id ?? null;
  }
  if (linha.target_calendar_id) return linha.target_calendar_id;
  return rev.destino?.id ?? "todas";
}

/**
 * O revezamento deste tipo para este dono, lido do banco. `null` = sem
 * revezamento (lista vazia, nenhuma agenda utilizável, ou a leitura falhou).
 *
 * ⚠️ Leitura que falha devolve `null`, e a direção é a segura: sem revezamento,
 * a consulta volta à ocupação do dono INTEIRO, que conta todas as agendas que
 * contam para conflito — oferece menos horário, nunca marca por cima.
 *
 * As agendas saem por função (`fn_agenda_revezamento_do_dono`, migration 9045)
 * pelo MESMO client que veio de fora, pela razão de `consulta.ts` (issue #879):
 * a RLS de `calendar_connection_calendars` só mostra a agenda ao dono da conexão
 * e a `manager`, e um atendente marcando pela tela ficaria sem revezamento.
 *
 * A vez é lida pelo client admin quando há (filtro de organização explícito),
 * pela mesma razão do rodízio de responsáveis (`rodizio.ts`): a RLS de
 * `calendar_appointments` pode esconder a agenda dos colegas. Erro nessa leitura
 * só tira a memória da vez: a ordem começa da primeira da lista.
 */
export async function revezamentoDoTipo(
  supabase: SupabaseClient,
  organizationId: string,
  args: { tipoId: string; lista: unknown; donoId: string },
): Promise<Revezamento | null> {
  const lista = listaDoRevezamento(args.lista);
  if (lista.length === 0) return null;

  const { data: linhas, error } = await supabase.rpc("fn_agenda_revezamento_do_dono", {
    p_org: organizationId,
    p_owner: args.donoId,
    p_agendas: lista,
  });
  if (error) {
    logger.warn("[agenda] revezamento ilegível; vale a agenda inteira do responsável", {
      organization_id: organizationId,
      event_type_id: args.tipoId,
      erro: error.message,
    });
    return null;
  }

  const client = isServiceRoleConfigured() ? createAdminClient() : supabase;
  const { data: ultimo } = await client
    .from("calendar_appointments")
    .select("target_calendar_id")
    .eq("organization_id", organizationId)
    .eq("event_type_id", args.tipoId)
    .eq("owner_user_id", args.donoId)
    .neq("status", "cancelled")
    .in("target_calendar_id", lista)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ultimaAgenda = (ultimo as { target_calendar_id?: string | null } | null)?.target_calendar_id ?? null;

  const lidas = (linhas ?? []) as LinhaDaAgendaDoDono[];
  const rev = montarRevezamento(lista, lidas, ultimaAgenda);
  const descartadas = rev?.descartadas ?? lista.map((id) => ({ id, motivo: "fora_da_conta" as const }));
  // Dono sem NENHUMA agenda da lista (o rodízio de responsáveis perguntando por
  // outra pessoa) não é aviso: as agendas simplesmente não são dele.
  if (descartadas.length > 0 && lidas.some((l) => l.na_lista)) {
    // O AVISO: agenda que deixou de valer sai do revezamento sem derrubar a
    // consulta. Só ids e motivos — nunca nome de agenda nem dado de compromisso.
    logger.warn("[agenda] agenda fora do revezamento", {
      organization_id: organizationId,
      event_type_id: args.tipoId,
      descartadas,
    });
  }
  return rev;
}
