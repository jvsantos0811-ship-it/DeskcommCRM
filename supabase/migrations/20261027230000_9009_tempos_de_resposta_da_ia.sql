-- manifest: **Tempo de resposta da IA por turno (PC-002, Fase 1, item 5).** Tabela `tempos_de_resposta_da_ia`: uma linha por turno de resposta do agente, com a hora da última mensagem do cliente, a hora em que a 1ª bolha saiu, a espera em ms, quantas mensagens do cliente o turno respondeu, quantas bolhas ficaram retidas (o cliente escreveu no meio) e quantas ferramentas falharam. Sem conteúdo de mensagem. Leitura por organização (RLS); escrita só pelo worker (service_role). Conversa em cascata (a medida não sobrevive à conversa apagada); agente `on delete set null`. Número 9009, faixa do fork. Idempotente; apêndice igual no `baseline.sql`.
-- 9009: tempo de resposta da IA por turno.
--
-- Até aqui, "a IA está lenta?" se respondia cruzando `messages`, `job_queue` e
-- `llm_calls` à mão (medição de 27/10/2026: ~45 s do registro da mensagem à
-- 1ª bolha). Esta tabela guarda o número já calculado, por turno, para a tela
-- e a exportação lerem por conversa e por agente. Só horários e contagens:
-- nada do que o cliente ou a IA disseram.
--
-- Escrita local pelo worker, fora de qualquer gatilho; nenhum HTTP.

create table if not exists public.tempos_de_resposta_da_ia (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  agent_id uuid references public.ai_agents(id) on delete set null,
  -- O job do turno. Sem FK: a fila é podada, a medida fica.
  job_id uuid not null,
  -- A última mensagem do cliente que o turno respondeu (chegada ao CRM).
  ultima_msg_cliente_em timestamptz,
  -- Quando a 1ª bolha saiu. Nulo = o turno não respondeu (descartado, passou
  -- para a equipe, erro).
  primeira_bolha_em timestamptz,
  espera_ms integer,
  mensagens_respondidas smallint not null default 0,
  bolhas_retidas smallint not null default 0,
  ferramentas_falharam smallint not null default 0,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tempos_de_resposta_da_ia_job_unico'
  ) then
    alter table public.tempos_de_resposta_da_ia
      add constraint tempos_de_resposta_da_ia_job_unico unique (organization_id, job_id);
  end if;
end $$;

create index if not exists tempos_de_resposta_da_ia_conversa_idx
  on public.tempos_de_resposta_da_ia (organization_id, conversation_id, created_at desc);
create index if not exists tempos_de_resposta_da_ia_agente_idx
  on public.tempos_de_resposta_da_ia (organization_id, agent_id, created_at desc);

alter table public.tempos_de_resposta_da_ia enable row level security;
drop policy if exists tenant_isolation_tempos_de_resposta_da_ia_select on public.tempos_de_resposta_da_ia;
create policy tenant_isolation_tempos_de_resposta_da_ia_select on public.tempos_de_resposta_da_ia
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.tempos_de_resposta_da_ia from public, anon, authenticated;
grant select on public.tempos_de_resposta_da_ia to authenticated;
grant all on public.tempos_de_resposta_da_ia to service_role;
