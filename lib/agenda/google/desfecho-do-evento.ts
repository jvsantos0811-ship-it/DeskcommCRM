/**
 * PC-062 — a ponte entre a leitura do Google e o desfecho do compromisso.
 *
 * Chamada pelo sync (`syncCalendar`) para cada evento VINCULADO a um
 * compromisso, depois de reconciliá-lo. Lê a cor do evento e as cores de
 * desfecho do tipo; se a equipe pintou Realizado ou Faltou depois do início,
 * registra o desfecho pelo mesmo caminho da tela (laço, automação, auditoria).
 * Desfecho que uma pessoa marcou no CRM nunca é sobrescrito pela cor.
 *
 * NUNCA LANÇA e nunca derruba o sync: o desfecho é um efeito a mais da leitura,
 * e a leitura dos horários ocupados é o que não pode parar. Uma falha aqui é
 * só registrada; a próxima rodada tenta de novo (a cor continua lá).
 * Nenhum dado de lead vai para o log.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { aplicaDesfecho, desfechoDaCor } from "@/lib/agenda/desfecho-pela-cor";
import { logger } from "@/lib/logger";

export async function aplicarDesfechoDoEvento(
  db: SupabaseClient,
  org: string,
  appointmentId: string,
  colorId: unknown,
  agora: Date = new Date(),
): Promise<"registrado" | "nada"> {
  // Sem cor no evento: nem consulta o banco (é o caso de quase todo evento).
  if (typeof colorId !== "string" || colorId === "") return "nada";
  try {
    const { data: compromisso, error } = await db
      .from("calendar_appointments")
      .select("id, status, starts_at, event_type_id, outcome_source_kind")
      .eq("organization_id", org)
      .eq("id", appointmentId)
      .maybeSingle();
    if (error || !compromisso?.event_type_id) return "nada";

    const { data: tipo, error: erroTipo } = await db
      .from("calendar_event_types")
      .select("outcome_color_completed, outcome_color_no_show")
      .eq("organization_id", org)
      .eq("id", compromisso.event_type_id)
      .maybeSingle();
    if (erroTipo || !tipo) return "nada";

    const desfecho = desfechoDaCor(colorId, {
      realizado: tipo.outcome_color_completed ?? null,
      faltou: tipo.outcome_color_no_show ?? null,
    });
    if (!desfecho) return "nada";
    // Quem marcou na tela (ou pela mensagem do cliente) manda: a cor fica no
    // evento para sempre, e uma releitura qualquer não pode desfazer a
    // correção de uma pessoa (achado da revisão independente).
    if (["user", "contact_message"].includes(String(compromisso.outcome_source_kind ?? ""))) return "nada";
    if (!aplicaDesfecho({ status: String(compromisso.status), starts_at: String(compromisso.starts_at) }, desfecho, agora)) {
      return "nada";
    }

    // Import na hora: o handler da agenda importa o lado de escrita do Google, e
    // importá-lo no topo deste módulo (que o sync importa) fecharia um ciclo.
    const { registrarDesfechoPeloGoogleHandler } = await import("@/app/api/v1/agenda/agendamentos/_handler");
    const r = await registrarDesfechoPeloGoogleHandler(
      db,
      {
        organization_id: org,
        actor: { type: "api_token", id: "cron:agenda-google-sync" },
        requestId: `google-cor:${appointmentId}`,
      },
      { id: appointmentId, status: desfecho, cor: colorId },
    );
    return r.registrado ? "registrado" : "nada";
  } catch (err) {
    logger.warn("[agenda] desfecho pela cor do Google não registrado", {
      organization_id: org,
      detalhe: err instanceof Error ? err.message.slice(0, 160) : "erro",
    });
    return "nada";
  }
}
