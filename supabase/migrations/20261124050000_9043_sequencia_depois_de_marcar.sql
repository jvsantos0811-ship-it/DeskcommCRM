-- manifest: PC-052 parte 3: sequência depois de marcar por tipo de atendimento (vídeo e imagens na noite da marcação, confirmação em hora fixa), com o carimbo do que já saiu no compromisso e o bucket privado da mídia de aquecimento por organização

-- A chave e a configuração moram no TIPO de atendimento, como o lembrete. Chave
-- desligada = nada sai (o de sempre). O jsonb tem schema único em
-- `lib/agenda/sequencia.ts` (`lerSequencia` nunca lança); ninguém lê o caminho
-- dele direto.
alter table public.calendar_event_types add column if not exists post_booking_sequence_enabled boolean not null default false;
alter table public.calendar_event_types add column if not exists post_booking_sequence jsonb not null default '{}'::jsonb;
comment on column public.calendar_event_types.post_booking_sequence_enabled is
  'PC-052: liga a sequência depois de marcar deste tipo (cron agenda-sequencia). Desligado = nada sai.';
comment on column public.calendar_event_types.post_booking_sequence is
  'PC-052: horários e textos da sequência (aquecimento e confirmação). Schema em lib/agenda/sequencia.ts.';

-- O carimbo do que já saiu, gravado ANTES do envio (envio em dobro é pior que
-- não-envio, a mesma régua do lembrete):
--  - o aquecimento sai uma vez por compromisso;
--  - a confirmação sai uma vez por HORÁRIO: guarda o `starts_at` para o qual saiu,
--    e a remarcação para outro horário volta a armar.
alter table public.calendar_appointments add column if not exists warmup_sent_at timestamptz;
alter table public.calendar_appointments add column if not exists confirmation_sent_for timestamptz;
comment on column public.calendar_appointments.warmup_sent_at is
  'PC-052: quando o aquecimento (vídeo e imagens) foi reivindicado para este compromisso. Nulo = ainda não saiu.';
comment on column public.calendar_appointments.confirmation_sent_for is
  'PC-052: o starts_at para o qual a confirmação em hora fixa já saiu. Diferente do starts_at atual = a confirmação do horário novo ainda não saiu.';

-- A mídia de aquecimento da organização (um vídeo e até três imagens). Privado;
-- só o service_role lê e grava, pela rota `app/api/v1/agenda/midia`. Teto e
-- tipos iguais aos de `lib/agenda/midia-do-aquecimento.ts`. Sem policy em
-- `storage.objects`. Idempotente.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('agenda-media', 'agenda-media', false, 16777216, array['video/mp4', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

notify pgrst, 'reload schema';
