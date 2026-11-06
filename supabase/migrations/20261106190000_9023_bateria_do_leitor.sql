-- manifest: PM-027 §8–§9 (fork) — a bateria do Leitor da conversa: `leitor_bateria_casos` (a conversa de cada caso copiada e congelada, com o gabarito e a versão; caso real fica no escopo da organização de origem e some na anonimização do contato), `leitor_bateria_rodadas` (um modelo testado na bateria, com o juiz, o placar e se foi aprovado — vale para a instalação inteira, decisão do dono em 06/11) e `leitor_bateria_resultados` (caso a caso, com a decisão do juiz)
--
-- A BATERIA decide se um modelo pode ler as conversas (PM-027 §8: "só liga com
-- 100% nos casos que bloqueiam"). A régua é código puro
-- (`lib/dados/leitor/bateria.ts`); quem roda é `lib/dados/leitor/bateria-rodada.ts`.
--
-- ─── Os casos ──────────────────────────────────────────────────────────────
-- Cada caso traz a conversa TRANSCRITA e congelada até o relógio do caso — o
-- texto que o modelo lê —, as variáveis do prompt daquela organização naquele dia
-- e o GABARITO (a ficha que uma pessoa escreveu). Gabarito corrigido pelo juiz
-- vira VERSÃO nova (com o motivo); só a mais nova fica `ativo`.
-- Caso REAL: `origem_organization_id`/`origem_contact_id` dizem de onde veio. A
-- conversa nunca sai desse escopo para outra organização: nenhum usuário do app
-- lê esta tabela (RLS sem policy; revoke de authenticated) — só o dono da
-- plataforma, pela rota do admin com o cliente de serviço. A anonimização do
-- contato APAGA o caso (e, em cascata, os resultados).
-- Caso INVENTADO (genérico, sem dado pessoal): origem nula.
--
-- ─── As rodadas ────────────────────────────────────────────────────────────
-- Um modelo testado contra a bateria ativa, com o juiz (nunca o mesmo modelo).
-- A aprovação vale para a INSTALAÇÃO (decisão do dono, 06/11): o escritório vê a
-- nota, nunca as conversas. Por isso a rodada não tem `organization_id`, e o
-- placar (só números) é legível por quem está logado. A chave usada para chamar
-- os modelos é a da organização em `credencial_organization_id`.
--
-- ─── Os resultados ─────────────────────────────────────────────────────────
-- Caso a caso: a resposta do modelo (que cita trechos da conversa), a
-- divergência e a decisão do juiz. Mesma régua dos casos: só o dono, pela rota
-- do admin.
--
-- Idempotente: `if not exists`, `create or replace`, `drop ... if exists`.

create table if not exists public.leitor_bateria_casos (
  id uuid primary key default gen_random_uuid(),
  caso_id text not null,
  versao integer not null default 1,
  ativo boolean not null default true,
  origem_organization_id uuid references public.organizations(id) on delete cascade,
  origem_contact_id uuid references public.contacts(id) on delete cascade,
  origem_lead_id uuid references public.crm_leads(id) on delete set null,
  bloqueia boolean not null default true,
  relogio timestamptz not null,
  conversa text not null,
  prompt_variaveis jsonb not null default '{}'::jsonb,
  gabarito jsonb not null,
  motivo_da_versao text,
  criado_em timestamptz not null default now(),
  constraint leitor_bateria_casos_versao_unica unique (caso_id, versao)
);

create unique index if not exists leitor_bateria_casos_um_ativo
  on public.leitor_bateria_casos (caso_id)
  where ativo;
create index if not exists leitor_bateria_casos_contato_idx
  on public.leitor_bateria_casos (origem_organization_id, origem_contact_id);

comment on table public.leitor_bateria_casos is
  'PM-027 §9 (migration 9023): os casos da bateria do Leitor da conversa — a conversa congelada e transcrita, as variáveis do prompt e o gabarito, com versão. Caso real fica no escopo da organização de origem; nenhum usuário do app lê (só o dono, pela rota do admin). Apagado na anonimização do contato.';

alter table public.leitor_bateria_casos enable row level security;
revoke all on public.leitor_bateria_casos from public, anon, authenticated;
grant all on public.leitor_bateria_casos to service_role;

create table if not exists public.leitor_bateria_rodadas (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model_id text not null,
  juiz_provider text not null,
  juiz_model_id text not null,
  credencial_organization_id uuid references public.organizations(id) on delete set null,
  status text not null default 'pendente',
  pedida_por uuid references auth.users(id) on delete set null,
  criada_em timestamptz not null default now(),
  -- Sinal de vida: a rodada parada há muito tempo é retomada.
  atualizada_em timestamptz not null default now(),
  terminada_em timestamptz,
  casos_total integer not null default 0,
  casos_feitos integer not null default 0,
  acertos integer not null default 0,
  bloqueantes integer not null default 0,
  bloqueantes_acertos integer not null default 0,
  regra_v2 integer not null default 0,
  qualidade_acertos integer not null default 0,
  aprovado boolean,
  tempo_medio_ms integer,
  custo_cents numeric,
  erro text
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leitor_bateria_rodadas_status_check') then
    alter table public.leitor_bateria_rodadas
      add constraint leitor_bateria_rodadas_status_check
      check (status in ('pendente', 'rodando', 'terminada', 'falhou', 'cancelada'));
  end if;
end $$;

create index if not exists leitor_bateria_rodadas_modelo_idx
  on public.leitor_bateria_rodadas (provider, model_id, terminada_em desc);
create index if not exists leitor_bateria_rodadas_abertas_idx
  on public.leitor_bateria_rodadas (criada_em)
  where status in ('pendente', 'rodando');

comment on table public.leitor_bateria_rodadas is
  'PM-027 §8–§9 (migration 9023): um modelo testado na bateria do Leitor, com o juiz e o placar. A aprovação vale para a instalação inteira (decisão do dono, 06/11): quem está logado lê só os números; escrita só pelo service_role.';

alter table public.leitor_bateria_rodadas enable row level security;
drop policy if exists leitor_bateria_rodadas_select_logado on public.leitor_bateria_rodadas;
create policy leitor_bateria_rodadas_select_logado on public.leitor_bateria_rodadas
  for select to authenticated using (true);
revoke all on public.leitor_bateria_rodadas from public, anon, authenticated;
grant select on public.leitor_bateria_rodadas to authenticated;
grant all on public.leitor_bateria_rodadas to service_role;

create table if not exists public.leitor_bateria_resultados (
  id uuid primary key default gen_random_uuid(),
  rodada_id uuid not null references public.leitor_bateria_rodadas(id) on delete cascade,
  caso_uuid uuid not null references public.leitor_bateria_casos(id) on delete cascade,
  caso_id text not null,
  caso_versao integer not null,
  passou_sem_juiz boolean not null,
  acerto boolean not null,
  qualidade_igual boolean,
  divergencias jsonb not null default '[]'::jsonb,
  resposta jsonb,
  juiz_decisao text,
  juiz_lado_do_gabarito text,
  juiz_motivo text,
  juiz_trecho text,
  revisar boolean not null default false,
  latencia_ms integer,
  custo_cents numeric,
  erro text,
  criado_em timestamptz not null default now(),
  constraint leitor_bateria_resultados_um_por_caso unique (rodada_id, caso_uuid)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leitor_bateria_resultados_juiz_check') then
    alter table public.leitor_bateria_resultados
      add constraint leitor_bateria_resultados_juiz_check
      check (
        (juiz_decisao is null or juiz_decisao in ('A', 'B', 'as_duas_erradas', 'duvida'))
        and (juiz_lado_do_gabarito is null or juiz_lado_do_gabarito in ('A', 'B'))
      );
  end if;
end $$;

comment on table public.leitor_bateria_resultados is
  'PM-027 §9 (migration 9023): o resultado de cada caso numa rodada da bateria do Leitor — a resposta do modelo (cita a conversa), a divergência e a decisão do juiz. Nenhum usuário do app lê (só o dono, pela rota do admin). Some com o caso.';

alter table public.leitor_bateria_resultados enable row level security;
revoke all on public.leitor_bateria_resultados from public, anon, authenticated;
grant all on public.leitor_bateria_resultados to service_role;

-- ─── LGPD: a anonimização apaga o caso que veio deste contato ──────────────
create or replace function public.fn_apagar_caso_da_bateria_ao_anonimizar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_anonymized is true and coalesce(old.is_anonymized, false) is not true then
    delete from public.leitor_bateria_casos
     where origem_organization_id = new.organization_id
       and origem_contact_id = new.id;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_apagar_caso_da_bateria_ao_anonimizar() from public, anon;
revoke execute on function public.fn_apagar_caso_da_bateria_ao_anonimizar() from authenticated;

drop trigger if exists trg_contacts_apaga_caso_da_bateria on public.contacts;
create trigger trg_contacts_apaga_caso_da_bateria
  after update of is_anonymized on public.contacts
  for each row execute function public.fn_apagar_caso_da_bateria_ao_anonimizar();
