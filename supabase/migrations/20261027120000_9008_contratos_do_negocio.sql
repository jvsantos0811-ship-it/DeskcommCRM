-- manifest: **Contratos do negócio: o escritório anexa o PDF do contrato ao card, uma pessoa da equipe envia pelo WhatsApp e marca o desfecho.** Tabela `crm_contracts` (organização, negócio, contato, conversa, título, arquivo, status `rascunho`/`enviado`/`assinado`/`recusado`/`cancelado`, provedor de assinatura — hoje só `manual` —, id e link do documento no serviço de assinatura para quando um for ligado, a mensagem do envio, quem enviou e quem decidiu) e bucket privado `contratos` (só PDF, 20 MB). Leitura por organização (RLS); escrita só pelo servidor, pelas rotas de sessão `agent`+ — nenhuma ferramenta de IA nem token de integração alcança. Negócio, contato e conversa `on delete set null`: contrato é documento e sobrevive ao card. Na virada de `is_anonymized` do contato, os arquivos entram na fila de expurgo do Storage e título/nome do arquivo/motivo/link saem; status e datas ficam. Gatilho de consistência de organização. Decisão do dono (item 7 do briefing de 26/10/2026). Número 9008, faixa do fork. Idempotente; apêndice igual no `baseline.sql`, antes da VARREDURA anon.
-- 9008: contratos do negócio.
--
-- ─── O que faltava ──────────────────────────────────────────────────────────
--
-- No escritório, o negócio fecha quando o cliente assina o contrato. O CRM
-- levava o cliente até ali e parava: o contrato saía por fora (o WhatsApp do
-- celular de alguém, um e-mail), e o card não sabia se ele tinha saído, se o
-- cliente tinha assinado, nem quem mandou. "Assinou?" virava pergunta de
-- corredor — e contrato esquecido em "vou mandar" é cliente que esfria.
--
-- ─── O desenho, e por que a escrita é só do servidor ────────────────────────
--
-- A equipe sobe o PDF do PRÓPRIO escritório no card; uma pessoa clica em
-- "Enviar ao cliente", e o arquivo sai pelo WhatsApp da conversa do contato,
-- com nome legível. Depois alguém marca "assinado" (opcionalmente com o PDF
-- assinado) ou "recusado". Tudo entra na linha do tempo do negócio.
--
-- O mesmo desenho de `scheduled_messages` (9001): `authenticated` só LÊ, pela
-- policy de organização; criar, enviar e decidir passam pelas rotas, que
-- conferem o papel (`agent`+), o suporte só-leitura, a janela de disparo do
-- canal e auditam. As rotas são de SESSÃO (fora de `lib/auth/public-paths.ts`):
-- nenhum agente de IA, ferramenta MCP ou token de integração envia contrato.
--
-- ─── Por que já nasce com o provedor de assinatura ──────────────────────────
--
-- Decisão do dono: "deixar preparado para o serviço de assinatura; por enquanto
-- um humano envia". `provedor_assinatura` (hoje só `manual`),
-- `provedor_documento_id` e `link_assinatura` são o lugar onde um ZapSign,
-- Clicksign ou equivalente vai escrever quando for ligado — sem migration de
-- dado depois. O encaixe de código é `lib/contratos/provedores.ts`.
--
-- ─── Por que negócio e contato são SET NULL ─────────────────────────────────
--
-- Contrato enviado é documento: apagar o card não pode apagar o registro do que
-- o cliente recebeu (anti-pattern 7, cascata fantasma — a mesma lição da D10
-- das propostas). A Zona de perigo, que apaga o atendimento de uma organização
-- de propósito, ganha `crm_contracts` como raiz própria e esvazia a pasta do
-- bucket, pelo mesmo motivo de `crm_proposals`.
--
-- ─── LGPD ───────────────────────────────────────────────────────────────────
--
-- O PDF leva o nome, o CPF e o endereço do cliente. Na virada de
-- `is_anonymized` do contato (a porta por onde passam os dois caminhos de
-- anonimização — desenho da 0391), os arquivos entram em
-- `storage_redaction_queue` (bucket `contratos`; só caminhos da PRÓPRIA
-- organização) e o título, o nome do arquivo, o motivo e o link saem. Status e
-- datas ficam: dizem que houve um contrato, não de quem. A cópia que saiu pelo
-- WhatsApp mora em `whatsapp-media`, na pasta da conversa, e a cascata a apaga
-- com as outras mídias da conversa. Escritório que precisa guardar o contrato
-- por obrigação legal não anonimiza — a LGPD (art. 16) permite recusar.
--
-- Escrita local, na mesma transação; nenhum HTTP (anti-pattern 9).

create table if not exists public.crm_contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid references public.crm_leads(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  -- A conversa por onde o contrato saiu da última vez.
  conversation_id uuid references public.conversations(id) on delete set null,
  titulo text not null,
  -- `contratos/<org>/<id>.pdf`. Nulo depois do expurgo da LGPD.
  arquivo_path text,
  -- O nome com que o arquivo foi anexado, para a equipe reconhecer.
  arquivo_nome text,
  arquivo_bytes integer,
  status text not null default 'rascunho',
  provedor_assinatura text not null default 'manual',
  -- O documento no serviço de assinatura, quando houver um.
  provedor_documento_id text,
  link_assinatura text,
  -- `contratos/<org>/<id>-assinado.pdf`, quando a equipe anexa a via assinada.
  assinado_path text,
  -- A mensagem do último envio: o elo com o fio da conversa e com o status de
  -- entrega, que é LIDO dela (nunca copiado para cá).
  message_id uuid references public.messages(id) on delete set null,
  -- Por que o último envio não saiu, em português, para a tela mostrar.
  ultima_falha_envio text,
  -- O motivo de recusa ou de cancelamento, escrito pela equipe.
  motivo text,
  enviado_em timestamptz,
  enviado_por_user_id uuid references auth.users(id) on delete set null,
  decidido_em timestamptz,
  decidido_por_user_id uuid references auth.users(id) on delete set null,
  criado_por_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_contracts_status_check
    check (status in ('rascunho', 'enviado', 'assinado', 'recusado', 'cancelado')),
  -- Escrito como conjunto (`= any (array[...])`) mesmo com um valor só: um
    -- `in ('manual')` o Postgres guarda como `= 'manual'`, e o par banco ×
    -- TypeScript (vocabulario-banco-x-typescript) não o reconheceria como
    -- vocabulário. O serviço de assinatura entra AQUI, no array.
  constraint crm_contracts_provedor_assinatura_check
    check (provedor_assinatura = any (array['manual']::text[])),
  constraint crm_contracts_titulo_check
    check (char_length(btrim(titulo)) between 1 and 120)
);

-- O que a tela lê: os contratos de UM negócio, do mais novo ao mais velho.
create index if not exists crm_contracts_lead_idx
  on public.crm_contracts (organization_id, lead_id, created_at desc);
-- O que a anonimização lê: os contratos de UM contato.
create index if not exists crm_contracts_contato_idx
  on public.crm_contracts (organization_id, contact_id);

alter table public.crm_contracts enable row level security;
drop policy if exists tenant_isolation_crm_contracts_select on public.crm_contracts;
create policy tenant_isolation_crm_contracts_select on public.crm_contracts
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.crm_contracts from public, anon, authenticated;
grant select on public.crm_contracts to authenticated;
grant all on public.crm_contracts to service_role;

drop trigger if exists trg_crm_contracts_updated_at on public.crm_contracts;
create trigger trg_crm_contracts_updated_at
  before update on public.crm_contracts
  for each row execute function public.fn_set_updated_at();

-- O contrato não aponta para outra organização. O servidor escreve com
-- service_role, que ignora RLS: esta trava é o que separa o vizinho de um id
-- trocado (molde de `fn_verificar_org_da_proposta`, 0465).
create or replace function public.fn_crm_contracts_org_consistente()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.lead_id is not null and not exists (
    select 1 from public.crm_leads where id = new.lead_id and organization_id = new.organization_id
  ) then
    raise exception 'crm_contract_lead_org_mismatch' using errcode = '23514';
  end if;
  if new.contact_id is not null and not exists (
    select 1 from public.contacts where id = new.contact_id and organization_id = new.organization_id
  ) then
    raise exception 'crm_contract_contact_org_mismatch' using errcode = '23514';
  end if;
  if new.conversation_id is not null and not exists (
    select 1 from public.conversations where id = new.conversation_id and organization_id = new.organization_id
  ) then
    raise exception 'crm_contract_conversation_org_mismatch' using errcode = '23514';
  end if;
  if new.message_id is not null and not exists (
    select 1 from public.messages where id = new.message_id and organization_id = new.organization_id
  ) then
    raise exception 'crm_contract_message_org_mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_crm_contracts_org_consistente() from public, anon, authenticated;

drop trigger if exists trg_crm_contracts_org_consistente on public.crm_contracts;
create trigger trg_crm_contracts_org_consistente
  before insert or update of organization_id, lead_id, contact_id, conversation_id, message_id
  on public.crm_contracts
  for each row execute function public.fn_crm_contracts_org_consistente();

-- A virada de is_anonymized do contato: os arquivos vão para a fila de expurgo
-- do Storage e o texto que nomeia a pessoa sai. Molde de
-- `fn_redigir_b2b_do_contato_anonimizado` (0449).
create or replace function public.fn_redigir_contratos_ao_anonimizar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Só caminhos da PRÓPRIA organização: um caminho gravado errado não pode
  -- mandar para o expurgo o arquivo de outra (o expurgo não confia na linha).
  insert into public.storage_redaction_queue (organization_id, request_id, bucket, object_path)
  select new.organization_id, null, 'contratos', p.caminho
    from public.crm_contracts c
    cross join lateral (values (c.arquivo_path), (c.assinado_path)) as p(caminho)
   where c.organization_id = new.organization_id
     and c.contact_id = new.id
     and p.caminho is not null
     and p.caminho like new.organization_id::text || '/%'
  on conflict (bucket, object_path) do nothing;

  update public.crm_contracts
     set titulo = 'Contrato (anonimizado)',
         arquivo_path = null,
         arquivo_nome = null,
         assinado_path = null,
         link_assinatura = null,
         motivo = null,
         ultima_falha_envio = null
   where organization_id = new.organization_id
     and contact_id = new.id;
  return new;
end;
$$;

revoke execute on function public.fn_redigir_contratos_ao_anonimizar() from public, anon, authenticated;
grant  execute on function public.fn_redigir_contratos_ao_anonimizar() to service_role;

drop trigger if exists trg_redigir_contratos_ao_anonimizar on public.contacts;
create trigger trg_redigir_contratos_ao_anonimizar
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function public.fn_redigir_contratos_ao_anonimizar();

-- Bucket privado, URL sempre assinada, lido só pelo servidor — mesmo padrão de
-- `propostas` e `lgpd-exports`. Sem policy em storage.objects: `service_role`
-- ignora RLS, e uma policy aqui seria decorativa.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contratos', 'contratos', false, 20971520, array['application/pdf'])
on conflict (id) do nothing;

comment on table public.crm_contracts is
  'Contrato do negócio: o PDF do escritório, enviado ao cliente pelo WhatsApp por uma pessoa da equipe, com o desfecho marcado à mão (ou, um dia, pelo serviço de assinatura). Escrita só pelo servidor. Migration 9008 (fork).';
comment on column public.crm_contracts.provedor_assinatura is
  'Quem colhe a assinatura. Hoje só manual (uma pessoa marca o desfecho). O encaixe de um serviço de assinatura eletrônica é lib/contratos/provedores.ts.';
comment on column public.crm_contracts.message_id is
  'A mensagem do último envio. O status de entrega é LIDO dela (DIRC: calcular), nunca copiado para esta linha.';
