-- manifest: **Cargos com permissões personalizadas.** Cria `team_cargos` (nome, descrição, papel concedido — viewer/agent/manager, nunca admin — e as telas visíveis, no mesmo formato de `interface_settings`) e `user_organizations.cargo_id` (on delete set null: apagar o cargo não muda o acesso de ninguém). Aplicar um cargo grava papel + telas no vínculo; editar o cargo propaga aos membros dele. O papel autoriza (requireRole); as telas são apresentação. Escrita só pelo servidor (`/api/v1/team/cargos`, admin). Faixa do fork (9003). Idempotente; apêndice igual no `baseline.sql`.
-- 9003: cargos da equipe.
--
-- Os quatro papéis fixos dizem O QUE a pessoa pode fazer; o que faltava era
-- um NOME de função ("SDR", "Closer", "Recepção") que junta um papel com
-- as telas que fazem sentido para ela, aplicável a várias pessoas de uma vez.

create table if not exists public.team_cargos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nome text not null,
  descricao text,
  -- O papel que o cargo CONCEDE. É ele que autoriza rota e ação (requireRole);
  -- `admin` fica de fora: administrar a organização não é cargo, é a função
  -- de quem responde por ela, e um cargo editável que rebaixasse ou promovesse
  -- administradores em lote seria uma porta larga demais.
  papel text not null,
  -- As telas que o cargo mostra (a mesma forma de `user_organizations.interface_settings`).
  -- Apresentação, nunca autorização: quem recusa é a rota, pelo `papel`.
  interface_settings jsonb not null default '{"preset":"completa"}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'team_cargos_papel_check') then
    alter table public.team_cargos
      add constraint team_cargos_papel_check check (papel in ('viewer', 'agent', 'manager'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'team_cargos_nome_check') then
    alter table public.team_cargos
      add constraint team_cargos_nome_check check (char_length(btrim(nome)) between 1 and 60);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'team_cargos_interface_check') then
    alter table public.team_cargos
      add constraint team_cargos_interface_check check (
        jsonb_typeof(interface_settings) = 'object' and interface_settings ? 'preset'
        and interface_settings->>'preset' in ('completa', 'simplificada')
        and (not interface_settings ? 'destinos'
             or (jsonb_typeof(interface_settings->'destinos') = 'array' and interface_settings->'destinos' <> '[]'::jsonb))
      );
  end if;
end;
$$;

create unique index if not exists team_cargos_nome_unico
  on public.team_cargos (organization_id, lower(btrim(nome)));

alter table public.team_cargos enable row level security;
drop policy if exists tenant_isolation_team_cargos_select on public.team_cargos;
create policy tenant_isolation_team_cargos_select on public.team_cargos
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.team_cargos from public, anon, authenticated;
grant select on public.team_cargos to authenticated;
grant all on public.team_cargos to service_role;

-- O vínculo do membro com o cargo. `set null` ao apagar o cargo: a pessoa
-- MANTÉM o papel e as telas que tinha — apagar um nome não muda o acesso de
-- ninguém sem que alguém escolha.
alter table public.user_organizations
  add column if not exists cargo_id uuid references public.team_cargos(id) on delete set null;
create index if not exists user_organizations_cargo_idx
  on public.user_organizations (cargo_id) where cargo_id is not null;
