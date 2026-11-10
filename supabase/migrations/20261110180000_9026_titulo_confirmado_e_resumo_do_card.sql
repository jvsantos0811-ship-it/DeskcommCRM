-- manifest: **O card com o nome certo (PC-026).** `crm_leads.titulo_origem` (`sistema` | `ia` | `pessoa`, nulo = desconhecida): quem deu o título atual do negócio. Gatilho `trg_crm_leads_titulo_origem` (BEFORE UPDATE OF title): mudar o título sem dizer a origem marca `pessoa` — a não ser que a transação declare `deskcomm.titulo_origem` (`ia` ou `sistema`). É o que impede a IA de sobrescrever um título que a equipe editou à mão (o nome confirmado pela IA só troca título de origem sistema, IA ou desconhecida com cara de telefone/nome do perfil). Sem dado migrado: os cards existentes ficam com origem nula até a próxima atualização de cada um. Número 9026, faixa do fork. Idempotente; apêndice igual no `baseline.sql`, antes da VARREDURA anon.
-- 9026: a origem do título do negócio (PC-026, item 1).
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
-- origem na própria transação (`set_config('deskcomm.titulo_origem', 'ia', true)`).
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
  'Quem deu o título atual: sistema | ia (nome confirmado pela IA) | pessoa (editado pela equipe). Nulo = desconhecida (card anterior à 9026). A IA só troca título de origem sistema, ia ou desconhecida com cara de telefone/nome do perfil.';

create or replace function public.fn_crm_leads_titulo_origem()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_declarada text := nullif(current_setting('deskcomm.titulo_origem', true), '');
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

revoke execute on function public.fn_crm_leads_titulo_origem() from public, anon;

drop trigger if exists trg_crm_leads_titulo_origem on public.crm_leads;
create trigger trg_crm_leads_titulo_origem
  before update of title on public.crm_leads
  for each row execute function public.fn_crm_leads_titulo_origem();
