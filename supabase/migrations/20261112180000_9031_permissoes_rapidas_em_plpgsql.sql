-- manifest: **Permissões rápidas (correção de velocidade que só existia no banco de produção).** `fn_user_role_in_org`, `fn_can_view_conversation` e `fn_can_view_lead` passam de SQL para PL/pgSQL, com a MESMA regra de acesso: função SQL com SECURITY DEFINER é replanejada a cada linha que a RLS confere, e em PL/pgSQL o plano fica em cache (funil de 97 cards: 1.033 ms → 60 ms; contagem de 228 conversas: 2.686 ms → 56 ms, medidos na produção). `fn_dados_qualidade_do_lead` vira um invólucro com dois caminhos de mesmo resultado: `fn_dados_qualidade_do_lead_org_inteira` (SECURITY DEFINER com a pergunta `fn_dados_ve_a_org_inteira` dentro do corpo, para quem vê a organização inteira; 7.001 ms → 133 ms) e `fn_dados_qualidade_do_lead_por_linha` (o corpo da 9019, com a RLS de quem pergunta). Nenhuma policy de tabela muda; nenhum dado migrado. As três correções tinham sido aplicadas direto no banco em 10/11/2026 e a reaplicação do baseline de cada atualização as desfazia. Número 9031, faixa do fork. Idempotente; apêndice igual no `baseline.sql`, antes da VARREDURA anon.
-- 9031: as funções de permissão em PL/pgSQL e a Qualidade do lead com dois caminhos.

-- ─── 1. O papel e a visibilidade, em PL/pgSQL ───────────────────────────────
--
-- MESMA regra de acesso, palavra por palavra; muda só a linguagem. Uma função
-- `language sql` com SECURITY DEFINER não é embutida na consulta, e o Postgres a
-- replaneja a CADA LINHA que a RLS confere. Em PL/pgSQL o plano de cada comando
-- fica em cache na sessão. Medido na produção em 11/11/2026, como admin de um
-- escritório: o funil de 97 cards caiu de 1.033 ms para 60 ms e a contagem de
-- 228 conversas, de 2.686 ms para 56 ms.

create or replace function public.fn_user_role_in_org(p_org uuid)
returns text language plpgsql stable security definer set search_path = public as $f$
declare s jsonb; r text;
begin
  s := public.fn_support_context();
  if s->>'status' = 'active' and (s->>'organization_id')::uuid = p_org then
    return case when s->>'access_mode' = 'full' then 'admin' else 'viewer' end;
  end if;
  select role into r from public.user_organizations
   where user_id = auth.uid() and organization_id = p_org and revoked_at is null
   limit 1;
  return r;
end $f$;

create or replace function public.fn_can_view_conversation(p_org uuid, p_assigned_to_user_id uuid)
returns boolean language plpgsql stable security definer set search_path = public as $f$
declare v_role text; v_mode text;
begin
  if public.fn_is_platform_admin() then return true; end if;
  v_role := public.fn_user_role_in_org(p_org);
  if v_role is null then return false; end if;
  if v_role in ('viewer', 'manager', 'admin') then return true; end if;
  if p_assigned_to_user_id = auth.uid() then return true; end if;
  select settings->>'visibility_mode' into v_mode from public.organizations where id = p_org;
  return case coalesce(v_mode, 'own_and_unassigned')
           when 'all' then true
           when 'own_and_unassigned' then p_assigned_to_user_id is null
           else false
         end;
end $f$;

create or replace function public.fn_can_view_lead(p_org uuid, p_owner_user_id uuid)
returns boolean language plpgsql stable security definer set search_path = public as $f$
declare v_role text; v_mode text;
begin
  if public.fn_is_platform_admin() then return true; end if;
  v_role := public.fn_user_role_in_org(p_org);
  if v_role is null then return false; end if;
  if v_role in ('viewer', 'manager', 'admin') then return true; end if;
  if p_owner_user_id = auth.uid() then return true; end if;
  select settings->>'visibility_mode' into v_mode from public.organizations where id = p_org;
  return case coalesce(v_mode, 'own_and_unassigned')
           when 'all' then true
           when 'own_and_unassigned' then p_owner_user_id is null
           else false
         end;
end $f$;

-- ─── 2. A "Qualidade do lead" com dois caminhos e o mesmo resultado ─────────
--
--  * quem vê a organização inteira (`fn_dados_ve_a_org_inteira`: viewer,
--    manager, admin, platform admin, atendente com visibility_mode = 'all') lê
--    direto, sem a RLS linha por linha — para essa pessoa a RLS não filtra nada
--    e custava ~7 s num escritório de 367 negócios (133 ms depois);
--  * os demais seguem pelo corpo de sempre, com a RLS de sempre.
-- Nenhuma policy de tabela muda.
--
-- As duas auxiliares são DERIVADAS do corpo da 9019, e não copiadas: uma cópia
-- de 180 linhas em três lugares diverge na primeira mudança da regra. A
-- derivação só roda enquanto `fn_dados_qualidade_do_lead` ainda é o corpo em
-- SQL (num banco novo e em toda reaplicação do baseline, que a recria antes
-- deste bloco); se ela já é o invólucro, as auxiliares já existem e nada muda.
-- ⚠️ Quem mudar o corpo da 9019 muda LÁ, e este bloco, que vem depois no
-- arquivo, refaz as auxiliares. Um `create or replace` da função em bloco
-- POSTERIOR a este desfaz o invólucro — o invariante
-- `permissoes-rapidas-em-plpgsql` reprova.
do $d$
declare
  b text;
  b_org text;
  v_lang text;
begin
  select l.lanname into v_lang
    from pg_proc p join pg_language l on l.oid = p.prolang
   where p.oid = 'public.fn_dados_qualidade_do_lead(uuid,uuid)'::regprocedure;
  if v_lang <> 'sql' then
    return;
  end if;

  b := pg_get_functiondef('public.fn_dados_qualidade_do_lead(uuid,uuid)'::regprocedure);
  if position('FUNCTION public.fn_dados_qualidade_do_lead(' in b) = 0 then
    raise exception '9031: cabeçalho de fn_dados_qualidade_do_lead fora do formato esperado';
  end if;

  execute replace(b, 'FUNCTION public.fn_dados_qualidade_do_lead(', 'FUNCTION public.fn_dados_qualidade_do_lead_por_linha(');

  b_org := replace(b, 'FUNCTION public.fn_dados_qualidade_do_lead(', 'FUNCTION public.fn_dados_qualidade_do_lead_org_inteira(');
  b_org := replace(b_org, E' STABLE\n', E' STABLE SECURITY DEFINER\n');
  b_org := replace(b_org, 'where l.organization_id = p_org',
                          'where l.organization_id = p_org and public.fn_dados_ve_a_org_inteira(p_org)');
  b_org := replace(b_org, 'mm.organization_id = p_org', 'mm.organization_id = p_org and mm.conversation_id is not null');
  -- SECURITY DEFINER sem a pergunta "esta pessoa vê a organização inteira?"
  -- seria leitura entre organizações. Se o texto do corpo mudou e a troca não
  -- pegou, o bloco para aqui em vez de criar a função aberta.
  if position('SECURITY DEFINER' in b_org) = 0
     or position('public.fn_dados_ve_a_org_inteira(p_org)' in b_org) = 0 then
    raise exception '9031: a derivação de fn_dados_qualidade_do_lead_org_inteira não aplicou a guarda de acesso';
  end if;
  execute b_org;
end $d$;

revoke all on function public.fn_dados_qualidade_do_lead_por_linha(uuid, uuid) from public, anon;
revoke all on function public.fn_dados_qualidade_do_lead_org_inteira(uuid, uuid) from public, anon;
grant execute on function public.fn_dados_qualidade_do_lead_por_linha(uuid, uuid) to authenticated, service_role;
grant execute on function public.fn_dados_qualidade_do_lead_org_inteira(uuid, uuid) to authenticated, service_role;

create or replace function public.fn_dados_qualidade_do_lead(p_org uuid, p_pipeline_id uuid default null)
returns table (
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
  no_universo boolean
)
language plpgsql stable security invoker set search_path = public, pg_temp as $w$
begin
  if public.fn_dados_ve_a_org_inteira(p_org) then
    return query select * from public.fn_dados_qualidade_do_lead_org_inteira(p_org, p_pipeline_id);
  else
    return query select * from public.fn_dados_qualidade_do_lead_por_linha(p_org, p_pipeline_id);
  end if;
end $w$;

revoke execute on function public.fn_dados_qualidade_do_lead(uuid, uuid) from public, anon;
grant execute on function public.fn_dados_qualidade_do_lead(uuid, uuid) to authenticated, service_role;

comment on function public.fn_dados_qualidade_do_lead_org_inteira(uuid, uuid) is
  'Migration 9031: os fatos da nota de qualidade para quem vê a organização INTEIRA (fn_dados_ve_a_org_inteira), sem a RLS linha por linha. SECURITY DEFINER com a pergunta de acesso dentro do corpo: para quem não vê a organização inteira (ou é de outra), devolve zero linhas. Derivada do corpo da 9019.';
comment on function public.fn_dados_qualidade_do_lead_por_linha(uuid, uuid) is
  'Migration 9031: os fatos da nota de qualidade pelo corpo da 9019, SECURITY INVOKER, com a RLS de quem pergunta (atendente em "só os seus").';
