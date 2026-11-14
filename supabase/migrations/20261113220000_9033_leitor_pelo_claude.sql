-- manifest: PC-036 (fork) — Leitor pelo Claude. A ficha do lead (`crm_lead_ficha` e o histórico) ganha `origem` (`leitor_do_crm`, o padrão: o Leitor do CRM; `leitor_0530`: a tarefa diária do Claude pela porta Ficha; `gestor_17h10`: a correção do Gestor, PC-037), copiada pelo gatilho do histórico; `leitor_rodadas.origem` aceita `claude` (uma por organização e dia); e a chave da agência ganha a terceira porta, `agencia:ficha` com o nome fixo `gestor-ficha`, que lê a conversa para o Leitor e grava SÓ a ficha. A guarda das chaves (9014) e o índice de uma chave viva por porta passam a conhecer a porta nova. Número 9033, faixa do fork. Idempotente; apêndice igual no `baseline.sql`.
--
-- 9033: Leitor pelo Claude (PC-036).
--
-- POR QUE `origem` NA FICHA. Até aqui só o Leitor do CRM gravava a ficha, e o
-- `modelo` bastava para dizer quem leu. Com a tarefa do Claude e, depois, a
-- correção do Gestor (PC-037), a ficha tem três autores — e a precedência do
-- PC-037 ("a leitura das 05h30 não sobrescreve a correção do Gestor") precisa
-- saber qual. O padrão `leitor_do_crm` mantém a gravação do Leitor do CRM igual:
-- ele não manda a coluna, e nada do caminho dele depende desta migration.
--
-- POR QUE A RODADA `claude`. O retrato das 06:00 espera o Leitor terminar.
-- A tarefa do Claude abre a rodada do dia quando pergunta quem ler e a fecha ao
-- terminar; o retrato espera só a rodada que já abriu (uma tarefa que faltou
-- não deixa o painel sem número). Uma por organização e dia, como a diária.
--
-- A PORTA FICHA. Mesma cerca das outras duas (9014): um escopo só, nome fixo,
-- IPs obrigatórios, criada pelo platform admin `full` ativo, imutável depois de
-- criada. Quem a usa só alcança organização com a escolha `claude` — isso a
-- rota confere a cada chamada (a configuração muda depois do INSERT).

-- ─── a origem da ficha ─────────────────────────────────────────────────────
alter table public.crm_lead_ficha
  add column if not exists origem text not null default 'leitor_do_crm';
alter table public.crm_lead_ficha_historico
  add column if not exists origem text not null default 'leitor_do_crm';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_lead_ficha_origem_check') then
    alter table public.crm_lead_ficha
      add constraint crm_lead_ficha_origem_check
      check (origem in ('leitor_do_crm', 'leitor_0530', 'gestor_17h10'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_lead_ficha_historico_origem_check') then
    alter table public.crm_lead_ficha_historico
      add constraint crm_lead_ficha_historico_origem_check
      check (origem in ('leitor_do_crm', 'leitor_0530', 'gestor_17h10'));
  end if;
end $$;

comment on column public.crm_lead_ficha.origem is
  'PC-036 (migration 9033): quem leu — leitor_do_crm (o Leitor do CRM, padrão), leitor_0530 (a tarefa diária do Claude pela porta Ficha) ou gestor_17h10 (a correção do Gestor, PC-037).';
comment on column public.crm_lead_ficha_historico.origem is
  'PC-036 (migration 9033): quem tinha lido a ficha substituída (mesmo vocabulário de crm_lead_ficha.origem).';

-- O gatilho do histórico passa a copiar a origem da leitura substituída.
create or replace function public.fn_crm_lead_ficha_guarda_a_anterior()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  insert into public.crm_lead_ficha_historico
    (organization_id, lead_id, contact_id, ficha, atendido_por, modelo, versao_prompt, gatilho, lida_em, mensagens_ate, origem)
  values
    (old.organization_id, old.lead_id, old.contact_id, old.ficha, old.atendido_por, old.modelo, old.versao_prompt,
     old.gatilho, old.lida_em, old.mensagens_ate, old.origem);
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.fn_crm_lead_ficha_guarda_a_anterior() from public, anon;
revoke execute on function public.fn_crm_lead_ficha_guarda_a_anterior() from authenticated;

-- ─── a rodada do Claude ────────────────────────────────────────────────────
alter table public.leitor_rodadas
  drop constraint if exists leitor_rodadas_origem_check;
alter table public.leitor_rodadas
  add constraint leitor_rodadas_origem_check check (origem in ('diaria', 'manual', 'claude'));

create unique index if not exists leitor_rodadas_uma_do_claude_por_dia
  on public.leitor_rodadas (organization_id, dia)
  where origem = 'claude';

comment on table public.leitor_rodadas is
  'PM-027 §3 (migration 9022): as rodadas do Leitor da conversa — a diária das 06:00 no fuso da organização (uma por dia), as do "Atualizar agora" e, desde a 9033 (PC-036), a do Claude (uma por dia, aberta e fechada pela porta Ficha da agência). O retrato das 06:00 espera a diária terminar. Sem texto de conversa. Leitura: membro da organização; escrita só pelo service_role.';

-- ─── a porta Ficha nas chaves da agência ───────────────────────────────────
create or replace function public.fn_api_tokens_guarda_da_agencia()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_novo_agencia text[];
  v_velho_agencia text[];
  v_escopo text;
begin
  select coalesce(array_agg(s), '{}') into v_novo_agencia
    from jsonb_array_elements_text(
      case when jsonb_typeof(new.scopes) = 'array' then new.scopes else '[]'::jsonb end
    ) s
   where s like 'agencia:%';

  if tg_op = 'UPDATE' then
    select coalesce(array_agg(s), '{}') into v_velho_agencia
      from jsonb_array_elements_text(
        case when jsonb_typeof(old.scopes) = 'array' then old.scopes else '[]'::jsonb end
      ) s
     where s like 'agencia:%';
    if cardinality(v_velho_agencia) = 0 and cardinality(v_novo_agencia) = 0 then
      return new;
    end if;
    -- Chave da agência é imutável: só revogar e carimbar uso.
    if new.scopes is distinct from old.scopes
       or new.name is distinct from old.name
       or new.ips_permitidos is distinct from old.ips_permitidos
       or new.organization_id is distinct from old.organization_id
       or new.token_hash is distinct from old.token_hash
       or new.created_by is distinct from old.created_by
       or new.expires_at is distinct from old.expires_at then
      raise exception 'chave da agência não pode ser alterada; revogue e crie outra'
        using errcode = '23514';
    end if;
    if old.revoked_at is not null and new.revoked_at is null then
      raise exception 'chave da agência revogada não volta'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if cardinality(v_novo_agencia) = 0 then
    return new;
  end if;

  if cardinality(v_novo_agencia) <> 1 or jsonb_array_length(new.scopes) <> 1 then
    raise exception 'chave da agência leva exatamente um escopo agencia:* e nenhum outro'
      using errcode = '23514';
  end if;

  v_escopo := v_novo_agencia[1];
  if v_escopo not in ('agencia:leitura', 'agencia:admin', 'agencia:ficha') then
    raise exception 'escopo de agência desconhecido: %', v_escopo using errcode = '23514';
  end if;
  if (v_escopo = 'agencia:leitura' and new.name <> 'gestor-leitura')
     or (v_escopo = 'agencia:admin' and new.name <> 'operador-admin')
     or (v_escopo = 'agencia:ficha' and new.name <> 'gestor-ficha') then
    raise exception 'chave da agência tem nome fixo (gestor-leitura / operador-admin / gestor-ficha)'
      using errcode = '23514';
  end if;
  if new.ips_permitidos is null or cardinality(new.ips_permitidos) = 0 then
    raise exception 'chave da agência precisa de lista de IPs permitidos'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.platform_admins pa
     where pa.user_id = new.created_by
       and pa.revoked_at is null
       and pa.scope = 'full'
  ) then
    raise exception 'só o dono da instalação (platform admin full) cria chave da agência'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_api_tokens_guarda_da_agencia() from public, anon, authenticated;

-- Uma chave viva por porta: o índice passa a conhecer a porta Ficha. Recriado
-- (o predicado de um índice parcial não se altera no lugar).
drop index if exists public.uq_api_tokens_chave_da_agencia_viva;
create unique index if not exists uq_api_tokens_chave_da_agencia_viva
  on public.api_tokens (name)
  where revoked_at is null
    and scopes ?| array['agencia:leitura', 'agencia:admin', 'agencia:ficha'];
