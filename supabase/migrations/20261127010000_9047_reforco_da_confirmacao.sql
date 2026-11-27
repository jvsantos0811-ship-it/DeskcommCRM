-- manifest: PC-064: reforço da confirmação depois de marcar (2ª pergunta só para quem não confirmou), com o carimbo do horário para o qual saiu e o instante em que a 1ª saiu

-- O carimbo do REFORÇO da confirmação (PC-064): a 2ª pergunta, só para quem não
-- confirmou depois da 1ª. Como a 1ª, sai uma vez por HORÁRIO: guarda o
-- `starts_at` para o qual saiu, e a remarcação para outro horário volta a armar.
-- E a 1ª passa a gravar QUANDO saiu: é o piso das duas contas do reforço (nunca
-- a menos de uma hora dela; resposta do cliente depois dela = não pergunta de
-- novo). Nulo nas que saíram antes desta coluna: o cron usa a hora marcada da 1ª.
-- A chave mora no jsonb `calendar_event_types.post_booking_sequence.reforco`,
-- desligada de fábrica (`lerSequencia`, `lib/agenda/sequencia.ts`).
alter table public.calendar_appointments add column if not exists confirmation_sent_at timestamptz;
alter table public.calendar_appointments add column if not exists confirmation_retry_sent_for timestamptz;
comment on column public.calendar_appointments.confirmation_sent_at is
  'PC-064: quando a 1ª confirmação em hora fixa foi reivindicada. Nulo = ainda não saiu, ou saiu antes desta coluna.';
comment on column public.calendar_appointments.confirmation_retry_sent_for is
  'PC-064: o starts_at para o qual o reforço da confirmação (2ª pergunta) já saiu. Diferente do starts_at atual = ainda não saiu para o horário novo.';
