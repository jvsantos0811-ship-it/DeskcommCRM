-- manifest: v3 seção 8 (fork) — retrato diário dos painéis de Dados (crm_dados_retrato): uma linha por organização e dia no fuso dela, gerada às 06:00 pelo cron ou pelo "Atualizar agora" (no máximo 1 vez a cada 30 min); 90 dias guardados; leitura só de quem vê a organização inteira; escrita só pelo service_role
--
-- O RETRATO DA MANHÃ. Os painéis de Dados (Qualidade do lead, Dinheiro em jogo,
-- Gestão, Explorar) não calculam ao abrir: o CRM monta um retrato por
-- organização uma vez por dia, às 06:00 no fuso dela, e a tela só lê o retrato.
-- Os retratos guardados alimentam a comparação "hoje × ontem × 7 dias atrás".
--
-- ─── O que mora aqui e o que NÃO mora ─────────────────────────────────────
--
-- A nota, o nível, a temperatura e a situação de cada lead saem de
-- `lib/dados/qualidade.ts` (`calcularQualidade`, a mesma regra do card do funil
-- e do filtro `?nivel=`); os totais e agrupamentos, de `lib/dados/retrato.ts`.
-- Este arquivo guarda o RESULTADO e cuida de três regras que precisam do banco
-- para valer sempre: o dia no fuso da organização, o intervalo de 30 minutos do
-- "Atualizar agora" e a limpeza dos retratos com mais de 90 dias. Nenhum peso da
-- nota mora em SQL.
--
-- O retrato NÃO guarda nome de lead nem texto de conversa (LGPD): só o id, a
-- etapa, a nota e os fatos. O nome é lido ao vivo, pela RLS, na hora de mostrar
-- — e o lead anonimizado aparece anonimizado no retrato de ontem também.
--
-- ─── Quem lê: só quem vê a organização inteira ───────────────────────────
--
-- O retrato é da ORGANIZAÇÃO: soma os leads de todo mundo. O atendente em "só
-- os seus" (`settings.visibility_mode` = `own` ou `own_and_unassigned`) não pode
-- ler os números dos leads dos colegas pela REST, então a policy exige, além de
-- ser membro (`fn_user_org_ids()`), ver a organização inteira — a MESMA régua de
-- `fn_can_view_lead` (migration 0036), perguntada para um dono que não é
-- ninguém. Para esse atendente a tela calcula na hora, com os leads dele
-- (`fn_dados_leads_do_retrato` é SECURITY INVOKER: vale a RLS de quem pergunta).
--
-- ─── Quem escreve: só o service_role, por uma função ─────────────────────
--
-- `authenticated` só tem SELECT. O cron (`app/api/v1/cron/dados-retrato`) e o
-- "Atualizar agora" (`POST /api/v1/dados/qualidade/atualizar`) gravam por
-- `fn_dados_gravar_retrato`, que decide o dia no fuso da organização, recusa o
-- segundo "Atualizar agora" em menos de 30 minutos, faz upsert por
-- (organização, dia) — rodar duas vezes no mesmo dia não duplica — e apaga os
-- retratos com mais de 90 dias. Nenhum gatilho, nenhum HTTP no banco.
--
-- Idempotente: `if not exists`, `create or replace`, `drop policy if exists`.

create table if not exists public.crm_dados_retrato (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- O dia no fuso da organização (não em UTC): o retrato das 06:00 de 05/11 em
  -- São Paulo e o de Lisboa caem cada um no 05/11 do seu relógio.
  dia date not null,
  gerado_em timestamptz not null default now(),
  -- cron = o das 06:00; manual = "Atualizar agora"; catalogo = refeito porque o
  -- valor de um tipo de lead mudou (a aba Dinheiro muda na hora).
  origem text not null default 'cron',
  -- A versão da regra (`VERSAO_DA_REGRA` em lib/dados/retrato.ts). Comparar
  -- retratos de versões diferentes é comparar réguas diferentes: a tela avisa.
  versao_regra integer not null default 1,
  fuso text not null default 'America/Sao_Paulo',
  resumo jsonb not null default '{}'::jsonb,
  leads jsonb not null default '[]'::jsonb,
  por_dia jsonb not null default '[]'::jsonb,
  funil jsonb not null default '[]'::jsonb,
  por_etapa jsonb not null default '[]'::jsonb,
  motivos jsonb not null default '[]'::jsonb,
  constraint crm_dados_retrato_org_dia_unique unique (organization_id, dia)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_dados_retrato_origem_check') then
    alter table public.crm_dados_retrato
      add constraint crm_dados_retrato_origem_check check (origem in ('cron', 'manual', 'catalogo'));
  end if;
end $$;

comment on table public.crm_dados_retrato is
  'v3 §8 (migration 9020): o retrato diário dos painéis de Dados, por organização e dia no fuso dela. Sem nome de lead nem texto de conversa. Leitura: membro que vê a organização inteira (fn_dados_ve_a_org_inteira); escrita só por fn_dados_gravar_retrato (service_role). 90 dias guardados.';

-- ─── Quem vê a organização inteira ───────────────────────────────────────
-- A régua de `fn_can_view_lead` (0036), perguntada para um dono que não é
-- ninguém: verdadeiro para viewer, manager, admin e platform admin; para o
-- agent, só com `visibility_mode = 'all'`. Recebe só a org; não abre nada.
create or replace function public.fn_dados_ve_a_org_inteira(p_org uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p_org in (select public.fn_user_org_ids())
     and public.fn_can_view_lead(p_org, '00000000-0000-0000-0000-000000000000'::uuid);
$$;

revoke all on function public.fn_dados_ve_a_org_inteira(uuid) from public;
revoke execute on function public.fn_dados_ve_a_org_inteira(uuid) from anon;
grant execute on function public.fn_dados_ve_a_org_inteira(uuid) to authenticated, service_role;

alter table public.crm_dados_retrato enable row level security;
drop policy if exists tenant_isolation_crm_dados_retrato_select on public.crm_dados_retrato;
create policy tenant_isolation_crm_dados_retrato_select on public.crm_dados_retrato
  for select using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_dados_ve_a_org_inteira(organization_id)
  );
revoke all on public.crm_dados_retrato from public, anon, authenticated;
grant select on public.crm_dados_retrato to authenticated;
grant all on public.crm_dados_retrato to service_role;

-- ─── O fuso da organização ───────────────────────────────────────────────
-- `organizations.timezone` não tem CHECK: um fuso que o Postgres não conhece
-- faria `at time zone` lançar no meio do cron. Fuso ausente ou desconhecido vale
-- o padrão do produto (`FUSO_PADRAO`, lib/tempo/fusos.ts).
create or replace function public.fn_dados_fuso_da_org(p_org uuid)
returns text
language sql stable security invoker
set search_path = public, pg_temp
as $$
  select coalesce(
    (select n.name
       from public.organizations o
       join pg_catalog.pg_timezone_names n on n.name = btrim(o.timezone)
      where o.id = p_org
      limit 1),
    'America/Sao_Paulo');
$$;

revoke all on function public.fn_dados_fuso_da_org(uuid) from public;
revoke execute on function public.fn_dados_fuso_da_org(uuid) from anon, authenticated;
grant execute on function public.fn_dados_fuso_da_org(uuid) to service_role;

-- ─── Os leads do retrato ─────────────────────────────────────────────────
-- Os fatos da nota (`fn_dados_qualidade_do_lead`, 9019) do UNIVERSO do painel
-- (`no_universo`: funil padrão, sem a base importada, sem cadastro manual, sem
-- card de teste), mais o que os painéis precisam e o quadro não: a etapa, a
-- origem, o anúncio, o valor, o motivo da perda e quando o lead se qualificou.
--
-- Qualificado (regra 5 da ordem v3): a primeira entrada numa etapa com chance
-- de pelo menos `p_chance_de_qualificado` % ou ganha, tirada da linha do tempo;
-- sem registro, a etapa atual (ou o ganho). O limiar vem do TypeScript
-- (`PESOS_DA_NOTA.chanceMinimaDaEtapa`), para não ter segunda cópia aqui.
--
-- SECURITY INVOKER, como a 9019: o gerente recebe a organização inteira, o
-- atendente em "só os seus" recebe os dele, e quem é de outra organização não
-- recebe nada. Com o service_role (o cron), quem recorta é `p_org`.
create or replace function public.fn_dados_leads_do_retrato(
  p_org uuid,
  p_chance_de_qualificado integer default 50
) returns table (
  lead_id uuid,
  pipeline_id uuid,
  status text,
  criado_em timestamptz,
  etapa_desde timestamptz,
  chance_da_etapa integer,
  prazo_da_etapa_horas numeric,
  chance_da_ia numeric,
  faixa_da_ia text,
  mensagens_da_empresa integer,
  respostas integer,
  primeira_mensagem_do_lead_em timestamptz,
  primeira_resposta_da_empresa_em timestamptz,
  ultima_resposta_em timestamptz,
  duplicado_de_desqualificado boolean,
  interesse text,
  interesse_registrado boolean,
  etapa_id uuid,
  etapa text,
  etapa_posicao numeric,
  origem text,
  anuncio_id text,
  anuncio_texto text,
  valor_cents bigint,
  moeda text,
  motivo_da_perda text,
  fechado_em timestamptz,
  qualificado_em timestamptz
)
  language sql stable security invoker
  set search_path = public, pg_temp
as $fn$
  select q.lead_id,
         q.pipeline_id,
         q.status,
         q.criado_em,
         q.etapa_desde,
         q.chance_da_etapa,
         q.prazo_da_etapa_horas,
         q.chance_da_ia,
         q.faixa_da_ia,
         q.mensagens_da_empresa,
         q.respostas,
         q.primeira_mensagem_do_lead_em,
         q.primeira_resposta_da_empresa_em,
         q.ultima_resposta_em,
         q.duplicado_de_desqualificado,
         q.interesse,
         q.interesse_registrado,
         l.stage_id,
         s.name,
         s.position,
         l.source,
         nullif(btrim(l.source_metadata->>'ad_id'), ''),
         left(nullif(btrim(l.source_metadata->'ad_raw'->'welcome_message'->>'text'), ''), 40),
         l.value_cents,
         l.currency,
         l.lost_reason,
         l.closed_at,
         coalesce(
           (select min(a.performed_at)
              from public.crm_lead_activities a
              join public.crm_stages s2 on s2.id::text = a.payload->>'to_stage_id'
             where a.organization_id = p_org
               and a.lead_id = l.id
               and a.type in ('stage_changed', 'demand_closed')
               and (coalesce(s2.win_probability, 0) >= p_chance_de_qualificado or s2.is_won)),
           case when coalesce(s.win_probability, 0) >= p_chance_de_qualificado or s.is_won
                then l.stage_changed_at end,
           case when l.status = 'won' then l.closed_at end
         )
    from public.fn_dados_qualidade_do_lead(
           p_org,
           (select p.id from public.crm_pipelines p
             where p.organization_id = p_org and p.is_default limit 1)
         ) q
    join public.crm_leads l on l.id = q.lead_id and l.organization_id = p_org
    join public.crm_stages s on s.id = l.stage_id
   where q.no_universo
   order by q.lead_id
$fn$;

comment on function public.fn_dados_leads_do_retrato(uuid, integer) is
  'v3 §8 (migration 9020): os leads do universo do painel de Dados, com os fatos da nota (9019) e o que os painéis precisam. SECURITY INVOKER: vale a RLS de quem pergunta; com o service_role, p_org recorta.';

revoke execute on function public.fn_dados_leads_do_retrato(uuid, integer) from public, anon;
grant execute on function public.fn_dados_leads_do_retrato(uuid, integer) to authenticated, service_role;

-- ─── As organizações que ainda não têm o retrato de hoje ────────────────
-- O cron roda de hora em hora e pergunta: quais organizações OPERANTES já
-- passaram das `p_hora`:00 no relógio delas e ainda não têm o retrato do dia
-- delas? Assim cada uma é atualizada às 06:00 no próprio fuso, e uma rodada que
-- falhou é refeita na hora seguinte.
create or replace function public.fn_dados_orgs_sem_retrato(
  p_agora timestamptz default now(),
  p_hora integer default 6
) returns table (organization_id uuid, dia date, fuso text)
  language sql stable security invoker
  set search_path = public, pg_temp
as $$
  select o.id, (p_agora at time zone f.fuso)::date, f.fuso
    from public.organizations o
    cross join lateral (select public.fn_dados_fuso_da_org(o.id) as fuso) f
   where public.fn_org_operante(o.id)
     and extract(hour from (p_agora at time zone f.fuso)) >= p_hora
     and not exists (
       select 1 from public.crm_dados_retrato r
        where r.organization_id = o.id
          and r.dia = (p_agora at time zone f.fuso)::date)
   order by o.id
$$;

revoke all on function public.fn_dados_orgs_sem_retrato(timestamptz, integer) from public;
revoke execute on function public.fn_dados_orgs_sem_retrato(timestamptz, integer) from anon, authenticated;
grant execute on function public.fn_dados_orgs_sem_retrato(timestamptz, integer) to service_role;

-- ─── Gravar o retrato ────────────────────────────────────────────────────
-- Uma chamada por organização, numa transação, com trava por organização (dois
-- "Atualizar agora" ao mesmo tempo não passam os dois):
--
--   · o dia é o de `p_agora` no fuso da organização — quem chama não escolhe;
--   · `p_so_se_faltar` (o cron): já existe o retrato do dia → não grava nada
--     (`motivo = 'ja_existe'`). Rodar o cron duas vezes não duplica nem refaz;
--   · `manual` ("Atualizar agora"): o último retrato da organização tem menos
--     de 30 minutos → não grava (`motivo = 'recente'`, com `proximo_em`);
--   · senão, upsert por (organização, dia) e limpeza: os retratos com mais de
--     90 dias saem, e os de mais de 7 dias ficam sem a lista de leads (a
--     comparação só usa o resumo; a lista é o que pesa no disco do cliente).
--
-- `p_agora` existe para o teste medir o fuso, os 30 minutos e os 90 dias sem
-- relógio; o cron e a rota não passam nada.
create or replace function public.fn_dados_gravar_retrato(
  p_org uuid,
  p_origem text,
  p_versao_regra integer,
  p_resumo jsonb,
  p_leads jsonb,
  p_por_dia jsonb,
  p_funil jsonb,
  p_por_etapa jsonb,
  p_motivos jsonb,
  p_so_se_faltar boolean default false,
  p_agora timestamptz default now()
) returns table (
  retrato_dia date,
  retrato_gerado_em timestamptz,
  gravado boolean,
  motivo text,
  proximo_em timestamptz,
  apagados integer
)
  language plpgsql volatile security invoker
  set search_path = public, pg_temp
as $fn$
declare
  v_fuso text;
  v_dia date;
  v_ultimo timestamptz;
  v_existente timestamptz;
  v_apagados integer := 0;
begin
  if p_org is null then
    raise exception 'organização obrigatória' using errcode = '22023';
  end if;
  if p_origem is null or p_origem not in ('cron', 'manual', 'catalogo') then
    raise exception 'origem inválida: %', p_origem using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('crm_dados_retrato:' || p_org::text, 0));

  v_fuso := public.fn_dados_fuso_da_org(p_org);
  v_dia := (p_agora at time zone v_fuso)::date;

  select r.gerado_em into v_existente
    from public.crm_dados_retrato r
   where r.organization_id = p_org and r.dia = v_dia;

  if p_so_se_faltar and v_existente is not null then
    return query select v_dia, v_existente, false, 'ja_existe'::text, null::timestamptz, 0;
    return;
  end if;

  if p_origem = 'manual' then
    select max(r.gerado_em) into v_ultimo
      from public.crm_dados_retrato r
     where r.organization_id = p_org;
    if v_ultimo is not null and v_ultimo > p_agora - interval '30 minutes' then
      return query select v_dia, v_ultimo, false, 'recente'::text, v_ultimo + interval '30 minutes', 0;
      return;
    end if;
  end if;

  insert into public.crm_dados_retrato as r
    (organization_id, dia, gerado_em, origem, versao_regra, fuso,
     resumo, leads, por_dia, funil, por_etapa, motivos)
  values
    (p_org, v_dia, p_agora, p_origem, p_versao_regra, v_fuso,
     coalesce(p_resumo, '{}'::jsonb), coalesce(p_leads, '[]'::jsonb),
     coalesce(p_por_dia, '[]'::jsonb), coalesce(p_funil, '[]'::jsonb),
     coalesce(p_por_etapa, '[]'::jsonb), coalesce(p_motivos, '[]'::jsonb))
  on conflict (organization_id, dia) do update
     set gerado_em = excluded.gerado_em,
         origem = excluded.origem,
         versao_regra = excluded.versao_regra,
         fuso = excluded.fuso,
         resumo = excluded.resumo,
         leads = excluded.leads,
         por_dia = excluded.por_dia,
         funil = excluded.funil,
         por_etapa = excluded.por_etapa,
         motivos = excluded.motivos;

  delete from public.crm_dados_retrato r
   where r.organization_id = p_org
     and r.dia < v_dia - 90;
  get diagnostics v_apagados = row_count;

  update public.crm_dados_retrato r
     set leads = '[]'::jsonb
   where r.organization_id = p_org
     and r.dia < v_dia - 7
     and r.leads <> '[]'::jsonb;

  return query select v_dia, p_agora, true, 'gravado'::text, p_agora + interval '30 minutes', v_apagados;
end;
$fn$;

comment on function public.fn_dados_gravar_retrato(uuid, text, integer, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, timestamptz) is
  'v3 §8 (migration 9020): grava o retrato do dia (no fuso da organização) por upsert; recusa o "Atualizar agora" com menos de 30 min do último; apaga os de mais de 90 dias. Só service_role.';

revoke all on function public.fn_dados_gravar_retrato(uuid, text, integer, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, timestamptz) from public;
revoke execute on function public.fn_dados_gravar_retrato(uuid, text, integer, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, timestamptz) from anon, authenticated;
grant execute on function public.fn_dados_gravar_retrato(uuid, text, integer, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, timestamptz) to service_role;

notify pgrst, 'reload schema';
