-- manifest: v3 seção 1 (fork) — tipo de lead no catálogo (tipo_de_lead, valor_confirmado) e o valor do negócio preenchido pelo interesse (custom_fields.servico), com origem do valor (valor_origem) que nunca sobrescreve valor de pessoa
--
-- O QUE É
--
-- Cada tipo de lead do escritório (Auxílio-acidente, BPC/LOAS…) ou da clínica
-- (Implante, Clareamento…) é um item de `catalog_products` com
-- `tipo_de_lead = true`. O `preco_cents` dele é o faturamento médio por caso
-- fechado; `valor_confirmado` diz se o cliente confirmou esse número.
--
-- Quando o interesse do negócio (`crm_leads.custom_fields.servico`) passa a
-- ser o nome de um tipo de lead ativo da MESMA organização, e o valor está
-- vazio (ou foi a própria regra que o preencheu), o valor do negócio recebe o
-- preço do tipo. A comparação de nome ignora maiúscula, acento e pontuação
-- (`fn_nome_do_tipo_de_lead`), a mesma régua de `lib/leads/tipo-de-lead.ts`.
--
-- QUEM PREENCHEU O VALOR — `crm_leads.valor_origem`
--
--   'pessoa'        qualquer escrita de valor fora da regra (tela, proposta,
--                   API, a própria IA pelo `crm_update_lead`);
--   'tipo_de_lead'  a regra desta migration;
--   nulo            sem valor, ou valor anterior a esta migration (= pessoa).
--
-- Vocabulário ABERTO, sem CHECK (doutrina de migrations: clone com valor legado
-- não pode quebrar o `update.sh`); a constante mora em TS. A coluna é do banco:
-- fora da regra, o gatilho reescreve a origem, então nenhum corpo de requisição
-- consegue se declarar 'tipo_de_lead'. A regra se anuncia pela chave de
-- transação `deskcomm.valor_automatico`, que volta ao valor anterior antes do
-- fim do gatilho do catálogo.
--
-- MUDAR O PREÇO DO TIPO muda, na hora, o valor dos negócios ABERTOS daquele tipo
-- cujo valor foi preenchido pela regra; criar (ou ativar, ou renomear) um tipo
-- preenche também os abertos com aquele interesse e sem valor. Valor de pessoa nunca é
-- tocado. Cada valor preenchido pela regra deixa uma linha na linha do tempo do
-- negócio (`valor_pelo_tipo_de_lead`, tipo de vocabulário aberto — ver
-- `lib/leads/activity-vocabulary.ts`). Nenhum gatilho faz HTTP.
--
-- Idempotente: `add column if not exists`, `create or replace`, `drop trigger if
-- exists`. A unicidade do nome só vale para `tipo_de_lead = true`, que nasce
-- falso em toda linha existente — nenhum dado a corrigir antes do índice.

alter table public.catalog_products
  add column if not exists tipo_de_lead boolean not null default false;
alter table public.catalog_products
  add column if not exists valor_confirmado boolean not null default false;
alter table public.crm_leads
  add column if not exists valor_origem text;

comment on column public.catalog_products.tipo_de_lead is
  'true = o item é um TIPO DE LEAD (o que o cliente procura: benefício, procedimento, serviço). O preco_cents é o faturamento médio por caso fechado, e é ele que preenche o valor do negócio (migration 9018).';
comment on column public.catalog_products.valor_confirmado is
  'O cliente confirmou o valor médio deste tipo de lead? Só informativo — o valor vale igual.';
comment on column public.crm_leads.valor_origem is
  'Quem preencheu value_cents: pessoa | tipo_de_lead. Nulo com valor = pessoa. Mantido pelo gatilho fn_lead_valor_pelo_tipo_de_lead (migration 9018).';

-- A régua do nome: sem maiúscula, acento nem pontuação ("BPC/LOAS" = "bpc loas").
create or replace function public.fn_nome_do_tipo_de_lead(p text) returns text
  language sql immutable parallel safe
  set search_path = public, pg_temp
as $fn$
  select nullif(btrim(regexp_replace(lower(translate(coalesce(p, ''),
    'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñÝýÿ',
    'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNnYyy')), '[^a-z0-9]+', ' ', 'g')), '')
$fn$;

revoke execute on function public.fn_nome_do_tipo_de_lead(text) from public, anon;
grant execute on function public.fn_nome_do_tipo_de_lead(text) to authenticated, service_role;

-- O valor do negócio é SEMPRE valor × 100 (também em moeda sem centavos — ver
-- `formatValorDoNegocio` em lib/money.ts); o preço do catálogo está em unidades
-- menores da moeda. Mesma régua de `casasDaMoeda`: 0 casas multiplica por 100,
-- 3 casas divide por 10.
create or replace function public.fn_valor_do_negocio_pelo_preco(p_preco bigint, p_moeda text) returns bigint
  language sql immutable parallel safe
  set search_path = public, pg_temp
as $fn$
  select case
    when p_preco is null then null
    when upper(coalesce(p_moeda, '')) in ('PYG','JPY','CLP','KRW','VND','ISK','UGX','XAF','XOF','XPF','KMF','GNF','RWF','DJF','BIF','VUV')
      then p_preco * 100
    when upper(coalesce(p_moeda, '')) in ('KWD','BHD','OMR','JOD','TND','LYD')
      then round(p_preco / 10.0)::bigint
    else p_preco
  end
$fn$;

revoke execute on function public.fn_valor_do_negocio_pelo_preco(bigint, text) from public, anon;
grant execute on function public.fn_valor_do_negocio_pelo_preco(bigint, text) to authenticated, service_role;

-- Um nome por tipo de lead na organização: é o que deixa a IA gravar o nome
-- exato sem ambiguidade. Só para tipo_de_lead (produto comum segue livre).
create unique index if not exists catalog_products_org_tipo_de_lead_nome_key
  on public.catalog_products (organization_id, public.fn_nome_do_tipo_de_lead(nome))
  where tipo_de_lead;

-- ── O gatilho do negócio (BEFORE) ─────────────────────────────────────────────
create or replace function public.fn_lead_valor_pelo_tipo_de_lead() returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $fn$
declare
  v_regra boolean := coalesce(current_setting('deskcomm.valor_automatico', true), '') = 'on';
  v_novo text := public.fn_nome_do_tipo_de_lead(new.custom_fields->>'servico');
  v_velho text;
  v_item record;
begin
  -- 1 · Quem preencheu o valor. Fora da regra, valor mudado é de pessoa; valor
  --     igual guarda a origem que já estava (o corpo da escrita não decide).
  if tg_op = 'INSERT' then
    if not v_regra then
      new.valor_origem := case when new.value_cents is null then null else 'pessoa' end;
    end if;
  else
    v_velho := public.fn_nome_do_tipo_de_lead(old.custom_fields->>'servico');
    if not v_regra then
      if new.value_cents is distinct from old.value_cents then
        new.valor_origem := case when new.value_cents is null then null else 'pessoa' end;
      else
        new.valor_origem := old.valor_origem;
      end if;
    end if;
  end if;

  -- 2 · O interesse mudou? Sem interesse, ou o mesmo de antes, nada a fazer.
  if v_novo is null or (tg_op = 'UPDATE' and v_novo is not distinct from v_velho) then
    return new;
  end if;
  -- Valor de pessoa (ou de antes desta migration) nunca é sobrescrito.
  if new.value_cents is not null and new.valor_origem is distinct from 'tipo_de_lead' then
    return new;
  end if;

  -- 3 · O tipo de lead ativo da MESMA organização, pelo nome normalizado.
  select p.preco_cents, p.moeda into v_item
    from public.catalog_products p
   where p.organization_id = new.organization_id
     and p.tipo_de_lead
     and p.ativo
     and public.fn_nome_do_tipo_de_lead(p.nome) = v_novo
   order by p.updated_at desc, p.id
   limit 1;
  if not found then
    return new;
  end if;

  new.value_cents := public.fn_valor_do_negocio_pelo_preco(v_item.preco_cents, v_item.moeda);
  new.currency := v_item.moeda;
  new.valor_origem := 'tipo_de_lead';
  return new;
end $fn$;

revoke execute on function public.fn_lead_valor_pelo_tipo_de_lead() from public, anon, authenticated;

drop trigger if exists trg_crm_leads_valor_pelo_tipo_de_lead on public.crm_leads;
-- Só as colunas que a regra lê: `valor_origem` entra para que nenhuma escrita a
-- declare por conta própria sem passar por aqui.
create trigger trg_crm_leads_valor_pelo_tipo_de_lead
  before insert or update of value_cents, custom_fields, valor_origem on public.crm_leads
  for each row execute function public.fn_lead_valor_pelo_tipo_de_lead();

-- ── A linha do tempo (AFTER) ──────────────────────────────────────────────────
create or replace function public.fn_lead_valor_pelo_tipo_de_lead_atividade() returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE'
     and old.valor_origem is not distinct from new.valor_origem
     and old.value_cents is not distinct from new.value_cents
     and old.currency is not distinct from new.currency then
    return null;
  end if;

  insert into public.crm_lead_activities
    (organization_id, lead_id, contact_id, source_module, source_id, type, actor_kind, reason, payload)
  values (
    new.organization_id, new.id, new.contact_id, 'crm', new.id,
    'valor_pelo_tipo_de_lead', 'system',
    case when tg_op = 'UPDATE' and old.valor_origem = 'tipo_de_lead'
      then 'Valor do caso atualizado pelo valor do tipo de lead'
      else 'Valor do caso preenchido pelo tipo de lead' end,
    jsonb_build_object(
      'value_cents', new.value_cents,
      'currency', new.currency,
      'valor_antes', case when tg_op = 'UPDATE' then old.value_cents end
    )
  );
  return null;
end $fn$;

revoke execute on function public.fn_lead_valor_pelo_tipo_de_lead_atividade() from public, anon, authenticated;

drop trigger if exists trg_crm_leads_valor_pelo_tipo_de_lead_atividade on public.crm_leads;
create trigger trg_crm_leads_valor_pelo_tipo_de_lead_atividade
  after insert or update of value_cents, custom_fields, valor_origem on public.crm_leads
  for each row when (new.valor_origem = 'tipo_de_lead')
  execute function public.fn_lead_valor_pelo_tipo_de_lead_atividade();

-- ── O preço do tipo propaga para os abertos (AFTER no catálogo) ───────────────
create or replace function public.fn_tipo_de_lead_propaga_valor() returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $fn$
declare
  v_antes text;
  v_nome text := public.fn_nome_do_tipo_de_lead(new.nome);
  v_valor bigint;
  -- Tipo que PASSA A EXISTIR para o gatilho (criado, ativado, renomeado ou
  -- marcado como tipo de lead) preenche também os abertos sem valor; mudança só
  -- de preço alcança apenas os que a regra preencheu. Valor que alguém apagou à
  -- mão não volta sozinho por causa de um preço novo.
  v_tipo_novo boolean;
begin
  if not new.tipo_de_lead or not new.ativo or v_nome is null then
    return null;
  end if;
  v_tipo_novo := tg_op = 'INSERT'
    or not old.tipo_de_lead or not old.ativo
    or v_nome is distinct from public.fn_nome_do_tipo_de_lead(old.nome);
  if not v_tipo_novo
     and new.preco_cents is not distinct from old.preco_cents
     and new.moeda is not distinct from old.moeda then
    return null;
  end if;

  v_valor := public.fn_valor_do_negocio_pelo_preco(new.preco_cents, new.moeda);
  v_antes := current_setting('deskcomm.valor_automatico', true);
  perform set_config('deskcomm.valor_automatico', 'on', true);

  update public.crm_leads l
     set value_cents = v_valor,
         currency = new.moeda,
         valor_origem = 'tipo_de_lead'
   where l.organization_id = new.organization_id
     and l.status = 'open'
     and public.fn_nome_do_tipo_de_lead(l.custom_fields->>'servico') = v_nome
     and (l.valor_origem = 'tipo_de_lead' or (v_tipo_novo and l.value_cents is null))
     and (l.value_cents is distinct from v_valor
          or l.currency is distinct from new.moeda
          or l.valor_origem is distinct from 'tipo_de_lead');

  perform set_config('deskcomm.valor_automatico', coalesce(v_antes, ''), true);
  return null;
end $fn$;

revoke execute on function public.fn_tipo_de_lead_propaga_valor() from public, anon, authenticated;

drop trigger if exists trg_catalog_products_tipo_de_lead_propaga on public.catalog_products;
create trigger trg_catalog_products_tipo_de_lead_propaga
  after insert or update on public.catalog_products
  for each row execute function public.fn_tipo_de_lead_propaga_valor();

notify pgrst, 'reload schema';
