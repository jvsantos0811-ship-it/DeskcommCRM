import type pg from "pg";
import { reconcileAcceptedSend } from "../edge/crm/send-ledger";
import type { JobRow } from "../queue/queue";
import { claimOfJob } from "../queue/claim";
import type { CrmEdgeConfig } from "../edge/crm/mcp-client";
import { createRuntimeSendChannel, type RuntimeSendChannel } from "@/lib/channels/runtime";
import type { Logger } from "../obs/logger";
import { runBeforeSend } from "../guardrails/before-send";
import { deriveLgpdFromContact, type LgpdContactFields } from "../guardrails/lgpd/legal-basis";
import { withServiceJob } from "@/lib/atendimento/fronteira-server";
import { parseServiceBoundary, StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import {
  assertMeetingDeliveryPg,
  assertMeetingDeliveryReceiptPg,
  MeetingDeliveryBlockedError,
} from "@/lib/agenda/meet-delivery";
import { meetVideoUrl } from "@/lib/agenda/google/meet";
import { textoDoCompromisso, type MotivoDaEntrega } from "@/lib/agenda/texto-do-compromisso";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import {
  BUCKET_DO_VIDEO,
  caminhoNaConversa,
  videoPertenceAOrg,
} from "@/lib/agenda/video-aquecimento";
import { createAdminClient } from "@/lib/supabase/admin";

/** Copia o vídeo da organização para a pasta da conversa. `true` = está no destino. */
export type CopiarVideo = (origem: string, destino: string) => Promise<boolean>;

function copiarVideoNoStorage(log: Logger): CopiarVideo {
  return async (origem, destino) => {
    const { error } = await createAdminClient()
      .storage.from(BUCKET_DO_VIDEO)
      .copy(origem, destino);
    if (!error) return true;
    // Já copiado antes (retentativa do mesmo compromisso): o arquivo está lá.
    if (/already exists/i.test(error.message) || (error as { statusCode?: string }).statusCode === "409") return true;
    log.warn("vídeo de aquecimento não copiado para a conversa", { detalhe: error.message.slice(0, 120) });
    return false;
  };
}

/**
 * PC-045 parte 2 — o vídeo de aquecimento da organização, logo depois da
 * confirmação do agendamento. Só na 1ª confirmação (não na remarcação), só
 * quando a confirmação SAIU (então passou pela janela, pelo opt-out e pela LGPD
 * agora há pouco) e só com vídeo cadastrado. É a 2ª mensagem do MESMO job: a
 * idempotência por (job, posição) garante uma vez por compromisso. Melhor
 * esforço — falha aqui nunca derruba a confirmação, que já saiu.
 */
export async function enviarVideoDeAquecimento(
  pool: pg.Pool,
  log: Logger,
  copiar: CopiarVideo,
  p: {
    orgId: string;
    conversationId: string;
    appointmentId: string;
    contactId: string;
    jobId: string;
    jobClaim: NonNullable<ReturnType<typeof claimOfJob>>;
    channel: RuntimeSendChannel;
  },
): Promise<void> {
  try {
    const { rows } = await pool.query<{ storage_path: string; mime: string; texto: string | null }>(
      "select storage_path, mime, texto from agenda_video_aquecimento where organization_id = $1",
      [p.orgId],
    );
    const video = rows[0];
    if (!video || !videoPertenceAOrg(video.storage_path, p.orgId)) return;
    const destino = caminhoNaConversa(p.orgId, p.conversationId, p.appointmentId, video.storage_path);
    if (!(await copiar(video.storage_path, destino))) return;
    const r = await p.channel.send({
      tenantId: p.orgId,
      leadId: p.contactId,
      jobId: p.jobId,
      jobClaim: p.jobClaim,
      seq: 2,
      conversationId: p.conversationId,
      body: (video.texto ?? "").trim(),
      media: { storagePath: destino, mime: video.mime, type: "video" },
    });
    if (r.kind !== "sent" && r.kind !== "already_sent") {
      log.warn("vídeo de aquecimento não saiu", { desfecho: r.kind });
    }
  } catch (err) {
    log.warn("vídeo de aquecimento falhou — a confirmação já saiu", {
      detalhe: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}

export function createMeetDeliveryHandler(deps: {
  crmCfg: CrmEdgeConfig;
  log: Logger;
  channel?: (pool: pg.Pool) => RuntimeSendChannel;
  sleep?: (ms: number) => Promise<void>;
  /** Injeção para o teste; em produção copia no Storage (`whatsapp-media`). */
  copiarVideo?: CopiarVideo;
}) {
  return async (job: JobRow, pool: pg.Pool) => {
    const claim = claimOfJob(job);
    if (!claim || !job.contact_id || job.kind !== "transactional_delivery")
      throw new StaleServiceBoundaryError();
    const context = { organizationId: job.organization_id, jobId: job.id, jobClaim: claim };
    const settle = async (state: string, retryAt?: Date) => {
      await pool.query("select fn_meet_delivery_settle($1,$2,$3,$4,$5,$6)", [
        job.organization_id,
        job.id,
        claim.worker_id,
        claim.acquired_at,
        state,
        retryAt?.toISOString() ?? null,
      ]);
    };
    try {
      await withServiceJob(pool, job, async () => {
        await assertMeetingDeliveryReceiptPg(pool, context);
        if (
          await reconcileAcceptedSend(pool, {
            tenantId: job.organization_id,
            jobId: job.id,
            seq: 1,
          })
        ) {
          await settle("sent");
          return;
        }
        await assertMeetingDeliveryPg(pool, context);
        const boundary = parseServiceBoundary(job.payload.service_boundary)!;
        const { rows } = await pool.query<
          LgpdContactFields & {
            meeting_url: string;
            location_kind: string;
            starts_at: string;
            time_zone: string;
            channel_session_id: string;
            daily_message_limit: number | null;
            archived_at: string | null;
            contact_locale: string | null;
            organization_locale: string;
          }
        >(
          `select a.meeting_url,a.location_kind,a.starts_at,a.time_zone,c.source,c.consent,c.is_anonymized,c.locale as contact_locale,o.locale as organization_locale,v.channel_session_id,s.daily_message_limit,to_jsonb(s)->>'archived_at' as archived_at
           from calendar_appointments a join contacts c on c.organization_id=a.organization_id and c.id=a.contact_id
           join organizations o on o.id=a.organization_id
           join conversations v on v.organization_id=a.organization_id and v.contact_id=c.id and v.id=$3
           join channel_sessions s on s.organization_id=v.organization_id and s.id=v.channel_session_id
           where a.organization_id=$1 and a.id=$2 and a.contact_id=$4`,
          [
            job.organization_id,
            job.payload.appointment_id,
            boundary.conversation_id,
            job.contact_id,
          ],
        );
        const row = rows[0];
        const url = meetVideoUrl(row?.meeting_url);
        // ⛔ A EXIGÊNCIA DE LINK VALE SÓ ONDE O LOCAL É O MEET, e a assimetria é
        // deliberada: visita e ligação não têm sala, e recusar a entrega delas
        // por falta de link era o que mantinha compromisso presencial fora do
        // CRM. Onde o local É o Meet, o link continua obrigatório — mandar uma
        // reunião sem como entrar nela é pior que não mandar.
        const ehMeet = row?.location_kind === "google_meet";
        if (!row || row.archived_at || (ehMeet && !url)) {
          await settle("blocked:channel");
          return;
        }
        const channel =
          deps.channel?.(pool) ??
          createRuntimeSendChannel(pool, {
            ...deps.crmCfg,
            agentActorId: "agent-engine:meet-delivery",
          });
        const result = await runBeforeSend({
          pool,
          log: deps.log,
          tenantId: job.organization_id,
          leadId: job.contact_id!,
          jobId: job.id,
          meetingDelivery: context,
          channelSessionId: row.channel_session_id,
          crmDailyLimit: row.daily_message_limit,
          body: textoDoCompromisso({
            // O motivo viaja no payload do job, posto por quem enfileirou. Sem
            // ele, `primeiro_envio` — o comportamento de antes desta mudança, e
            // o certo para toda entrega que já estava na fila.
            motivo: (job.payload.motivo as MotivoDaEntrega | undefined) ?? "primeiro_envio",
            startsAt: row.starts_at,
            timeZone: row.time_zone,
            // Sem Meet não há link, e o texto não inventa um.
            url: ehMeet ? url : null,
            idioma: normalizarIdioma(row.contact_locale ?? row.organization_locale),
          }),
          optedOutThisTurn: false,
          now: new Date(),
          lgpd: deriveLgpdFromContact(row, false),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          send: async (body) => {
            await assertMeetingDeliveryPg(pool, context);
            return channel.send({
              tenantId: job.organization_id,
              leadId: job.contact_id,
              jobId: job.id,
              jobClaim: claim,
              seq: 1,
              conversationId: boundary.conversation_id,
              body,
            });
          },
        });
        if (result.status === "vetoed") {
          const reason =
            result.code === "contato_bloqueado"
              ? "opt_out"
              : result.code.startsWith("lgpd_")
                ? "lgpd"
                : result.code === "messaging_window_closed"
                  ? "limits"
                  : "guardrail";
          await settle(result.nextAllowedAt ? "queued" : `blocked:${reason}`, result.nextAllowedAt);
          return;
        }
        switch (result.outcome.kind) {
          case "sent":
          case "already_sent":
            if (((job.payload.motivo as MotivoDaEntrega | undefined) ?? "primeiro_envio") === "primeiro_envio") {
              await enviarVideoDeAquecimento(pool, deps.log, deps.copiarVideo ?? copiarVideoNoStorage(deps.log), {
                orgId: job.organization_id,
                conversationId: boundary.conversation_id,
                appointmentId: String(job.payload.appointment_id),
                contactId: job.contact_id!,
                jobId: job.id,
                jobClaim: claim,
                channel,
              });
            }
            await settle("sent");
            break;
          case "queued":
            await settle("queued");
            break;
          case "blocked":
            await assertMeetingDeliveryPg(pool, context);
            await settle("blocked:opt_out");
            break;
          default:
            await assertMeetingDeliveryPg(pool, context);
            await settle("retry");
        }
      });
    } catch (error) {
      await settle(
        error instanceof MeetingDeliveryBlockedError
          ? `blocked:${error.reason}`
          : error instanceof StaleServiceBoundaryError
            ? "stale"
            : "retry",
      );
    }
  };
}

/**
 * ⚠️ MANTIDA, e agora DELEGANDO.
 *
 * Ela é exportada e há teste em cima dela. Reescrever o corpo aqui criaria DUAS
 * réguas para o mesmo texto, e duas réguas divergem na primeira mudança.
 * `url` obrigatório aqui, porque todo chamador atual tem link — quem não tem
 * chama `textoDoCompromisso` direto.
 */
export function meetingDeliveryBody(
  startsAt: string,
  timeZone: string,
  url: string,
  idioma: Idioma,
): string {
  return textoDoCompromisso({ startsAt, timeZone, url, idioma });
}
