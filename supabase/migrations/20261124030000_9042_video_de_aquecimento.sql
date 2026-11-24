-- manifest: PC-045 parte 2 — vídeo de aquecimento por organização (`agenda_video_aquecimento`): um vídeo (mp4 até 16 MB, no bucket privado de mídia) e um texto curto opcional, enviados uma vez por compromisso logo depois da confirmação do agendamento, dentro da janela. Trocar vale para os próximos agendamentos; sem linha = como antes. Só o servidor lê e escreve (RLS sem policy)
-- 9042: vídeo de aquecimento (PC-045, parte 2).
--
-- Decisão do João (22/11/2026 09h30): "Vídeo de aquecimento será configurado
-- por organização e com a opção de trocar quando quiser com facilidade."
--
--   * Uma linha por organização. Sem linha, nada muda: a confirmação do
--     agendamento sai sozinha, como antes.
--   * O arquivo mora no bucket privado `whatsapp-media`, em
--     `<org>/aquecimento/<uuid>.mp4`. Na hora de enviar, ele é copiado para a
--     pasta da conversa (`<org>/<conversa>/aquecimento-<compromisso>.mp4`) — a
--     regra de posse do envio exige que a mídia seja da conversa — e sai pelo
--     mesmo caminho de toda mídia, com URL assinada curta.
--   * Enviado UMA vez por compromisso: é a 2ª mensagem do mesmo job da
--     confirmação (idempotência por job e posição), só na 1ª confirmação (não
--     na remarcação), e só quando a confirmação saiu — dentro da janela de
--     disparo e de 24 h, com o contato sem opt-out.
--   * Trocar o vídeo vale para os próximos agendamentos; nada reenvia.
--
-- Sem dado de lead: o vídeo é do escritório. Sem dado migrado. Número 9042,
-- faixa do fork. Idempotente; apêndice igual no `baseline.sql`.

create table if not exists public.agenda_video_aquecimento (
  organization_id  uuid primary key references public.organizations(id) on delete cascade,
  storage_path     text not null check (storage_path ~ '^[0-9a-f-]{36}/aquecimento/[A-Za-z0-9._-]{1,120}$'),
  mime             text not null check (mime in ('video/mp4', 'video/3gpp')),
  bytes            integer not null check (bytes > 0 and bytes <= 16777216),
  texto            text check (texto is null or char_length(texto) <= 500),
  trocado_em       timestamptz not null default now(),
  trocado_por      uuid,
  updated_at       timestamptz not null default now()
);

comment on table public.agenda_video_aquecimento is
  'PC-045 parte 2 (migration 9042): o vídeo de aquecimento da organização (mp4 até 16 MB no bucket whatsapp-media, pasta <org>/aquecimento) e um texto curto opcional, enviados uma vez por compromisso logo depois da confirmação do agendamento. Sem linha = como antes. Só o servidor: RLS sem policy.';

alter table public.agenda_video_aquecimento enable row level security;
revoke all on public.agenda_video_aquecimento from public, anon, authenticated;
grant select, insert, update, delete on public.agenda_video_aquecimento to service_role;

drop trigger if exists trg_agenda_video_aquecimento_touch on public.agenda_video_aquecimento;
create trigger trg_agenda_video_aquecimento_touch
  before update on public.agenda_video_aquecimento
  for each row execute function public.fn_touch_updated_at();
