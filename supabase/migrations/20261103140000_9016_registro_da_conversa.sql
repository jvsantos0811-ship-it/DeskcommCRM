-- manifest: PC-019 (fork) — registro da conversa por contato (perguntas feitas e respondidas, licenças, promessas), gravado no fechamento do turno e lido por todo agente; apagado na anonimização
--
-- O que a IA JÁ PERGUNTOU, o que o cliente RESPONDEU, as LICENÇAS que ele deu e
-- o que a IA PROMETEU. É do CONTATO, não do agente nem da conversa: sobrevive à
-- compactação do histórico e à troca de agente (roteador e PC-014). Uma linha
-- por item; `chave` é o tema normalizado, para o fechamento do turno seguinte
-- atualizar o mesmo item em vez de duplicar.
--
-- Dado de saúde só como tema ("licença de saúde: sim"; "afastamento:
-- informado"): o código saneia antes de gravar (sem diagnóstico, CID nem nome
-- de remédio). Escrita só pelo servidor/worker; leitura da organização.

create table if not exists public.registro_da_conversa (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  -- pergunta: algo que a IA perguntou (ou que o cliente contou sem ser perguntado);
  -- licenca: um consentimento (ex.: dados de saúde);
  -- promessa: algo que a IA prometeu ao cliente.
  tipo text not null,
  tema text not null,
  chave text not null,
  -- pergunta: sem_resposta · respondida · recusada
  -- licenca: concedida · negada
  -- promessa: pendente · cumprida (vencida é calculada na leitura: prazo passou)
  status text not null,
  -- A pergunta como foi feita (para a trava de repetição comparar).
  pergunta text,
  -- O resumo da resposta (até 80 caracteres), ou null.
  resposta text,
  prazo timestamptz,
  vezes integer not null default 1,
  agent_id uuid references public.ai_agents(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  job_id uuid,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  resolvido_em timestamptz
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'registro_da_conversa_tipo_check'
  ) then
    alter table public.registro_da_conversa
      add constraint registro_da_conversa_tipo_check
      check (tipo in ('pergunta', 'licenca', 'promessa'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'registro_da_conversa_status_check'
  ) then
    alter table public.registro_da_conversa
      add constraint registro_da_conversa_status_check
      check (
        (tipo = 'pergunta' and status in ('sem_resposta', 'respondida', 'recusada'))
        or (tipo = 'licenca' and status in ('concedida', 'negada'))
        or (tipo = 'promessa' and status in ('pendente', 'cumprida'))
      );
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'registro_da_conversa_textos_check'
  ) then
    alter table public.registro_da_conversa
      add constraint registro_da_conversa_textos_check
      check (
        char_length(tema) between 1 and 120
        and char_length(chave) between 1 and 120
        and char_length(coalesce(pergunta, '')) <= 240
        and char_length(coalesce(resposta, '')) <= 80
      );
  end if;
end $$;

create unique index if not exists registro_da_conversa_item_uidx
  on public.registro_da_conversa (organization_id, contact_id, tipo, chave);
create index if not exists registro_da_conversa_contato_idx
  on public.registro_da_conversa (organization_id, contact_id, atualizado_em desc);

alter table public.registro_da_conversa enable row level security;
drop policy if exists tenant_isolation_registro_da_conversa_select on public.registro_da_conversa;
create policy tenant_isolation_registro_da_conversa_select on public.registro_da_conversa
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.registro_da_conversa from public, anon, authenticated;
grant select on public.registro_da_conversa to authenticated;
grant all on public.registro_da_conversa to service_role;

-- LGPD: anonimizar o contato apaga o registro dele (temas e respostas citam o
-- que ele contou). Não há trilha a preservar aqui: o registro é memória de
-- trabalho da conversa, e a conversa redigida não tem mais o que lembrar.
create or replace function public.fn_apagar_registro_da_conversa_ao_anonimizar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_anonymized is true and coalesce(old.is_anonymized, false) is not true then
    delete from public.registro_da_conversa
     where organization_id = new.organization_id
       and contact_id = new.id;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_apagar_registro_da_conversa_ao_anonimizar() from public, anon;
revoke execute on function public.fn_apagar_registro_da_conversa_ao_anonimizar() from authenticated;

drop trigger if exists trg_contacts_apaga_registro_da_conversa on public.contacts;
create trigger trg_contacts_apaga_registro_da_conversa
  after update of is_anonymized on public.contacts
  for each row execute function public.fn_apagar_registro_da_conversa_ao_anonimizar();
