-- manifest: **Ação de automação `remove_tag` e o modo "trocar" do nó de etiqueta do fluxo.** Cria `fn_lead_remover_etiquetas` e `fn_contato_remover_etiquetas`, o espelho de remoção da 0682: a subtração acontece DENTRO do `UPDATE`, sob a trava da linha, e a função devolve o que ficou gravado e o que ESTA chamada removeu. Compara sem diferenciar maiúsculas nem espaços nas pontas. `security definer`, `EXECUTE` só para `service_role`. Faixa do fork (9006). Idempotente; apêndice igual no `baseline.sql`, antes da VARREDURA anon.
-- 9006: remover etiquetas do negócio ou do contato, atômico (fork).
--
-- POR QUE FUNÇÃO SQL, e não ler-filtrar-regravar no aplicativo: é a corrida que a
-- 0682 fechou para o `add_tag`. Dois eventos do mesmo negócio rodam em drenos
-- paralelos; quem lê a lista, filtra e grava o array inteiro apaga a etiqueta que
-- o outro acabou de pôr. Aqui a subtração é refeita sobre a linha vigente.
--
-- Comparação por `lower(btrim())`: o `add_tag` grava o texto como veio, e a
-- regra que remove "1o-Trimestre" não pode falhar calada porque alguém marcou
-- "1o-trimestre". Remover a mais é inofensivo; não remover é o defeito.

create or replace function public.fn_lead_remover_etiquetas(
  p_org uuid,
  p_lead uuid,
  p_etiquetas text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_antes     text[];
  v_removidas text[];
  v_depois    text[];
begin
  if p_etiquetas is null or cardinality(p_etiquetas) = 0 then
    raise exception 'etiquetas_vazio' using errcode = '22023';
  end if;

  -- Sem linha (inexistente OU de outra organização): devolve nulo, sem dizer se
  -- ela existe em outro lugar.
  select coalesce(tags, '{}'::text[])
    into v_antes
    from public.crm_leads
   where organization_id = p_org and id = p_lead
     for update;
  if not found then
    return null;
  end if;

  v_removidas := array(
    select t from unnest(v_antes) as t
     where lower(btrim(t)) in (select lower(btrim(e)) from unnest(p_etiquetas) as e where e is not null)
  );

  -- Nada a remover: sem escrita.
  if cardinality(v_removidas) = 0 then
    return jsonb_build_object('tags', to_jsonb(v_antes), 'removidas', '[]'::jsonb);
  end if;

  update public.crm_leads
     set tags = array(
                  select t from unnest(coalesce(tags, '{}'::text[])) with ordinality as x(t, i)
                   where lower(btrim(t)) not in (select lower(btrim(e)) from unnest(p_etiquetas) as e where e is not null)
                   order by i
                ),
         updated_at = now()
   where organization_id = p_org and id = p_lead
   returning tags into v_depois;

  return jsonb_build_object(
    'tags', to_jsonb(coalesce(v_depois, '{}'::text[])),
    'removidas', to_jsonb(v_removidas)
  );
end
$fn$;

create or replace function public.fn_contato_remover_etiquetas(
  p_org uuid,
  p_contato uuid,
  p_etiquetas text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_antes     text[];
  v_removidas text[];
  v_depois    text[];
begin
  if p_etiquetas is null or cardinality(p_etiquetas) = 0 then
    raise exception 'etiquetas_vazio' using errcode = '22023';
  end if;

  select coalesce(tags, '{}'::text[])
    into v_antes
    from public.contacts
   where organization_id = p_org and id = p_contato
     for update;
  if not found then
    return null;
  end if;

  v_removidas := array(
    select t from unnest(v_antes) as t
     where lower(btrim(t)) in (select lower(btrim(e)) from unnest(p_etiquetas) as e where e is not null)
  );

  if cardinality(v_removidas) = 0 then
    return jsonb_build_object('tags', to_jsonb(v_antes), 'removidas', '[]'::jsonb);
  end if;

  update public.contacts
     set tags = array(
                  select t from unnest(coalesce(tags, '{}'::text[])) with ordinality as x(t, i)
                   where lower(btrim(t)) not in (select lower(btrim(e)) from unnest(p_etiquetas) as e where e is not null)
                   order by i
                ),
         updated_at = now()
   where organization_id = p_org and id = p_contato
   returning tags into v_depois;

  return jsonb_build_object(
    'tags', to_jsonb(coalesce(v_depois, '{}'::text[])),
    'removidas', to_jsonb(v_removidas)
  );
end
$fn$;

-- As DUAS origens de EXECUTE (default privileges do baseline e o grant a PUBLIC
-- do Postgres): estas funções ESCREVEM e não decidem organização nem papel.
revoke all on function public.fn_lead_remover_etiquetas(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function public.fn_contato_remover_etiquetas(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.fn_lead_remover_etiquetas(uuid, uuid, text[]) to service_role;
grant execute on function public.fn_contato_remover_etiquetas(uuid, uuid, text[]) to service_role;

comment on function public.fn_lead_remover_etiquetas(uuid, uuid, text[]) is
  'Remove etiquetas do negócio DENTRO do UPDATE, numa única instrução atômica, e devolve as etiquetas gravadas e as removidas. '
  'Espelho de fn_lead_adicionar_etiquetas para a ação remove_tag. Não decide papel nem organização — isso é de quem chama.';
comment on function public.fn_contato_remover_etiquetas(uuid, uuid, text[]) is
  'Remove etiquetas do contato DENTRO do UPDATE, numa única instrução atômica. Espelho de fn_contato_adicionar_etiquetas.';

notify pgrst, 'reload schema';
