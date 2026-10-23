-- manifest: **Chat interno da equipe.** Cria `team_chat_messages` (sala `geral` da organização e conversa a dois `dm:<uuid>:<uuid>`, com nome do remetente desnormalizado) e `team_chat_reads` (até onde cada pessoa leu cada sala, para o contador do menu). RLS: a sala geral é da organização inteira; a conversa a dois, só dos dois — e o Realtime (tabela entra na publicação `supabase_realtime`) obedece a mesma policy. Escrita só pelo servidor (`/api/v1/team-chat/*`). Faixa do fork (9002). Idempotente; apêndice igual no `baseline.sql`.
-- 9002: chat interno da equipe.
--
-- A equipe combinava pelo WhatsApp pessoal o que acontecia dentro do CRM —
-- e o combinado ficava fora do sistema, no celular de cada um. Aqui a
-- conversa interna mora junto do trabalho, com isolamento por organização.

create table if not exists public.team_chat_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- 'geral' (a sala da equipe inteira) ou 'dm:<menor uuid>:<maior uuid>'
  -- (conversa entre duas pessoas, ids em ordem para a sala ser uma só).
  room text not null,
  sender_user_id uuid references auth.users(id) on delete set null,
  -- Desnormalizado de propósito (o mesmo de `conversation_notes.created_by_name`):
  -- o nome sobrevive à saída da pessoa e a lista não paga um lookup por linha.
  sender_name text,
  body text not null,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'team_chat_messages_room_check') then
    alter table public.team_chat_messages
      add constraint team_chat_messages_room_check
      check (room = 'geral' or room ~ '^dm:[0-9a-f-]{36}:[0-9a-f-]{36}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'team_chat_messages_body_check') then
    alter table public.team_chat_messages
      add constraint team_chat_messages_body_check
      check (char_length(btrim(body)) between 1 and 4000);
  end if;
end;
$$;

create index if not exists team_chat_messages_sala_idx
  on public.team_chat_messages (organization_id, room, created_at desc);

-- Quem vê o quê: a sala geral, toda a organização; a conversa a dois, só os
-- dois. A RLS decide também o que o Realtime entrega (postgres_changes respeita
-- a policy de SELECT), então a mensagem privada não chega ao socket de terceiro.
alter table public.team_chat_messages enable row level security;
drop policy if exists tenant_isolation_team_chat_messages_select on public.team_chat_messages;
create policy tenant_isolation_team_chat_messages_select on public.team_chat_messages
  for select using (
    organization_id in (select public.fn_user_org_ids())
    and (
      room = 'geral'
      or split_part(room, ':', 2) = (select auth.uid())::text
      or split_part(room, ':', 3) = (select auth.uid())::text
    )
  );
revoke all on public.team_chat_messages from public, anon, authenticated;
grant select on public.team_chat_messages to authenticated;
grant all on public.team_chat_messages to service_role;

-- Até onde cada pessoa leu cada sala: o que acende o contador no menu.
create table if not exists public.team_chat_reads (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  room text not null,
  last_read_at timestamptz not null default now(),
  primary key (organization_id, user_id, room)
);
alter table public.team_chat_reads enable row level security;
drop policy if exists tenant_isolation_team_chat_reads_select on public.team_chat_reads;
create policy tenant_isolation_team_chat_reads_select on public.team_chat_reads
  for select using (
    organization_id in (select public.fn_user_org_ids())
    and user_id = (select auth.uid())
  );
revoke all on public.team_chat_reads from public, anon, authenticated;
grant select on public.team_chat_reads to authenticated;
grant all on public.team_chat_reads to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_chat_messages'
  ) then
    execute 'alter publication supabase_realtime add table public.team_chat_messages';
  end if;
end $$;
