-- manifest: PM-027 §3–§4 (fork) — Leitor da conversa: a Ficha do lead (`crm_lead_ficha`, uma por lead, e `crm_lead_ficha_historico`, a leitura anterior guardada a cada leitura nova), as rodadas do Leitor (`leitor_rodadas`, a diária das 06:00 e as do "Atualizar agora"), o checklist de requisitos por tipo de lead (`catalog_products.requisitos`) e o aviso `lead_voltou` na Central (lista completa do CHECK; esta passa a ser a última migration que a reconstrói); a anonimização apaga a ficha e o histórico do contato
--
-- O LEITOR DA CONVERSA lê a conversa de um lead e grava FATOS, cada um com o
-- trecho que prova (`lib/dados/ficha.ts`). A regra fixa (`lib/dados/regra-da-ficha.ts`,
-- código puro) transforma a ficha em Situação, Temperatura, Qualidade, Ação e
-- Alertas. O Leitor não fala com lead, não move etapa, não mexe em marcador.
-- Quem lê e quando: `lib/dados/leitor/`. Aqui só o que precisa do banco.
--
-- ─── A ficha ────────────────────────────────────────────────────────────────
-- Uma por lead: cada leitura SUBSTITUI a anterior, e o gatilho
-- `trg_crm_lead_ficha_guarda_a_anterior` copia a anterior para o histórico na
-- mesma transação. A ficha é um jsonb validado por um schema central
-- (`fichaDoLeitorSchema`); quem lê usa `lerFicha`, nunca o caminho na mão.
-- Leitura: membro que vê a organização inteira (`fn_dados_ve_a_org_inteira`,
-- 9020) — a ficha tem trecho de conversa, e o atendente em "só os seus" não vê
-- a conversa dos outros. Escrita: só o service_role (o Leitor roda no cron).
--
-- ─── LGPD ──────────────────────────────────────────────────────────────────
-- A ficha e o histórico citam o contato (trechos da conversa): a virada de
-- `is_anonymized` APAGA as linhas dele (`trg_contacts_apaga_ficha_do_lead`),
-- como o registro da conversa (9016). Não há trilha a preservar.
--
-- ─── As rodadas ────────────────────────────────────────────────────────────
-- Uma diária por organização e dia no fuso dela (índice único parcial), mais
-- as do "Atualizar agora". O retrato das 06:00 espera a diária terminar
-- (PM-027 §3). Sem texto de conversa: só contagens e o último erro.
--
-- Idempotente: `if not exists`, `create or replace`, `drop ... if exists`.

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'voice_call_missed',
    'case_stale',
    'aviso_de_caso_nao_entregue',
    'followup_sem_agente',
    'canal_mudo_sem_numero',
    'proposal_expired_notice',
    'proposal_acceptance_rate_drop',
    'proposal_promised_not_created',
    'proposta_travada',
    'proposta_pronta_para_revisao',
    'org_reativada',
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    'canal_pausado',
    'cobranca',
    'email_de_login_trocado',
    -- (migration 0655, issue #2529) A tarefa vencida só aparecia em vermelho
    -- para quem ABRIA a lista de tarefas: quem não abria perdia o prazo em
    -- silêncio. O cron `task-reminder` varre `crm_tasks` com prazo na janela e
    -- nasce com estes DOIS kinds — um por momento, e não um genérico: a
    -- Central dá rótulo e destino por kind, e "tarefa perto do vencimento" e
    -- "tarefa venceu sem conclusão" pedem leituras diferentes de quem abre.
    -- Nascem com `ref_kind='task'`, levando à lista de tarefas. Entra NESTA
    -- lista pelas razões de sempre (#159, bloco único por constraint; e a
    -- janela do `midia-nao-lida.test.ts`, que os valores novos têm de manter
    -- dentro dos primeiros 2000 caracteres após o `add constraint`).
    'task_due',
    'task_overdue',
    -- (migration 9021, PM-025 §7) O lead escreveu e nem a IA nem uma pessoa
    -- respondeu em 1 hora de expediente. Um aberto por conversa (índice
    -- abaixo), com `ref_kind='conversation'`; resolve sozinho quando alguém
    -- responde. Fica no fim da lista pelas razões de sempre (#159).
    'ninguem_respondeu',
    -- (migration 9022, PM-027 §3) Um lead fora do alcance do Leitor (etapa
    -- perdida ou marcador que desqualifica) voltou a escrever e a ficha mostra
    -- potencial. Um aberto por lead (índice abaixo), com `ref_kind='lead'`; a
    -- etapa não muda sozinha: a equipe decide.
    'lead_voltou',
    'other'
  ));

create unique index if not exists agent_inbox_lead_voltou_aberto_unico
  on public.agent_inbox_items (organization_id, kind, ref_id)
  where status = 'open' and kind = 'lead_voltou';

-- ─── checklist de requisitos por tipo de lead (Regra v2 §2.2) ─────────────
alter table public.catalog_products
  add column if not exists requisitos text[] not null default '{}'::text[];

comment on column public.catalog_products.requisitos is
  'PM-027 / Regra v2 §2.2 (migration 9022): o checklist de requisitos mínimos do tipo de lead (ex.: "houve acidente", "carteira assinada na data"). O Leitor da conversa compara a conversa com ele. Vazio = sem checklist.';

-- ─── a ficha do lead ───────────────────────────────────────────────────────
create table if not exists public.crm_lead_ficha (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  ficha jsonb not null,
  -- Quem falou na conversa, medido no banco (agentes de IA, pessoas pelo CRM,
  -- celular do escritório). Não é pedido ao modelo.
  atendido_por jsonb not null default '{}'::jsonb,
  modelo text not null,
  versao_prompt text not null,
  gatilho text not null,
  lida_em timestamptz not null default now(),
  -- A mensagem mais recente que a leitura viu: a seleção seguinte compara com ela.
  mensagens_ate timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_lead_ficha_um_por_lead unique (organization_id, lead_id)
);

create table if not exists public.crm_lead_ficha_historico (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  ficha jsonb not null,
  atendido_por jsonb not null default '{}'::jsonb,
  modelo text not null,
  versao_prompt text not null,
  gatilho text not null,
  lida_em timestamptz not null,
  mensagens_ate timestamptz,
  substituida_em timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_lead_ficha_gatilho_check') then
    alter table public.crm_lead_ficha
      add constraint crm_lead_ficha_gatilho_check
      check (gatilho in ('chat_novo', 'mensagem_do_lead', 'mensagem_da_equipe', 'lead_voltou'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_lead_ficha_historico_gatilho_check') then
    alter table public.crm_lead_ficha_historico
      add constraint crm_lead_ficha_historico_gatilho_check
      check (gatilho in ('chat_novo', 'mensagem_do_lead', 'mensagem_da_equipe', 'lead_voltou'));
  end if;
end $$;

create index if not exists crm_lead_ficha_contato_idx on public.crm_lead_ficha (organization_id, contact_id);
create index if not exists crm_lead_ficha_historico_lead_idx
  on public.crm_lead_ficha_historico (organization_id, lead_id, substituida_em desc);
create index if not exists crm_lead_ficha_historico_contato_idx on public.crm_lead_ficha_historico (organization_id, contact_id);

comment on table public.crm_lead_ficha is
  'PM-027 §4 (migration 9022): a Ficha do lead que o Leitor da conversa grava — fatos da conversa, cada um com o trecho que prova (schema em lib/dados/ficha.ts). Uma por lead; a anterior vai para crm_lead_ficha_historico. Leitura: quem vê a organização inteira; escrita só pelo service_role. Apagada na anonimização do contato.';
comment on table public.crm_lead_ficha_historico is
  'PM-027 §4 (migration 9022): as leituras anteriores da Ficha do lead, copiadas pelo gatilho trg_crm_lead_ficha_guarda_a_anterior. Leitura: quem vê a organização inteira; escrita só pelo gatilho e pelo service_role. Apagado na anonimização do contato.';

create or replace function public.fn_crm_lead_ficha_guarda_a_anterior()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  insert into public.crm_lead_ficha_historico
    (organization_id, lead_id, contact_id, ficha, atendido_por, modelo, versao_prompt, gatilho, lida_em, mensagens_ate)
  values
    (old.organization_id, old.lead_id, old.contact_id, old.ficha, old.atendido_por, old.modelo, old.versao_prompt,
     old.gatilho, old.lida_em, old.mensagens_ate);
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function public.fn_crm_lead_ficha_guarda_a_anterior() from public, anon;
revoke execute on function public.fn_crm_lead_ficha_guarda_a_anterior() from authenticated;

drop trigger if exists trg_crm_lead_ficha_guarda_a_anterior on public.crm_lead_ficha;
create trigger trg_crm_lead_ficha_guarda_a_anterior
  before update on public.crm_lead_ficha
  for each row
  when (old.lida_em is distinct from new.lida_em)
  execute function public.fn_crm_lead_ficha_guarda_a_anterior();

alter table public.crm_lead_ficha enable row level security;
drop policy if exists tenant_isolation_crm_lead_ficha_select on public.crm_lead_ficha;
create policy tenant_isolation_crm_lead_ficha_select on public.crm_lead_ficha
  for select using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_dados_ve_a_org_inteira(organization_id)
  );
revoke all on public.crm_lead_ficha from public, anon, authenticated;
grant select on public.crm_lead_ficha to authenticated;
grant all on public.crm_lead_ficha to service_role;

alter table public.crm_lead_ficha_historico enable row level security;
drop policy if exists tenant_isolation_crm_lead_ficha_historico_select on public.crm_lead_ficha_historico;
create policy tenant_isolation_crm_lead_ficha_historico_select on public.crm_lead_ficha_historico
  for select using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_dados_ve_a_org_inteira(organization_id)
  );
revoke all on public.crm_lead_ficha_historico from public, anon, authenticated;
grant select on public.crm_lead_ficha_historico to authenticated;
grant all on public.crm_lead_ficha_historico to service_role;

-- ─── LGPD: a anonimização apaga a ficha e o histórico do contato ───────────
create or replace function public.fn_apagar_ficha_do_lead_ao_anonimizar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_anonymized is true and coalesce(old.is_anonymized, false) is not true then
    delete from public.crm_lead_ficha
     where organization_id = new.organization_id
       and contact_id = new.id;
    delete from public.crm_lead_ficha_historico
     where organization_id = new.organization_id
       and contact_id = new.id;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_apagar_ficha_do_lead_ao_anonimizar() from public, anon;
revoke execute on function public.fn_apagar_ficha_do_lead_ao_anonimizar() from authenticated;

drop trigger if exists trg_contacts_apaga_ficha_do_lead on public.contacts;
create trigger trg_contacts_apaga_ficha_do_lead
  after update of is_anonymized on public.contacts
  for each row execute function public.fn_apagar_ficha_do_lead_ao_anonimizar();

-- ─── as rodadas do Leitor ──────────────────────────────────────────────────
create table if not exists public.leitor_rodadas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- O dia no fuso da organização.
  dia date not null,
  -- diaria = a das 06:00; manual = a do "Atualizar agora".
  origem text not null default 'diaria',
  iniciada_em timestamptz not null default now(),
  terminada_em timestamptz,
  lidos integer not null default 0,
  falhas integer not null default 0,
  ultimo_erro text
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leitor_rodadas_origem_check') then
    alter table public.leitor_rodadas
      add constraint leitor_rodadas_origem_check check (origem in ('diaria', 'manual'));
  end if;
end $$;

create unique index if not exists leitor_rodadas_uma_diaria_por_dia
  on public.leitor_rodadas (organization_id, dia)
  where origem = 'diaria';
create index if not exists leitor_rodadas_abertas_idx
  on public.leitor_rodadas (organization_id, iniciada_em desc)
  where terminada_em is null;

comment on table public.leitor_rodadas is
  'PM-027 §3 (migration 9022): as rodadas do Leitor da conversa — a diária das 06:00 no fuso da organização (uma por dia) e as do "Atualizar agora". O retrato das 06:00 espera a diária terminar. Sem texto de conversa. Leitura: membro da organização; escrita só pelo service_role.';

alter table public.leitor_rodadas enable row level security;
drop policy if exists tenant_isolation_leitor_rodadas_select on public.leitor_rodadas;
create policy tenant_isolation_leitor_rodadas_select on public.leitor_rodadas
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.leitor_rodadas from public, anon, authenticated;
grant select on public.leitor_rodadas to authenticated;
grant all on public.leitor_rodadas to service_role;
