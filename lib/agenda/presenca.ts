/**
 * PC-052 parte 2 — A PRESENÇA DO LEAD E A COR NO GOOGLE.
 *
 * A presença é a resposta do LEAD ("vou", "não vou"), e mora numa coluna
 * própria (`calendar_appointments.lead_presence`) justamente para não se
 * misturar ao `status`, que é da equipe (confirmado, realizado, faltou). Ela só
 * existe quando o TIPO de atendimento pede (`lead_presence_enabled`): nula é o
 * comportamento de sempre.
 *
 * Três estados e três cores, como o escritório pinta à mão hoje:
 *  - aguardando (ao marcar e ao remarcar) → amarelo;
 *  - confirmada (o lead confirmou por qualquer mensagem) → verde;
 *  - nao_vai (disse que não vai ou pediu para remarcar) → vermelho.
 *
 * O vermelho FICA na agenda como registro e LIBERA o horário: o evento vai
 * `transparent` no Google, o motor não conta (`lib/agenda/ocupados.ts`), o
 * índice de instante único não vê (migration 9040) e o lembrete não sai. A
 * remarcação nasce em cima, como compromisso novo, amarelo.
 *
 * ⚠️ A COR NÃO PASSA PELA MÁQUINA DE PROJEÇÕES DO SYNC, de propósito.
 * `lib/agenda/google/sync-model.ts` compara título, descrição, local e
 * convidado por hash; pôr cor ali mudaria a projeção de TODO compromisso já
 * publicado e o cron mandaria um PATCH `sendUpdates=all` para cada um. A cor
 * sai no corpo do evento NOVO (`paraEventoDoGoogle`) e, quando a presença muda,
 * num PATCH só de `colorId` e `transparency`, com `sendUpdates=none`
 * (`pintarPresencasPendentes`, chamado pelo cron `agenda-google-sync`). O PATCH
 * parcial do sync (`delta`) nunca toca nesses dois campos, então um não desfaz
 * o outro.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { tokenForConnection } from "@/lib/agenda/google/sync-executor";

export {
  PRESENCAS,
  COR_DA_PRESENCA,
  ehPresenca,
  presencaLiberaOHorario,
  aparenciaDaPresenca,
  type Presenca,
} from "./presenca-cor";
import { aparenciaDaPresenca } from "./presenca-cor";

const ENDERECO_DE_EVENTOS = "https://www.googleapis.com/calendar/v3/calendars";
const PRAZO_MS = 10_000;
const LIMITE_POR_RODADA = 50;

type Admin = ReturnType<typeof createAdminClient>;

interface LinhaParaPintar {
  id: string;
  organization_id: string;
  lead_presence: string | null;
  google_connection_id: string | null;
  google_calendar_id: string | null;
  google_event_id: string | null;
}

/**
 * Repinta no Google os compromissos cuja presença mudou desde a última pintura.
 *
 * Só toca evento JÁ publicado (`google_base_projection` não nulo): o evento
 * ainda não publicado nasce com a cor certa no POST do sync (e é repintado uma
 * vez depois, sem efeito: a cor já é a mesma). Uma falha num
 * compromisso não para os outros e não grava `lead_presence_painted`, então a
 * próxima rodada tenta de novo. Nenhum dado de lead vai para o log.
 */
export async function pintarPresencasPendentes(
  admin: Admin,
  opcoes: { limite?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ pintados: number; falhas: number; porOrganizacao: Map<string, number> }> {
  const fetchImpl = opcoes.fetchImpl ?? fetch;
  let data: unknown[] | null = null;
  try {
    const r = await admin
      .from("calendar_appointments")
      .select("id, organization_id, lead_presence, google_connection_id, google_calendar_id, google_event_id")
      .not("lead_presence", "is", null)
      .is("lead_presence_painted", null)
      .not("google_event_id", "is", null)
      .not("google_base_projection", "is", null)
      .not("google_connection_id", "is", null)
      .not("google_calendar_id", "is", null)
      .in("status", ["pending", "confirmed"])
      // Compromisso que já acabou sai da fila: a cor era para a agenda do dia, e
      // uma falha permanente (conexão desligada, agenda sem acesso) num horário
      // passado não pode ficar na frente de todo mundo para sempre.
      .gte("ends_at", new Date().toISOString())
      .order("starts_at", { ascending: true })
      .limit(opcoes.limite ?? LIMITE_POR_RODADA);
    if (r.error) throw new Error(r.error.message);
    data = r.data ?? [];
  } catch (e) {
    // A pintura é um extra do cron de publicação: falhar aqui não pode
    // derrubar a rodada que já publicou os compromissos.
    logger.warn("[presenca] leitura dos compromissos a pintar falhou", {
      error: e instanceof Error ? e.message : "erro",
    });
    return { pintados: 0, falhas: 1, porOrganizacao: new Map() };
  }
  const pendentes = (data ?? []) as LinhaParaPintar[];

  let pintados = 0;
  let falhas = 0;
  const porOrganizacao = new Map<string, number>();
  for (const linha of pendentes) {
    const ok = await pintarUm(admin, linha, fetchImpl);
    if (ok) {
      pintados += 1;
      porOrganizacao.set(linha.organization_id, (porOrganizacao.get(linha.organization_id) ?? 0) + 1);
    } else falhas += 1;
  }
  return { pintados, falhas, porOrganizacao };
}

async function pintarUm(admin: Admin, linha: LinhaParaPintar, fetchImpl: typeof fetch): Promise<boolean> {
  const aparencia = aparenciaDaPresenca(linha.lead_presence);
  if (!aparencia || !linha.google_connection_id || !linha.google_calendar_id || !linha.google_event_id) return false;
  try {
    const token = await tokenForConnection(admin, linha.organization_id, linha.google_connection_id);
    const resposta = await fetchImpl(
      `${ENDERECO_DE_EVENTOS}/${encodeURIComponent(linha.google_calendar_id)}/events/${encodeURIComponent(linha.google_event_id)}?sendUpdates=none`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(aparencia),
        signal: AbortSignal.timeout(PRAZO_MS),
        cache: "no-store",
      },
    );
    if (resposta.status === 404 || resposta.status === 410) {
      // O evento não existe mais no Google: não há o que pintar. Marca como
      // resolvido para sair da fila (a recriação, se houver, nasce com a cor
      // certa pelo POST do sync).
      await admin
        .from("calendar_appointments")
        .update({ lead_presence_painted: linha.lead_presence })
        .eq("organization_id", linha.organization_id)
        .eq("id", linha.id)
        .eq("lead_presence", linha.lead_presence as string);
      return false;
    }
    if (!resposta.ok) {
      logger.warn("[presenca] o Google recusou a cor", {
        organization_id: linha.organization_id,
        appointment_id: linha.id,
        status: resposta.status,
      });
      return false;
    }
    // Grava só se a presença ainda é a que foi pintada: se mudou no meio, a
    // próxima rodada pinta a nova.
    const { error } = await admin
      .from("calendar_appointments")
      .update({ lead_presence_painted: linha.lead_presence })
      .eq("organization_id", linha.organization_id)
      .eq("id", linha.id)
      .eq("lead_presence", linha.lead_presence as string);
    if (error) {
      logger.warn("[presenca] cor pintada, mas o registro falhou", {
        organization_id: linha.organization_id,
        appointment_id: linha.id,
        error: error.message,
      });
      return false;
    }
    return true;
  } catch (e) {
    logger.warn("[presenca] falha ao pintar no Google", {
      organization_id: linha.organization_id,
      appointment_id: linha.id,
      error: e instanceof Error ? e.name : "erro",
    });
    return false;
  }
}
