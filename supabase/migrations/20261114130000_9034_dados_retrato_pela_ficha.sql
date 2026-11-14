-- manifest: Regra v2 + PC-037 (fork) — o retrato do painel de Dados aceita a origem `ficha`: a ficha gravada ou corrigida (tarefa das 05h30 ou Gestor das 17h10) refaz o retrato do dia da organização com o painel pela ficha, no máximo um a cada 5 minutos (o banco recusa com `recente`, como o "Atualizar agora" com 30). O CHECK de `crm_dados_retrato.origem` e `fn_dados_gravar_retrato` passam a conhecer `ficha`; nada muda para `cron`, `manual` e `catalogo`. Número 9034, faixa do fork. Idempotente; apêndice igual no `baseline.sql`.
--
-- 9034: retrato pela ficha (Regra v2 §3 e PC-037 §3).
--
-- POR QUE UMA ORIGEM NOVA. O painel muda no mesmo dia em que a ficha muda
-- (PC-037: "sem esperar o cron das 06:11"). O "Atualizar agora" (`manual`) tem
-- o limite de 30 minutos, que é do botão; o recálculo pela ficha é em lote de
-- 5 minutos, e quem conta os 5 minutos é o banco — o mesmo lugar que conta os 30
-- —, para duas chamadas simultâneas não refazerem o retrato duas vezes.
--
-- O QUE NÃO MUDA. A régua do retrato vem em `p_versao_regra` (1 = mensagens,
-- 2 = ficha), como já vinha. Retrato antigo não é apagado nem recalculado: a
-- comparação antes × depois da régua nova precisa dele.

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'crm_dados_retrato_origem_check'
       and pg_get_constraintdef(oid) not like '%ficha%'
  ) then
    alter table public.crm_dados_retrato drop constraint crm_dados_retrato_origem_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_dados_retrato_origem_check') then
    alter table public.crm_dados_retrato
      add constraint crm_dados_retrato_origem_check check (origem in ('cron', 'manual', 'catalogo', 'ficha'));
  end if;
end $$;

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
  v_intervalo interval;
begin
  if p_org is null then
    raise exception 'organização obrigatória' using errcode = '22023';
  end if;
  if p_origem is null or p_origem not in ('cron', 'manual', 'catalogo', 'ficha') then
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

  -- "Atualizar agora": 30 minutos. Recálculo pela ficha (PC-037 §3): 5 minutos.
  if p_origem in ('manual', 'ficha') then
    v_intervalo := case when p_origem = 'manual' then interval '30 minutes' else interval '5 minutes' end;
    select max(r.gerado_em) into v_ultimo
      from public.crm_dados_retrato r
     where r.organization_id = p_org;
    if v_ultimo is not null and v_ultimo > p_agora - v_intervalo then
      return query select v_dia, v_ultimo, false, 'recente'::text, v_ultimo + v_intervalo, 0;
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
  'v3 §8 (migration 9020) + PC-037 (9034): grava o retrato do dia (no fuso da organização) por upsert; recusa o "Atualizar agora" com menos de 30 min do último e o recálculo pela ficha com menos de 5; apaga os de mais de 90 dias. Só service_role.';

revoke all on function public.fn_dados_gravar_retrato(uuid, text, integer, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, timestamptz) from public;
revoke execute on function public.fn_dados_gravar_retrato(uuid, text, integer, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, timestamptz) from anon, authenticated;
grant execute on function public.fn_dados_gravar_retrato(uuid, text, integer, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, timestamptz) to service_role;

notify pgrst, 'reload schema';
