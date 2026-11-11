-- manifest: **O card com o nome certo (PC-026).** `crm_leads.titulo_origem` (`sistema` | `ia` | `pessoa`, nulo = desconhecida): quem deu o título atual do negócio. Gatilho `trg_crm_leads_titulo_origem` (BEFORE UPDATE OF title): mudar o título sem dizer a origem marca `pessoa` — a não ser que a transação declare `crm.titulo_origem` (`ia` ou `sistema`). É o que impede a IA de sobrescrever um título que a equipe editou à mão (o nome confirmado pela IA só troca título de origem sistema, IA ou desconhecida com cara de telefone/nome do perfil). `ai_agent_versions.perguntas_do_resumo` (até 15 rótulos; vazia = sem resumo nem chamada de IA) para o bloco "Resumo da IA" na descrição do card. Sem dado migrado: os cards existentes ficam com origem nula até a próxima atualização de cada um. Número 9028, faixa do fork. Idempotente; apêndice igual no `baseline.sql`, antes da VARREDURA anon.
-- 9028: a origem do título do negócio (PC-026, item 1).
--
-- ─── O que acontecia ────────────────────────────────────────────────────────
--
-- O card nasce com o telefone ou com o nome do perfil do WhatsApp no título. A
-- IA passa a confirmar o nome de quem conversa (`confirmar_nome` e a linha
-- "Nome confirmado" do cartão de passagem) e troca o título por ele. Sem saber
-- QUEM deu o título atual, a IA apagaria o que a equipe escreveu à mão.
--
-- ─── Por que um gatilho, e não cada caminho de edição ───────────────────────
--
-- O título muda pela tela (vários componentes), pela API, pelo MCP, pela
-- importação e pela anonimização. Um caminho novo de edição já nasce marcando
-- `pessoa` sem ninguém lembrar. O único caminho que NÃO é pessoa declara a
-- origem na própria transação (`set_config('crm.titulo_origem', 'ia', true)`).
-- Escrita local, na mesma linha — nenhum HTTP (anti-pattern 9).
--
-- ─── O que não muda ─────────────────────────────────────────────────────────
--
-- `updated_at`, a posição do card, os eventos: o gatilho só preenche a coluna
-- nova na linha que já estava sendo atualizada.

alter table public.crm_leads
  add column if not exists titulo_origem text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'crm_leads_titulo_origem_check'
       and conrelid = 'public.crm_leads'::regclass
  ) then
    alter table public.crm_leads
      add constraint crm_leads_titulo_origem_check
      check (titulo_origem is null or titulo_origem in ('sistema', 'ia', 'pessoa'));
  end if;
end $$;

comment on column public.crm_leads.titulo_origem is
  'Quem deu o título atual: sistema | ia (nome confirmado pela IA) | pessoa (editado pela equipe). Nulo = desconhecida (card anterior à 9028). A IA só troca título de origem sistema, ia ou desconhecida com cara de telefone/nome do perfil.';

create or replace function public.fn_crm_leads_titulo_origem()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_declarada text := nullif(current_setting('crm.titulo_origem', true), '');
begin
  if new.title is not distinct from old.title then
    return new;
  end if;
  -- Quem muda o título sem declarar a origem é uma pessoa (tela, API, MCP,
  -- importação). O caminho da IA declara `ia` na transação.
  if v_declarada in ('ia', 'sistema') then
    new.titulo_origem := v_declarada;
  elsif new.titulo_origem is not distinct from old.titulo_origem then
    new.titulo_origem := 'pessoa';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_crm_leads_titulo_origem() from public, anon, authenticated;

drop trigger if exists trg_crm_leads_titulo_origem on public.crm_leads;
create trigger trg_crm_leads_titulo_origem
  before update of title on public.crm_leads
  for each row execute function public.fn_crm_leads_titulo_origem();

-- ─── As perguntas do resumo do card (PC-026, item 2) ─────────────────────────
-- A lista de rótulos que o resumo do card responde ("Já teve o bebê", "Data do
-- parto"…), por versão do agente — como as outras escolhas do agente, ela vale
-- quando a versão é publicada. Vazia (o padrão) = nenhum resumo e nenhuma
-- chamada de IA: nada de adivinhar o que a equipe quer ver.
alter table public.ai_agent_versions
  add column if not exists perguntas_do_resumo text[] not null default '{}';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'ai_agent_versions_perguntas_do_resumo_check'
       and conrelid = 'public.ai_agent_versions'::regclass
  ) then
    -- Até 15 perguntas. A lista só nasce vazia (default), então nenhuma linha
    -- existente viola a regra — nada a corrigir antes.
    alter table public.ai_agent_versions
      add constraint ai_agent_versions_perguntas_do_resumo_check
      check (cardinality(perguntas_do_resumo) <= 15);
  end if;
end $$;

comment on column public.ai_agent_versions.perguntas_do_resumo is
  'PC-026: os rótulos das perguntas que o resumo do card responde (até 15). Vazia = sem resumo e sem chamada de IA.';

-- A lista é CONTEÚDO da versão: versão publicada não muda — a mudança é uma
-- versão draft nova. A trava de imutabilidade é a ÚLTIMA definição do
-- baseline, acrescida de `perguntas_do_resumo` (cerca
-- trigger-imutavel-cobre-todas-as-colunas-de-conteudo).
create or replace function fn_ai_agent_version_content_immutable() returns trigger
-- search_path fixo na PRÓPRIA definição: um create or replace sem a cláusula
-- apaga o alter function ... set search_path da 0521 (invariante
-- tests/invariants/avisos-do-security-advisor.test.ts).
language plpgsql set search_path = '' as $fn$
begin
  if old.status <> 'draft' and (
       new.system_prompt          is distinct from old.system_prompt
    or new.provider               is distinct from old.provider
    or new.model                  is distinct from old.model
    or new.credential_id          is distinct from old.credential_id
    or new.tool_ids               is distinct from old.tool_ids
    or new.trigger_config         is distinct from old.trigger_config
    or new.channel_session_id     is distinct from old.channel_session_id
    or new.max_steps              is distinct from old.max_steps
    or new.token_budget           is distinct from old.token_budget
    or new.cost_budget_cents      is distinct from old.cost_budget_cents
    or new.history_message_window is distinct from old.history_message_window
    or new.history_token_window   is distinct from old.history_token_window
    or new.handoff_keywords       is distinct from old.handoff_keywords
    or new.handoff_tool_enabled   is distinct from old.handoff_tool_enabled
    or new.handoff_legal_enabled  is distinct from old.handoff_legal_enabled
    or new.followup               is distinct from old.followup
    or new.multimodal_input       is distinct from old.multimodal_input
    or new.video_frames_enabled   is distinct from old.video_frames_enabled
    or new.split_messages         is distinct from old.split_messages
    or new.split_max_chars        is distinct from old.split_max_chars
    or new.cases_enabled          is distinct from old.cases_enabled
    or new.estado_do_funil_ligado is distinct from old.estado_do_funil_ligado
    or new.modo_conservador       is distinct from old.modo_conservador
    or new.perguntas_do_resumo    is distinct from old.perguntas_do_resumo
    or new.operator_enabled       is distinct from old.operator_enabled
    or new.operator_model         is distinct from old.operator_model
    or new.operator_tool_ids      is distinct from old.operator_tool_ids
    or new.pipeline_ids           is distinct from old.pipeline_ids
    or new.knowledge_source_ids   is distinct from old.knowledge_source_ids
    or new.proposal_ai_draft_enabled is distinct from old.proposal_ai_draft_enabled
    or new.inbound_debounce_ms    is distinct from old.inbound_debounce_ms
    or new.version_number         is distinct from old.version_number
    or new.agent_id               is distinct from old.agent_id
    or new.organization_id        is distinct from old.organization_id
  ) then
    raise exception 'ai_agent_versions % é imutável (status=%): mudança de conteúdo = versão draft nova; rollback = revert (clona + publica)',
      old.id, old.status;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_ai_agent_versions_content_immutable on public.ai_agent_versions;
create trigger trg_ai_agent_versions_content_immutable
  before update on public.ai_agent_versions
  for each row execute function fn_ai_agent_version_content_immutable();
