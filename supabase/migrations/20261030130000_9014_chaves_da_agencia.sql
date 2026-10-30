-- manifest: **Chaves da agência (portas MCP Leitura e Admin, multiempresa).** `api_tokens` ganha `ips_permitidos cidr[]` (origem aceita da chave; nulo = qualquer, como sempre foi). Uma chave com escopo `agencia:leitura` ou `agencia:admin` alcança TODAS as organizações da instalação pelas rotas `/api/mcp/agencia` e `/api/mcp/agencia/admin` — e por isso o gatilho `trg_api_tokens_guarda_da_agencia` (BEFORE INSERT/UPDATE) só a deixa nascer com: exatamente esse escopo e nenhum outro; o nome fixo da porta (`gestor-leitura` / `operador-admin`); lista de IPs não vazia; e quem cria sendo platform admin `full` ativo. Depois de criada ela é imutável (escopo, nome, IPs, organização, hash e autor), revogar sempre pode e revogada não volta. Uma chave viva por porta (índice único parcial). Ninguém novo ganha EXECUTE na função. Número 9014, faixa do fork. Idempotente; apêndice igual no `baseline.sql`.
-- 9014: chaves da agência.
--
-- POR QUE EM `api_tokens` E NÃO NUMA TABELA NOVA. A auditoria de toda chamada MCP
-- grava `api_audit_log.actor_api_token_id`, que tem chave estrangeira para
-- `api_tokens`. Uma chave guardada noutra tabela faria cada linha de auditoria
-- da porta Admin falhar a FK — e a auditoria não bloqueia a mutação, então a
-- alteração aconteceria SEM rastro. Morar aqui também traz de graça o hash
-- SHA256, o `last_used_at`, a revogação e a lista na tela de Chaves de API.
--
-- O PERIGO QUE ISTO ABRE, e a cerca. Hoje o escopo é texto livre e o admin de
-- QUALQUER organização cria chave na própria org. Se ele conseguisse gravar
-- `agencia:leitura`, ganharia leitura de todos os outros escritórios. A cerca
-- mora no banco (não na rota), porque é o banco que todos os caminhos atravessam:
-- só um platform admin `full` ATIVO cria esta chave. A rota da agência volta a
-- conferir isso a cada chamada (o grant pode ter sido revogado depois).

alter table public.api_tokens
  add column if not exists ips_permitidos cidr[];

comment on column public.api_tokens.ips_permitidos is
  'Origens aceitas para esta chave (CIDR). Nulo = qualquer origem. Obrigatório nas chaves da agência (migration 9014).';

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
  if v_escopo not in ('agencia:leitura', 'agencia:admin') then
    raise exception 'escopo de agência desconhecido: %', v_escopo using errcode = '23514';
  end if;
  if (v_escopo = 'agencia:leitura' and new.name <> 'gestor-leitura')
     or (v_escopo = 'agencia:admin' and new.name <> 'operador-admin') then
    raise exception 'chave da agência tem nome fixo (gestor-leitura / operador-admin)'
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

drop trigger if exists trg_api_tokens_guarda_da_agencia on public.api_tokens;
create trigger trg_api_tokens_guarda_da_agencia
  before insert or update on public.api_tokens
  for each row execute function public.fn_api_tokens_guarda_da_agencia();

create unique index if not exists uq_api_tokens_chave_da_agencia_viva
  on public.api_tokens (name)
  where revoked_at is null
    and scopes ?| array['agencia:leitura', 'agencia:admin'];
