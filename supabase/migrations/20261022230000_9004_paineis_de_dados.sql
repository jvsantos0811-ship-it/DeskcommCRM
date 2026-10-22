-- manifest: **Dados: construtor de painéis.** Cria `data_dashboards` (nome, descrição e a lista de widgets — métrica de um catálogo fechado, agrupamento, visual, período, filtros de funil e dono, meta). O cálculo é feito no servidor pelo client de RLS de quem olha (`/api/v1/dados/consultar`), então cada pessoa vê os números do que ela pode ver. RLS de leitura por organização; escrita só pelo servidor (gestor ou acima). Faixa do fork (9004). Idempotente; apêndice igual no `baseline.sql`.
-- 9004: painéis de dados.
--
-- O Desempenho mostra o que o produto escolheu mostrar. Aqui a organização
-- monta os próprios painéis: o que medir, como agrupar e qual a meta.

create table if not exists public.data_dashboards (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nome text not null,
  descricao text,
  -- A lista de widgets. A FORMA de cada um é validada no servidor
  -- (`lib/dados/widgets.ts`, catálogo fechado de métricas); aqui só se garante
  -- que é uma lista e que não cresce sem limite.
  widgets jsonb not null default '[]'::jsonb,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'data_dashboards_widgets_check') then
    alter table public.data_dashboards
      add constraint data_dashboards_widgets_check
      check (jsonb_typeof(widgets) = 'array' and jsonb_array_length(widgets) <= 24);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'data_dashboards_nome_check') then
    alter table public.data_dashboards
      add constraint data_dashboards_nome_check check (char_length(btrim(nome)) between 1 and 80);
  end if;
end;
$$;

create index if not exists data_dashboards_org_idx on public.data_dashboards (organization_id, created_at);

alter table public.data_dashboards enable row level security;
drop policy if exists tenant_isolation_data_dashboards_select on public.data_dashboards;
create policy tenant_isolation_data_dashboards_select on public.data_dashboards
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.data_dashboards from public, anon, authenticated;
grant select on public.data_dashboards to authenticated;
grant all on public.data_dashboards to service_role;
