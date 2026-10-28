-- manifest: **Trava de etapa e de ganho para a IA (PC-003).** (1) `ai_agent_versions.estado_do_funil_ligado`: a chave da ferramenta `update_lead_state` por agente — versões que já existem ficam LIGADAS (comportamento de hoje), versões novas nascem DESLIGADAS; (2) `ai_agent_versions.modo_conservador`: com ele ligado a IA não move o negócio para etapas marcadas "só pessoa move"; (3) `crm_stages.so_pessoa_move`; (4) `crm_leads.status_dos_campos` (jsonb chave do campo → CONFIRMADO|NEGADO|NAO_SABE|NAO_SE_APLICA|PENDENTE|CONTRADITORIO), o status de cada campo de qualificação ao lado do dado; (5) `crm_assinaturas_confirmadas`: o registro de cada ganho por assinatura (pessoa gerente ou provedor), com data e quem registrou; (6) `assinatura_webhook_chaves`: a chave por organização do aviso `contrato.assinado` de um provedor de assinatura (segredo guardado só como hash SHA-256; nenhum provedor ligado). Leitura por organização (RLS) nas tabelas novas de registro; a de chaves é só do servidor. Número 9011, faixa do fork. Idempotente; apêndice igual no `baseline.sql`.
-- 9011: trava de etapa e de ganho para a IA.
--
-- Até aqui o prompt era a única coisa entre a IA e um "Fechado" com a
-- qualificação incompleta: `update_lead_state` ficava sempre disponível e
-- levava o card até ganho. A métrica-norte (contratos assinados por lead) era
-- inflável. Daqui em diante o ganho só acontece por evento de assinatura.
--
-- Nenhum gatilho faz HTTP; nenhuma coluna existente é renomeada ou apagada.

-- (1) A chave de `update_lead_state` por versão do agente. A ordem dos dois
-- comandos é a garantia do critério A5: o `add column ... default true`
-- preenche as versões que JÁ existem como ligadas; o `set default false` vale
-- daí em diante, para as versões novas. Reaplicado (update.sh), o primeiro é
-- no-op (coluna existe) e o segundo reafirma o mesmo default.
alter table public.ai_agent_versions
  add column if not exists estado_do_funil_ligado boolean not null default true;
alter table public.ai_agent_versions
  alter column estado_do_funil_ligado set default false;

-- (2) Modo conservador por versão do agente (desligado por padrão).
alter table public.ai_agent_versions
  add column if not exists modo_conservador boolean not null default false;

-- (3) Etapa que só uma pessoa move (o modo conservador da IA respeita).
alter table public.crm_stages
  add column if not exists so_pessoa_move boolean not null default false;

-- (4) O status de cada campo de qualificação do negócio, ao lado do dado.
alter table public.crm_leads
  add column if not exists status_dos_campos jsonb not null default '{}'::jsonb;

-- (5) Ganho por assinatura confirmada.
create table if not exists public.crm_assinaturas_confirmadas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  -- O dia em que o contrato foi assinado (o que a pessoa informou ou o provedor mandou).
  data_assinatura date not null,
  -- pessoa: gerente clicou "Assinatura confirmada"; provedor: aviso contrato.assinado.
  origem text not null,
  registrado_por_user_id uuid references auth.users(id) on delete set null,
  provedor text,
  documento_id text,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'crm_assinaturas_confirmadas_origem_check'
  ) then
    alter table public.crm_assinaturas_confirmadas
      add constraint crm_assinaturas_confirmadas_origem_check
      check (origem in ('pessoa', 'provedor'));
  end if;
end $$;

create index if not exists crm_assinaturas_confirmadas_lead_idx
  on public.crm_assinaturas_confirmadas (organization_id, lead_id, created_at desc);

alter table public.crm_assinaturas_confirmadas enable row level security;
drop policy if exists tenant_isolation_crm_assinaturas_confirmadas_select on public.crm_assinaturas_confirmadas;
create policy tenant_isolation_crm_assinaturas_confirmadas_select on public.crm_assinaturas_confirmadas
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.crm_assinaturas_confirmadas from public, anon, authenticated;
grant select on public.crm_assinaturas_confirmadas to authenticated;
grant all on public.crm_assinaturas_confirmadas to service_role;

-- (6) A chave do aviso de assinatura por organização. Só o servidor lê: o
-- segredo vive como hash, e nem o hash precisa ir à tela.
create table if not exists public.assinatura_webhook_chaves (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  path_token text not null,
  segredo_sha256 text not null,
  ativo boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'assinatura_webhook_chaves_token_unico'
  ) then
    alter table public.assinatura_webhook_chaves
      add constraint assinatura_webhook_chaves_token_unico unique (path_token);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'assinatura_webhook_chaves_uma_por_org'
  ) then
    alter table public.assinatura_webhook_chaves
      add constraint assinatura_webhook_chaves_uma_por_org unique (organization_id);
  end if;
end $$;

alter table public.assinatura_webhook_chaves enable row level security;
revoke all on public.assinatura_webhook_chaves from public, anon, authenticated;
grant all on public.assinatura_webhook_chaves to service_role;

-- As duas chaves novas são CONTEÚDO da versão: versão publicada não muda — a
-- mudança é uma versão draft nova, como toda outra configuração do agente. A
-- função é a ÚLTIMA definição do baseline, acrescida das duas colunas.
create or replace function fn_ai_agent_version_content_immutable() returns trigger
-- search_path fixo na PRÓPRIA definição: um create or replace sem a cláusula
-- apaga o alter function ... set search_path da 0521 (invariante
-- tests/invariants/avisos-do-security-advisor.test.ts).
language plpgsql set search_path = '' as $fn$
begin
  if old.status <> 'draft' and (
       new.system_prompt          is distinct from old.system_prompt
    or new.provider               is distinct from old.provider
    or new.model                  is distinct from old.model
    or new.credential_id          is distinct from old.credential_id
    or new.tool_ids               is distinct from old.tool_ids
    or new.trigger_config         is distinct from old.trigger_config
    or new.channel_session_id     is distinct from old.channel_session_id
    or new.max_steps              is distinct from old.max_steps
    or new.token_budget           is distinct from old.token_budget
    or new.cost_budget_cents      is distinct from old.cost_budget_cents
    or new.history_message_window is distinct from old.history_message_window
    or new.history_token_window   is distinct from old.history_token_window
    or new.handoff_keywords       is distinct from old.handoff_keywords
    or new.handoff_tool_enabled   is distinct from old.handoff_tool_enabled
    or new.handoff_legal_enabled  is distinct from old.handoff_legal_enabled
    or new.followup               is distinct from old.followup
    or new.multimodal_input       is distinct from old.multimodal_input
    or new.video_frames_enabled   is distinct from old.video_frames_enabled
    or new.split_messages         is distinct from old.split_messages
    or new.split_max_chars        is distinct from old.split_max_chars
    or new.cases_enabled          is distinct from old.cases_enabled
    or new.estado_do_funil_ligado is distinct from old.estado_do_funil_ligado
    or new.modo_conservador       is distinct from old.modo_conservador
    or new.operator_enabled       is distinct from old.operator_enabled
    or new.operator_model         is distinct from old.operator_model
    or new.operator_tool_ids      is distinct from old.operator_tool_ids
    or new.pipeline_ids           is distinct from old.pipeline_ids
    or new.knowledge_source_ids   is distinct from old.knowledge_source_ids
    or new.proposal_ai_draft_enabled is distinct from old.proposal_ai_draft_enabled
    or new.inbound_debounce_ms    is distinct from old.inbound_debounce_ms
    or new.version_number         is distinct from old.version_number
    or new.agent_id               is distinct from old.agent_id
    or new.organization_id        is distinct from old.organization_id
  ) then
    raise exception 'ai_agent_versions % é imutável (status=%): mudança de conteúdo = versão draft nova; rollback = revert (clona + publica)',
      old.id, old.status;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_ai_agent_versions_content_immutable on public.ai_agent_versions;
create trigger trg_ai_agent_versions_content_immutable
  before update on public.ai_agent_versions
  for each row execute function fn_ai_agent_version_content_immutable();
