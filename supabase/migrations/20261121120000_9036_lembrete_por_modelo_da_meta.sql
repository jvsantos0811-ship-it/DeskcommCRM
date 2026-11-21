-- manifest: PC-045 (fork) — Lembrete da agenda fora da janela de 24 h pelo MODELO aprovado da Meta: `calendar_event_types.reminder_meta_template_name` e `reminder_meta_template_language` (vazio = comportamento de sempre: o número oficial pula o degrau fora da janela).
-- ---- Lembrete por modelo da Meta (migration 9036) ----
--
-- PC-045. No número oficial (Meta, parceiro, Datafy) o texto livre só sai
-- dentro da janela de 24 h da última mensagem do cliente; a véspera quase
-- sempre cai fora, e o cron `agenda-reminder` pulava com
-- `canal_fora_da_janela_24h`. Com o modelo escolhido no tipo, o degrau fora da
-- janela sai como modelo aprovado (corpo {{1}} nome, {{2}} dia, {{3}} hora,
-- {{4}} local). NULL = nada muda.
--
-- Distinto de `reminder_template_name` (0177), que o cron usa como ATALHO de
-- uma mensagem pronta da organização (`message_templates`), não como modelo da
-- Meta.

alter table public.calendar_event_types
  add column if not exists reminder_meta_template_name text,
  add column if not exists reminder_meta_template_language text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'calendar_event_types_reminder_meta_template_name_check') then
    alter table public.calendar_event_types
      add constraint calendar_event_types_reminder_meta_template_name_check
      check (reminder_meta_template_name is null or reminder_meta_template_name ~ '^[a-z0-9_]{1,512}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calendar_event_types_reminder_meta_template_language_check') then
    alter table public.calendar_event_types
      add constraint calendar_event_types_reminder_meta_template_language_check
      check (reminder_meta_template_language is null or reminder_meta_template_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$');
  end if;
end $$;

comment on column public.calendar_event_types.reminder_meta_template_name is
  'PC-045: nome do modelo APROVADO da Meta para o lembrete fora da janela de 24 h (número oficial). Corpo: {{1}} nome, {{2}} dia, {{3}} hora, {{4}} local. NULL = o degrau fora da janela é pulado, como sempre.';
comment on column public.calendar_event_types.reminder_meta_template_language is
  'PC-045: idioma do modelo da Meta (ex.: pt_BR). NULL = pt_BR.';
