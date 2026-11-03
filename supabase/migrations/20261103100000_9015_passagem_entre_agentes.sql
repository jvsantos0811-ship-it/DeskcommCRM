-- manifest: **Passagem da conversa entre agentes do roteador (PC-014, Pacote Conversa).** Tabela `passagens_entre_agentes`: uma linha cada vez que a conversa troca de agente — pela ferramenta `passar_para_agente` (o agente passa a outro do mesmo roteador, com cartão padronizado), pela regra do roteador (o classificador trocou de intenção) ou pela equipe (a pessoa clicou "Devolver para a IA" escolhendo o agente e escrevendo o que fez). Guarda de quem para quem, intenção, origem, desfecho (`passou` ou `laco`, a 3ª passagem pela ferramenta em 1 h, que vira caso para a equipe), motivo e cartão (até 600 caracteres, sem telefone nem diagnóstico), o turno que passou, o turno do destino e quando o destino respondeu. Lida pelo painel de passagens da Central e pelo bloco de chegada do agente de destino. `ai_router_decisions` ganha o desfecho `passagem_agente` e as colunas `de_agente_id` e `passagem_id` (o texto do motivo fica na tabela nova: a telemetria do roteador continua sem texto). Na anonimização do contato, motivo e cartão são apagados por gatilho. Leitura por organização (RLS); escrita só pelo servidor/worker. Número 9015, faixa do fork. Idempotente; apêndice igual no `baseline.sql`.
-- 9015: passagem da conversa entre agentes do roteador (PC-014).
--
-- Até aqui, um agente não conseguia passar a conversa para outro: a troca só
-- acontecia quando o classificador mudava de intenção numa mensagem NOVA do
-- cliente. A ferramenta `passar_para_agente` grava a troca aqui, e o painel de
-- passagens da Central lê esta tabela (passagens por dia, de quem para quem,
-- sem resposta do destino em 2 min, laços, regra do roteador × ferramenta).
--
-- Nenhum HTTP; escrita pelo servidor/worker, fora de qualquer gatilho de envio.

create table if not exists public.passagens_entre_agentes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  router_id uuid references public.ai_routers(id) on delete set null,
  -- null quando quem passou foi a equipe (origem = 'equipe').
  de_agente_id uuid references public.ai_agents(id) on delete set null,
  para_agente_id uuid references public.ai_agents(id) on delete set null,
  intencao text,
  -- ferramenta: o agente chamou passar_para_agente;
  -- roteador: o classificador trocou de intenção (regra do roteador);
  -- equipe: uma pessoa devolveu a conversa para a IA escolhendo o agente.
  origem text not null,
  -- passou: a conversa trocou de agente;
  -- laco: 3ª passagem pela ferramenta na mesma hora — não passou, abriu caso.
  desfecho text not null default 'passou',
  motivo text,
  -- O cartão de passagem (formato fixo, até 600 caracteres; sem telefone, sem
  -- diagnóstico, sem nome de etiqueta) ou, na devolução da equipe, a linha que
  -- a pessoa escreveu.
  cartao text,
  por_user_id uuid references auth.users(id) on delete set null,
  job_id uuid,
  turno_destino_job_id uuid,
  destino_respondeu_em timestamptz,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'passagens_entre_agentes_origem_check'
  ) then
    alter table public.passagens_entre_agentes
      add constraint passagens_entre_agentes_origem_check
      check (origem in ('ferramenta', 'roteador', 'equipe'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'passagens_entre_agentes_desfecho_check'
  ) then
    alter table public.passagens_entre_agentes
      add constraint passagens_entre_agentes_desfecho_check
      check (desfecho in ('passou', 'laco'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'passagens_entre_agentes_textos_check'
  ) then
    alter table public.passagens_entre_agentes
      add constraint passagens_entre_agentes_textos_check
      check (char_length(coalesce(motivo, '')) <= 200 and char_length(coalesce(cartao, '')) <= 700);
  end if;
end $$;

create index if not exists passagens_entre_agentes_org_dia_idx
  on public.passagens_entre_agentes (organization_id, created_at desc);
create index if not exists passagens_entre_agentes_conversa_idx
  on public.passagens_entre_agentes (organization_id, conversation_id, created_at desc);

alter table public.passagens_entre_agentes enable row level security;
drop policy if exists tenant_isolation_passagens_entre_agentes_select on public.passagens_entre_agentes;
create policy tenant_isolation_passagens_entre_agentes_select on public.passagens_entre_agentes
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.passagens_entre_agentes from public, anon, authenticated;
grant select on public.passagens_entre_agentes to authenticated;
grant all on public.passagens_entre_agentes to service_role;

-- A telemetria do roteador ganha o desfecho da passagem. O texto (motivo e
-- cartão) mora em `passagens_entre_agentes`; aqui só ids, como sempre.
alter table public.ai_router_decisions add column if not exists de_agente_id uuid;
alter table public.ai_router_decisions add column if not exists passagem_id uuid;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_router_decisions_de_agente_id_fkey'
  ) then
    alter table public.ai_router_decisions
      add constraint ai_router_decisions_de_agente_id_fkey
      foreign key (de_agente_id) references public.ai_agents(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'ai_router_decisions_passagem_id_fkey'
  ) then
    alter table public.ai_router_decisions
      add constraint ai_router_decisions_passagem_id_fkey
      foreign key (passagem_id) references public.passagens_entre_agentes(id) on delete set null;
  end if;
end $$;
alter table public.ai_router_decisions drop constraint if exists ai_router_decisions_outcome_check;
alter table public.ai_router_decisions add constraint ai_router_decisions_outcome_check
  check (outcome in ('classified', 'sticky', 'reclassified', 'fallback', 'no_match', 'classifier_failed', 'passagem_agente'));

-- LGPD: anonimizar o contato apaga motivo e cartão das passagens dele (texto
-- que cita a pessoa). A linha fica: é a trilha de quem passou para quem.
create or replace function public.fn_redigir_passagens_ao_anonimizar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_anonymized is true and coalesce(old.is_anonymized, false) is not true then
    update public.passagens_entre_agentes
       set motivo = null, cartao = null
     where organization_id = new.organization_id
       and contact_id = new.id;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_redigir_passagens_ao_anonimizar() from public, anon;
revoke execute on function public.fn_redigir_passagens_ao_anonimizar() from authenticated;

drop trigger if exists trg_contacts_redige_passagens on public.contacts;
create trigger trg_contacts_redige_passagens
  after update of is_anonymized on public.contacts
  for each row execute function public.fn_redigir_passagens_ao_anonimizar();
