-- manifest: **Funil: quem respondeu sobe ao topo da etapa.** Quando chega mensagem NOVA do cliente (`conversations.last_inbound_at` avança — UPDATE, ou INSERT já com o carimbo), cada negócio ABERTO daquele contato na mesma organização vai para o topo da sua etapa: `position_in_stage = min(das outras da etapa) - 1000` (se já é o menor, não mexe). Os antigos ficam naturalmente para o fim. Gatilho `trg_conversa_respondeu_sobe_no_funil` (AFTER, por linha, sem HTTP) chamando `fn_conversa_respondeu_sobe_no_funil` (security definer, sem EXECUTE para ninguém); grupo (`is_group`) não mexe; com a chave da importação de histórico (`deskcomm.importacao_historica = on`, PR #20) não mexe. A reordenação só toca `position_in_stage`: um segundo gatilho BEFORE (`trg_crm_leads_zz_reordem_mantem_updated_at`, só com a chave de transação `deskcomm.funil_reordena = on`) devolve o `updated_at` antigo, para não invalidar a trava otimista de um arrasto em voo (o "409 fantasma" da 0075); nenhuma atividade na linha do tempo, nenhum evento de automação (o `fn_emit_event_on_lead_change` só olha status e responsável). Negócio travado por outra transação é pulado (`skip locked`) e qualquer erro da reordenação vira aviso — a ingestão da mensagem nunca cai por causa dela. O arrasto manual segue igual. Número 9013, faixa do fork. Idempotente; apêndice igual no `baseline.sql`.
-- 9013: quem respondeu sobe ao topo da etapa no funil.
--
-- O pedido do dono: "no kanban, as pessoas que forem respondendo vão para o
-- topo da etapa e os antigos vão ficando para o final".
--
-- O quadro ordena por `position_in_stage` CRESCENTE (menor = topo) e o arrasto
-- grava o ponto médio entre os vizinhos (fractional indexing). Subir um card é,
-- então, gravar um número menor que o menor da etapa — o arrasto continua
-- funcionando depois, porque `midpoint(null, topo)` = topo - 1000 e o meio
-- entre dois números quaisquer existe.
--
-- QUEM DISPARA. `conversations.last_inbound_at` é o carimbo da última mensagem
-- do cliente (escrito por `fn_mark_conversation_message` com `greatest(...)`).
-- O gatilho só age quando ele AVANÇA: mensagem atrasada, que não muda o
-- carimbo, não reordena nada. Resposta da equipe ou da IA (outbound) não toca
-- `last_inbound_at` e não dispara.
--
-- O QUE NÃO PODE ACONTECER, e como cada coisa é evitada:
--   1. O 409 FANTASMA (cabeçalho da 0075). `trg_crm_leads_updated_at` carimba
--      `updated_at` em QUALQUER UPDATE, e o arrasto e a edição usam trava
--      otimista por `updated_at`. Uma reordenação de fundo invalidaria o
--      arrasto em voo do mesmo card. Por isso a reordenação liga a chave de
--      transação `deskcomm.funil_reordena`, e o gatilho
--      `trg_crm_leads_zz_reordem_mantem_updated_at` (BEFORE, o nome em `zz`
--      faz ele rodar DEPOIS do carimbo — o Postgres dispara gatilhos do mesmo
--      evento em ordem alfabética) devolve o `updated_at` antigo. A chave volta
--      ao valor anterior antes do fim da função.
--   2. ATIVIDADE OU EVENTO À TOA. Nada aqui grava em `crm_lead_activities` nem
--      em `event_log`; `fn_emit_event_on_lead_change` só emite por status e por
--      responsável, e `trg_stamp_stage_changed_at` só por troca de etapa.
--      O quadro (Realtime de `crm_leads` por `pipeline_id`, evento `*`) recebe o
--      UPDATE e se refaz — o card sobe ao vivo, e pulsa pelo motivo certo.
--   3. DERRUBAR A INGESTÃO. Reordenar é conforto visual; perder a mensagem do
--      cliente é defeito grave. O negócio travado por outra transação (um
--      arrasto acontecendo agora) é PULADO (`skip locked`) — o arrasto da pessoa
--      vence — e qualquer erro vira `raise warning` dentro de um bloco próprio.
--   4. A IMPORTAÇÃO DE HISTÓRICO (PR #20, migration 9012) grava conversas
--      antigas com `deskcomm.importacao_historica = on`. Passado não é
--      resposta nova: com a chave ligada, nada se move.
--   5. GRUPO. Conversa `is_group` tem contato `whatsapp_group`, que nunca entra
--      em funil; o gatilho nem dispara para ela.
--
-- Nenhum gatilho faz HTTP; nenhuma coluna nova.

create or replace function public.fn_conversa_respondeu_sobe_no_funil()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lead record;
  v_menor numeric;
  v_antes text;
begin
  if new.is_group or new.contact_id is null or new.last_inbound_at is null then
    return null;
  end if;
  if coalesce(current_setting('deskcomm.importacao_historica', true), '') = 'on' then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and new.last_inbound_at <= coalesce(old.last_inbound_at, '-infinity'::timestamptz) then
    return null;
  end if;

  begin
    v_antes := current_setting('deskcomm.funil_reordena', true);
    perform set_config('deskcomm.funil_reordena', 'on', true);

    -- Do mais baixo para o mais alto: ao fim, os negócios do mesmo contato na
    -- mesma etapa ficam no topo na mesma ordem relativa em que estavam.
    for v_lead in
      select l.id, l.stage_id, l.position_in_stage
        from public.crm_leads l
       where l.organization_id = new.organization_id
         and l.contact_id = new.contact_id
         and l.status = 'open'
       order by l.position_in_stage desc, l.id
         for no key update skip locked
    loop
      select min(o.position_in_stage) into v_menor
        from public.crm_leads o
       where o.organization_id = new.organization_id
         and o.stage_id = v_lead.stage_id
         and o.id <> v_lead.id;

      -- Sozinho na etapa, ou já estritamente no topo: nada a fazer.
      if v_menor is null or v_lead.position_in_stage < v_menor then
        continue;
      end if;

      update public.crm_leads
         set position_in_stage = v_menor - 1000
       where id = v_lead.id
         and organization_id = new.organization_id;
    end loop;

    perform set_config('deskcomm.funil_reordena', coalesce(v_antes, ''), true);
  exception when others then
    raise warning 'fn_conversa_respondeu_sobe_no_funil: % (conversa %)', sqlerrm, new.id;
  end;
  return null;
end;
$$;

-- Função de gatilho não é chamada por ninguém: disparar o gatilho não exige
-- EXECUTE de quem grava a conversa. As DUAS origens (default privileges do
-- baseline e o grant a PUBLIC do Postgres) saem.
revoke execute on function public.fn_conversa_respondeu_sobe_no_funil() from public, anon, authenticated;

drop trigger if exists trg_conversa_respondeu_sobe_no_funil on public.conversations;
create trigger trg_conversa_respondeu_sobe_no_funil
  after update of last_inbound_at on public.conversations
  for each row
  when (
    new.last_inbound_at is distinct from old.last_inbound_at
    and new.last_inbound_at > coalesce(old.last_inbound_at, '-infinity'::timestamptz)
    and not new.is_group
  )
  execute function public.fn_conversa_respondeu_sobe_no_funil();

drop trigger if exists trg_conversa_nova_respondeu_sobe_no_funil on public.conversations;
create trigger trg_conversa_nova_respondeu_sobe_no_funil
  after insert on public.conversations
  for each row
  when (new.last_inbound_at is not null and not new.is_group)
  execute function public.fn_conversa_respondeu_sobe_no_funil();

-- A reordenação não é edição do negócio: o `updated_at` fica como estava, e a
-- trava otimista de quem está arrastando ou editando o card segue válida.
create or replace function public.fn_crm_leads_reordem_mantem_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := old.updated_at;
  return new;
end;
$$;

revoke execute on function public.fn_crm_leads_reordem_mantem_updated_at() from public, anon, authenticated;

drop trigger if exists trg_crm_leads_zz_reordem_mantem_updated_at on public.crm_leads;
create trigger trg_crm_leads_zz_reordem_mantem_updated_at
  before update of position_in_stage on public.crm_leads
  for each row
  when (coalesce(current_setting('deskcomm.funil_reordena', true), '') = 'on')
  execute function public.fn_crm_leads_reordem_mantem_updated_at();
