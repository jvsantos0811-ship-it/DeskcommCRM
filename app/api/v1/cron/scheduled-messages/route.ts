/**
 * GET/POST /api/v1/cron/scheduled-messages — envia as mensagens agendadas
 * vencidas (migration 9001). Agendado a cada minuto no `scheduler`.
 *
 * ─── Como uma linha sai ─────────────────────────────────────────────────────
 *
 * 1. CLAIM atômico: `scheduled → sending` com filtro `status = 'scheduled'`.
 *    Dois ticks concorrentes leem a mesma linha; só o primeiro a atualiza, e o
 *    segundo recebe 0 linhas e pula — nunca envia em dobro.
 * 2. Reconfere QUEM agendou: precisa ainda ser membro ativo da organização com
 *    papel de atendente ou acima. Quem foi removido da equipe não continua
 *    falando pelo WhatsApp da empresa por um agendamento antigo.
 * 3. Envia pela MESMA porta de saída de toda mensagem (`sendMessageHandler`),
 *    em nome de quem agendou — janela de 24h, opt-out, throttle, assinatura e
 *    org parada valem igual ao envio pela tela.
 * 4. Sucesso → `sent` com o elo `message_id`. Falha → `failed` com o motivo, e
 *    uma NOTA INTERNA no fio da conversa, onde o atendente vai olhar.
 *
 * ─── O que este cron NÃO faz ────────────────────────────────────────────────
 *
 * Não reenvia. Linha presa em `sending` além de `ENVIO_TRAVADO_MS` (o processo
 * morreu no meio) vira `failed` com nota — se a mensagem chegou a sair, ela
 * está no fio; se não saiu, o atendente vê o aviso e decide. Duplicar mensagem
 * para o cliente é pior que um aviso (a régua do `recover-stuck-messages`).
 *
 * Organização parada não tem a fila varrida (`idsDeOrgsParadas`): as linhas
 * esperam, e a porta de saída recusaria de todo jeito.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { roleAtLeast } from "@/lib/auth/types";
import { ENVIO_TRAVADO_MS, notaDeFalha } from "@/lib/inbox/mensagens-agendadas";
import { logger } from "@/lib/logger";
import { idsDeOrgsParadas, OrgNaoOperanteError } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";

export const dynamic = "force-dynamic";

/** Teto por rodada: a próxima rodada (1 min) pega o resto. */
const LOTE = 20;

interface Vencida {
  id: string;
  organization_id: string;
  conversation_id: string;
  body: string;
  created_by_user_id: string | null;
}

type Admin = ReturnType<typeof createAdminClient>;

function motivoDoErro(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 300 ? `${msg.slice(0, 297)}…` : msg || "erro desconhecido.";
}

async function marcarFalha(admin: Admin, linha: Vencida, motivo: string): Promise<void> {
  const agora = new Date().toISOString();
  await admin
    .from("scheduled_messages")
    .update({ status: "failed", error: motivo, updated_at: agora })
    .eq("id", linha.id)
    .eq("organization_id", linha.organization_id)
    .eq("status", "sending");
  // A nota fica no fio da conversa — o lugar onde quem agendou vai olhar.
  await admin.from("conversation_notes").insert({
    organization_id: linha.organization_id,
    conversation_id: linha.conversation_id,
    body: notaDeFalha(linha.body, motivo),
    created_by_user_id: null,
    created_by_name: "Sistema",
  });
}

async function quemAgendouAindaPode(admin: Admin, linha: Vencida): Promise<boolean> {
  if (!linha.created_by_user_id) return false;
  const { data } = await admin
    .from("user_organizations")
    .select("role")
    .eq("organization_id", linha.organization_id)
    .eq("user_id", linha.created_by_user_id)
    .is("revoked_at", null)
    .maybeSingle();
  const papel = (data as { role: string } | null)?.role ?? null;
  return roleAtLeast(papel, "agent");
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();
  const paradas = new Set(await idsDeOrgsParadas(admin));

  // 1) Destrava o que morreu no meio de um envio anterior — vira falha, nunca fila.
  const limiteTravado = new Date(agora.getTime() - ENVIO_TRAVADO_MS).toISOString();
  const { data: travadasData } = await admin
    .from("scheduled_messages")
    .select("id, organization_id, conversation_id, body, created_by_user_id")
    .eq("status", "sending")
    .lt("claimed_at", limiteTravado)
    .limit(LOTE);
  const travadas = (travadasData ?? []) as Vencida[];
  for (const linha of travadas) {
    await marcarFalha(
      admin,
      linha,
      "o envio foi interrompido no meio. Confira no fio se a mensagem saiu antes de mandar de novo.",
    );
  }

  // 2) As vencidas.
  const { data: vencidasData, error } = await admin
    .from("scheduled_messages")
    .select("id, organization_id, conversation_id, body, created_by_user_id")
    .eq("status", "scheduled")
    .lte("send_at", agora.toISOString())
    .order("send_at", { ascending: true })
    .limit(LOTE);
  if (error) {
    logger.error("[scheduled-messages] leitura falhou", { error: error.message, requestId });
    return fail("internal_error", "Failed to query scheduled messages.", 500, { requestId });
  }
  const vencidas = ((vencidasData ?? []) as Vencida[]).filter((l) => !paradas.has(l.organization_id));

  let enviadas = 0;
  let falhas = travadas.length;

  for (const linha of vencidas) {
    const { data: pega } = await admin
      .from("scheduled_messages")
      .update({ status: "sending", claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", linha.id)
      .eq("organization_id", linha.organization_id)
      .eq("status", "scheduled")
      .select("id")
      .maybeSingle();
    if (!pega) continue; // outro tick pegou, ou foi cancelada agora

    if (!(await quemAgendouAindaPode(admin, linha))) {
      await marcarFalha(admin, linha, "quem agendou não faz mais parte da equipe ou perdeu a permissão de enviar.");
      falhas++;
      continue;
    }

    try {
      const mensagem = await sendMessageHandler(
        admin,
        {
          organization_id: linha.organization_id,
          actor: { type: "user", id: linha.created_by_user_id as string },
          requestId: `scheduled-message:${linha.id}`,
          sourceJobId: linha.id,
        },
        { conversation_id: linha.conversation_id, type: "text", body: linha.body } as Parameters<
          typeof sendMessageHandler
        >[2],
      );
      await admin
        .from("scheduled_messages")
        .update({
          status: "sent",
          message_id: (mensagem as { id?: string } | null)?.id ?? null,
          sent_at: new Date().toISOString(),
          error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", linha.id)
        .eq("organization_id", linha.organization_id)
        .eq("status", "sending");
      enviadas++;
    } catch (err) {
      // A organização parou entre a leitura e o envio: a linha VOLTA para a
      // fila, sem nota. A varredura seguinte já filtra a org parada, então ela
      // espera em silêncio e sai quando a conta for reativada — marcar `failed`
      // aqui faria a suspensão sobreviver à reativação.
      if (err instanceof OrgNaoOperanteError) {
        await admin
          .from("scheduled_messages")
          .update({ status: "scheduled", claimed_at: null, updated_at: new Date().toISOString() })
          .eq("id", linha.id)
          .eq("organization_id", linha.organization_id)
          .eq("status", "sending");
        continue;
      }
      const motivo = motivoDoErro(err);
      logger.warn("[scheduled-messages] envio falhou", {
        organization_id: linha.organization_id,
        scheduled_message_id: linha.id,
        error: motivo,
        requestId,
      });
      await marcarFalha(admin, linha, motivo);
      falhas++;
    }
  }

  // Rodada que não enviou nem falhou nada não é mutação — não audita.
  if (enviadas > 0 || falhas > 0) {
    void audit({
      action: "message.scheduled_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { examinadas: vencidas.length, enviadas, falhas },
      requestId,
    });
  }

  return ok({ examinadas: vencidas.length, enviadas, falhas }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
