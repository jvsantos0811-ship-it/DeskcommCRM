-- manifest: **Mensagem agendada na conversa.** Cria `scheduled_messages` — o texto que o atendente escreveu para sair numa data e hora futuras, numa conversa da organização, com o estado `scheduled/sending/sent/failed/cancelled`, quem agendou, a mensagem que nasceu do envio e o motivo da falha. RLS de leitura por organização (`fn_user_org_ids`); escrita só pelo servidor (rotas `/api/v1/conversations/:id/scheduled-messages` e `/api/v1/scheduled-messages/:id`, que filtram `organization_id` de fonte confiável). Quem envia é o cron `scheduled-messages` (a cada minuto), pela MESMA porta de saída de toda mensagem (`sendMessageHandler`), em nome de quem agendou e depois de reconferir que a pessoa ainda é membro com papel de atendente ou acima. Número 9001: faixa do fork, longe da numeração do projeto original. Idempotente; apêndice igual no `baseline.sql`.
-- 9001: mensagens agendadas por conversa.
--
-- ─── O que faltava ──────────────────────────────────────────────────────────
--
-- O atendente que combina "te mando o link amanhã às 9h" tinha duas saídas:
-- lembrar e mandar na mão, ou criar uma tarefa para lembrar de mandar. As duas
-- dependem de alguém estar diante da tela na hora — e é exatamente o recado
-- que se combina para fora do expediente que mais se perde.
--
-- ─── Por que só TEXTO nesta primeira versão ─────────────────────────────────
--
-- Anexo agendado guardaria um caminho de Storage por dias, e a retenção de
-- mídia (`storage-redaction`) e a LGPD (redação de contato) não sabem que
-- alguém espera aquele arquivo no futuro. Texto não tem essa dívida. Anexo
-- entra quando a retenção souber de agendamento.
--
-- ─── Por que a escrita é só do servidor ─────────────────────────────────────
--
-- O mesmo desenho de `channel_schedules` (0626): `authenticated` só LÊ, pela
-- policy de organização; criar e cancelar passam pelas rotas, que validam o
-- papel, o escopo da conversa (pelo client de RLS do usuário) e auditam. Uma
-- policy de INSERT deixaria o navegador agendar em conversa fora do escopo do
-- atendente (`own*`), que a leitura pela RLS da conversa barra na rota.

create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  body text not null,
  send_at timestamptz not null,
  status text not null default 'scheduled',
  created_by_user_id uuid references auth.users(id) on delete set null,
  -- A mensagem que nasceu do envio: o elo para a linha do fio.
  message_id uuid references public.messages(id) on delete set null,
  -- Por que não saiu, em português, para a tela mostrar.
  error text,
  -- Momento em que o cron pegou a linha (`sending`): o que destrava um envio
  -- interrompido no meio sem mandar em dobro.
  claimed_at timestamptz,
  sent_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'scheduled_messages_status_check'
  ) then
    alter table public.scheduled_messages
      add constraint scheduled_messages_status_check
      check (status in ('scheduled', 'sending', 'sent', 'failed', 'cancelled'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'scheduled_messages_body_check'
  ) then
    alter table public.scheduled_messages
      add constraint scheduled_messages_body_check
      check (char_length(btrim(body)) between 1 and 4096);
  end if;
end;
$$;

-- O que o cron lê por rodada: só as que estão na fila, pela hora.
create index if not exists scheduled_messages_fila_idx
  on public.scheduled_messages (send_at)
  where status = 'scheduled';
-- O que a tela lê: as agendadas de UMA conversa.
create index if not exists scheduled_messages_conversa_idx
  on public.scheduled_messages (organization_id, conversation_id, send_at);

alter table public.scheduled_messages enable row level security;
drop policy if exists tenant_isolation_scheduled_messages_select on public.scheduled_messages;
create policy tenant_isolation_scheduled_messages_select on public.scheduled_messages
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.scheduled_messages from public, anon, authenticated;
grant select on public.scheduled_messages to authenticated;
grant all on public.scheduled_messages to service_role;
