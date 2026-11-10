-- manifest: **Assinatura eletrônica integrada (PC-030, parte 1).** `assinatura_eletronica_contas` (uma por organização, só do servidor): o serviço escolhido (hoje `zapsign`; Clicksign, D4Sign e Autentique entram um por vez), o ambiente (teste/produção), a chave da API cifrada em AES-GCM (colunas `*_encrypted/_iv/_tag` + `chave_last4`, molde de `ai_provider_credentials`), a aprovação da equipe antes do envio (desligada por padrão, decisão do João em 10/11/2026), o prazo para assinar e o id do aviso cadastrado no serviço. `contrato_modelos`: o modelo de contrato por benefício/produto, com corpo e variáveis, campos obrigatórios, versão e a marca "aprovado pelo advogado em" (sem aprovação a IA não usa; mudar o texto sobe a versão e tira a aprovação) — leitura pela organização (RLS), escrita só pelo servidor. `crm_contracts`: status `expirado`, provedor `zapsign`, `visualizado_em`, o modelo e a versão que geraram o arquivo e a origem do envio (`pessoa`/`ia`). Número 9027, faixa do fork. Idempotente; apêndice igual no `baseline.sql`, antes da VARREDURA anon.
-- 9027: assinatura eletrônica integrada (PC-030, parte 1).
--
-- Nenhum gatilho faz HTTP. A chave da API do serviço nunca é gravada em claro
-- e nenhum papel do PostgREST lê a tabela de contas: só o servidor (service
-- role), que abre a chave no escopo de uma chamada ao serviço.

-- ─── 1) A conta de assinatura eletrônica da organização ─────────────────────
create table if not exists public.assinatura_eletronica_contas (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  provedor text not null,
  ambiente text not null default 'producao',
  chave_encrypted bytea,
  chave_iv bytea,
  chave_tag bytea,
  chave_last4 text,
  -- Decisão do João (10/11/2026): a IA envia sozinha; a equipe aprova antes só
  -- quando o dono liga isto.
  aprovacao_da_equipe boolean not null default false,
  prazo_para_assinar_dias integer not null default 7,
  -- O aviso (webhook) cadastrado no serviço, para trocar sem deixar o antigo.
  aviso_id_no_servico text,
  aviso_registrado_em timestamptz,
  -- O caminho e o hash do segredo do aviso DESTE serviço. Próprios, e não os
  -- da porta genérica (`assinatura_webhook_chaves`, PC-003): salvar a conta
  -- não pode trocar o segredo de uma integração que o escritório já usa, nem
  -- a troca da porta genérica pode cortar o aviso do serviço.
  aviso_path_token text,
  aviso_segredo_sha256 text,
  ativo boolean not null default true,
  atualizado_por_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assinatura_eletronica_contas_provedor_check
    check (provedor = any (array['zapsign']::text[])),
  constraint assinatura_eletronica_contas_ambiente_check
    check (ambiente = any (array['teste', 'producao']::text[])),
  constraint assinatura_eletronica_contas_prazo_check
    check (prazo_para_assinar_dias between 1 and 60)
);

alter table public.assinatura_eletronica_contas enable row level security;
revoke all on public.assinatura_eletronica_contas from public, anon, authenticated;
grant all on public.assinatura_eletronica_contas to service_role;

-- Banco que recebeu a tabela antes destas duas colunas (idempotente).
alter table public.assinatura_eletronica_contas add column if not exists aviso_path_token text;
alter table public.assinatura_eletronica_contas add column if not exists aviso_segredo_sha256 text;

create unique index if not exists assinatura_eletronica_contas_aviso_token_idx
  on public.assinatura_eletronica_contas (aviso_path_token)
  where aviso_path_token is not null;

drop trigger if exists trg_assinatura_eletronica_contas_updated_at on public.assinatura_eletronica_contas;
create trigger trg_assinatura_eletronica_contas_updated_at
  before update on public.assinatura_eletronica_contas
  for each row execute function public.fn_set_updated_at();

comment on table public.assinatura_eletronica_contas is
  'PC-030 (migration 9027): o serviço de assinatura eletrônica da organização. A chave da API fica cifrada (AES-GCM, chave da instalação); só o servidor lê. Uma linha por organização.';

-- ─── 2) Os modelos de contrato ─────────────────────────────────────────────
create table if not exists public.contrato_modelos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nome text not null,
  -- O benefício/produto que o modelo cobre (o valor do campo "Interesse" do
  -- negócio, `custom_fields.servico`). Nulo = vale para qualquer interesse.
  interesse text,
  -- O texto do contrato com variáveis `{{nome_completo}}`, `{{cpf}}`…
  corpo text not null,
  -- Chaves dos campos do negócio que precisam estar CONFIRMADOS para gerar.
  campos_obrigatorios text[] not null default '{}',
  versao integer not null default 1,
  aprovado_em timestamptz,
  aprovado_por_nome text,
  aprovado_por_user_id uuid references auth.users(id) on delete set null,
  ativo boolean not null default true,
  criado_por_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contrato_modelos_nome_check check (char_length(btrim(nome)) between 1 and 120),
  constraint contrato_modelos_corpo_check check (char_length(corpo) between 1 and 60000),
  constraint contrato_modelos_versao_check check (versao >= 1),
  constraint contrato_modelos_aprovacao_check
    check ((aprovado_em is null) = (aprovado_por_nome is null))
);

create index if not exists contrato_modelos_org_idx
  on public.contrato_modelos (organization_id, ativo, interesse);

alter table public.contrato_modelos enable row level security;
drop policy if exists tenant_isolation_contrato_modelos_select on public.contrato_modelos;
create policy tenant_isolation_contrato_modelos_select on public.contrato_modelos
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.contrato_modelos from public, anon, authenticated;
grant select on public.contrato_modelos to authenticated;
grant all on public.contrato_modelos to service_role;

drop trigger if exists trg_contrato_modelos_updated_at on public.contrato_modelos;
create trigger trg_contrato_modelos_updated_at
  before update on public.contrato_modelos
  for each row execute function public.fn_set_updated_at();

comment on table public.contrato_modelos is
  'PC-030 (migration 9027): modelo de contrato por benefício/produto, com variáveis e versão. Sem "aprovado pelo advogado em" a IA não usa; mudar o corpo sobe a versão e tira a aprovação (feito pelo servidor). Leitura pela organização; escrita só pelo servidor.';

-- ─── 3) O contrato do negócio ganha o que o serviço conta ──────────────────
alter table public.crm_contracts add column if not exists visualizado_em timestamptz;
alter table public.crm_contracts add column if not exists modelo_id uuid references public.contrato_modelos(id) on delete set null;
alter table public.crm_contracts add column if not exists modelo_versao integer;
alter table public.crm_contracts add column if not exists origem_envio text not null default 'pessoa';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_contracts_origem_envio_check') then
    alter table public.crm_contracts
      add constraint crm_contracts_origem_envio_check
      check (origem_envio = any (array['pessoa', 'ia']::text[]));
  end if;
end $$;

-- Status e provedor: os conjuntos crescem (o antigo é subconjunto do novo,
-- então nenhuma linha existente fica de fora — nada a corrigir antes).
alter table public.crm_contracts drop constraint if exists crm_contracts_status_check;
alter table public.crm_contracts
  add constraint crm_contracts_status_check
  check (status = any (array['rascunho', 'enviado', 'assinado', 'recusado', 'expirado', 'cancelado']::text[]));

alter table public.crm_contracts drop constraint if exists crm_contracts_provedor_assinatura_check;
alter table public.crm_contracts
  add constraint crm_contracts_provedor_assinatura_check
  check (provedor_assinatura = any (array['manual', 'zapsign']::text[]));

-- O aviso do serviço acha o contrato pelo id do documento NO SERVIÇO.
create index if not exists crm_contracts_documento_no_servico_idx
  on public.crm_contracts (organization_id, provedor_documento_id)
  where provedor_documento_id is not null;

-- O modelo do contrato é da MESMA organização. O servidor escreve com
-- service_role, que ignora RLS: esta trava separa o vizinho de um id trocado
-- (molde de `fn_crm_contracts_org_consistente`, 9008).
create or replace function public.fn_crm_contracts_modelo_da_org()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.modelo_id is not null and not exists (
    select 1 from public.contrato_modelos where id = new.modelo_id and organization_id = new.organization_id
  ) then
    raise exception 'crm_contract_modelo_org_mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_crm_contracts_modelo_da_org() from public, anon, authenticated;

drop trigger if exists trg_crm_contracts_modelo_da_org on public.crm_contracts;
create trigger trg_crm_contracts_modelo_da_org
  before insert or update of modelo_id, organization_id on public.crm_contracts
  for each row execute function public.fn_crm_contracts_modelo_da_org();
