-- manifest: **Registro de recusas e bloqueios da IA (PC-002b e PC-003).** Tabela `recusas_da_ia`: uma linha cada vez que o sistema barra a IA — mensagem inteira bloqueada por uma trava de envio (e o cliente recebeu a frase segura), ferramenta de etapa recusada por campo obrigatório vazio, ganho recusado, modo conservador. Guarda organização, agente, versão, contato, negócio, ferramenta, trava, código, etapa pedida, campos que faltaram e um motivo legível; NUNCA o texto da conversa (esse fica no caso humano, que a LGPD já alcança). Lida pela aba Execuções do agente. Leitura por organização (RLS); escrita só pelo servidor/worker (service_role). Número 9010, faixa do fork. Idempotente; apêndice igual no `baseline.sql`.
-- 9010: recusas e bloqueios da IA.
--
-- Até aqui, quando uma trava barrava a mensagem inteira, o rastro ficava em
-- `before_send_traces` e numa atividade da linha do tempo — e a aba Execuções
-- do agente (que lê `llm_calls`) não mostrava nada. Quem investigava "por que o
-- cliente ficou sem resposta?" olhava a aba certa e não achava a causa. Esta
-- tabela é o registro que a aba lê, e serve também às recusas de etapa e de
-- ganho (PC-003).
--
-- Sem conteúdo de mensagem: só ids, nomes técnicos e o motivo que a regra
-- escreveu. Escrita local pelo servidor, fora de qualquer gatilho; nenhum HTTP.

create table if not exists public.recusas_da_ia (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid references public.ai_agents(id) on delete set null,
  agent_version_id uuid references public.ai_agent_versions(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  lead_id uuid references public.crm_leads(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  -- envio_bloqueado: uma trava barrou a mensagem inteira (PC-002b);
  -- etapa_recusada: mover de etapa foi recusado (campo vazio, modo conservador);
  -- ganho_recusado: a IA tentou marcar ganho (PC-003: ganho só por evento);
  -- assinatura_recusada: aviso de assinatura de provedor inválido (PC-003).
  tipo text not null,
  ferramenta text,
  trava text,
  codigo text,
  etapa_pedida text,
  campos_faltantes jsonb not null default '[]'::jsonb,
  motivo text,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'recusas_da_ia_tipo_check'
  ) then
    alter table public.recusas_da_ia
      add constraint recusas_da_ia_tipo_check
      check (tipo in ('envio_bloqueado', 'etapa_recusada', 'ganho_recusado', 'assinatura_recusada'));
  end if;
end $$;

create index if not exists recusas_da_ia_agente_idx
  on public.recusas_da_ia (organization_id, agent_id, created_at desc);
create index if not exists recusas_da_ia_contato_idx
  on public.recusas_da_ia (organization_id, contact_id, created_at desc);

alter table public.recusas_da_ia enable row level security;
drop policy if exists tenant_isolation_recusas_da_ia_select on public.recusas_da_ia;
create policy tenant_isolation_recusas_da_ia_select on public.recusas_da_ia
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.recusas_da_ia from public, anon, authenticated;
grant select on public.recusas_da_ia to authenticated;
grant all on public.recusas_da_ia to service_role;
