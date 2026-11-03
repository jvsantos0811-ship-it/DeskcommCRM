-- manifest: PC-022 (fork) — contagem semanal das frases proibidas da organização (barradas, removidas como muleta, enviadas mesmo assim), mostrada em Configurações › IA
--
-- A lista de frases mora em `organizations.settings.conversa.frases_proibidas`
-- (ausente = a lista padrão do código). Aqui fica só a CONTAGEM: uma linha por
-- organização, frase e semana (segunda-feira no fuso da organização), somada
-- pelo worker a cada mensagem da IA que tinha a frase. Sem texto de cliente.

create table if not exists public.frases_proibidas_na_semana (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  frase text not null,
  semana date not null,
  -- barrada: a 1ª candidata do turno tinha a frase (o modelo reescreveu);
  -- removida: a reescrita ainda tinha, e a frase saiu como muleta isolada;
  -- enviada: a reescrita ainda tinha, e a mensagem saiu com ela.
  barradas integer not null default 0,
  removidas integer not null default 0,
  enviadas integer not null default 0,
  atualizado_em timestamptz not null default now(),
  primary key (organization_id, frase, semana)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'frases_proibidas_na_semana_frase_check'
  ) then
    alter table public.frases_proibidas_na_semana
      add constraint frases_proibidas_na_semana_frase_check
      check (char_length(frase) between 1 and 80);
  end if;
end $$;

create index if not exists frases_proibidas_na_semana_org_semana_idx
  on public.frases_proibidas_na_semana (organization_id, semana desc);

alter table public.frases_proibidas_na_semana enable row level security;
drop policy if exists tenant_isolation_frases_proibidas_na_semana_select on public.frases_proibidas_na_semana;
create policy tenant_isolation_frases_proibidas_na_semana_select on public.frases_proibidas_na_semana
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.frases_proibidas_na_semana from public, anon, authenticated;
grant select on public.frases_proibidas_na_semana to authenticated;
grant all on public.frases_proibidas_na_semana to service_role;
