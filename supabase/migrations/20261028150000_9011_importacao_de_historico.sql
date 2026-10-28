-- manifest: **Importação do histórico do WhatsApp intermediado (coexistência pela Zernio), em silêncio.** Tabela `importacoes_de_historico` (organização, sessão do canal, funil e etapa de destino, triagem ligada, estado `na_fila`/`importando`/`triando`/`concluida`/`falhou`/`cancelada`, cursor de retomada, contagens e últimas falhas; uma importação viva por sessão). Função `fn_importar_conversa_historica` (só `service_role`): grava UMA conversa antiga numa transação — conversa nova nasce `closed`, mensagens com a data original (`sent_at` e `created_at`), só as mais antigas que a primeira já existente, sem duplicar (`unique (organization_id, external_id)`), carimbos da conversa sem contador de não lidas nem espera, e um negócio aberto (`source = importado_zernio`, tag `lead-antigo`) quando o contato não tem nenhum aberto nem pediu para parar. Durante a função, a chave de transação `deskcomm.importacao_historica` cala os três gatilhos de `messages` que reagem à fala do cliente (`fn_emit_message_event`, `fn_demanda_abre_no_inbound` e `fn_reply_inbound_revision`): nenhum `message.received`, nenhuma demanda, nenhuma revisão de rascunho, nenhuma IA, automação ou follow-up. Fora da função os gatilhos seguem iguais. Número 9011, faixa do fork. Idempotente; apêndice igual no `baseline.sql`.
-- 9011: importação do histórico do canal intermediado, em silêncio.
--
-- ─── O que faltava ──────────────────────────────────────────────────────────
--
-- O número do escritório entra em coexistência pelo provedor intermediado com
-- o compartilhamento de histórico marcado: até seis meses de conversa
-- individual ficam guardados lá. Ao CRM só chega o que o webhook entrega dali
-- em diante — o passado (os contatos que pararam no meio, os que recusaram, os
-- clientes) nunca aparece, e a recuperação desses contatos é justamente o que
-- o escritório quer fazer.
--
-- ─── Por que uma função, e não inserts soltos pela API ─────────────────────
--
-- Cada INSERT em `messages` dispara, no banco, dois gatilhos que ACORDAM o
-- produto: `fn_emit_message_event` (`message.received` → IA, automações,
-- follow-up, webhooks de saída, sentimento) e `fn_demanda_abre_no_inbound`
-- (reabre a conversa, abre demanda e a põe na fila). Para mensagem antiga isso
-- seria desastre: centenas de "cliente voltou" ao mesmo tempo, a IA
-- respondendo conversa de cinco meses atrás.
--
-- A chave `deskcomm.importacao_historica` é de TRANSAÇÃO (`set_config(...,
-- true)`) e só esta função a liga: ela vale enquanto a função roda e some no
-- commit. Por isso a importação é uma função `security definer` — a chave e os
-- inserts têm de estar na mesma transação, e a API REST abre uma transação por
-- chamada. Ninguém além do `service_role` executa a função.
--
-- ─── O que fica de fora de propósito ────────────────────────────────────────
--
-- `fn_emit_conversation_routing` não precisa da chave: a conversa importada
-- nasce `closed`, e `fn_request_channel_routing` só roteia conversa aberta. A
-- conversa nasce com `service_closed_at = now()`: a primeira mensagem nova do
-- cliente, depois disso, reabre o atendimento pelo caminho de sempre.
--
-- `lead.created` não nasce no banco (a última definição de
-- `fn_emit_event_on_lead_change` sai logo no INSERT; quem emite é o código),
-- então o negócio importado não acorda regra nem fluxo "Lead criado". O gesto
-- é auditado como `lead.imported`.
--
-- Escrita local, na mesma transação; nenhum HTTP (anti-pattern 9).

create table if not exists public.importacoes_de_historico (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  pipeline_id uuid references public.crm_pipelines(id) on delete set null,
  stage_id uuid references public.crm_stages(id) on delete set null,
  triagem_ligada boolean not null default true,
  estado text not null default 'na_fila',
  -- Onde parar e de onde voltar: o cursor da listagem de conversas do provedor.
  cursor_conversas text,
  contagens jsonb not null default '{}'::jsonb,
  -- As últimas falhas (poucas, com o motivo), para a tela explicar o que houve.
  falhas jsonb not null default '[]'::jsonb,
  iniciada_por uuid references auth.users(id) on delete set null,
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now(),
  concluida_em timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'importacoes_de_historico_estado_check') then
    alter table public.importacoes_de_historico
      add constraint importacoes_de_historico_estado_check
      check (estado in ('na_fila', 'importando', 'triando', 'concluida', 'falhou', 'cancelada'));
  end if;
end $$;

-- Uma importação viva por sessão: dois cliques não importam a mesma caixa duas
-- vezes em paralelo.
create unique index if not exists importacoes_de_historico_uma_viva
  on public.importacoes_de_historico (organization_id, channel_session_id)
  where estado in ('na_fila', 'importando', 'triando');

create index if not exists idx_importacoes_de_historico_fila
  on public.importacoes_de_historico (estado, atualizada_em)
  where estado in ('na_fila', 'importando', 'triando');

alter table public.importacoes_de_historico enable row level security;

drop policy if exists tenant_isolation_importacoes_de_historico_select on public.importacoes_de_historico;
create policy tenant_isolation_importacoes_de_historico_select
  on public.importacoes_de_historico
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

revoke all on public.importacoes_de_historico from public, anon, authenticated;
grant select on public.importacoes_de_historico to authenticated;
grant all on public.importacoes_de_historico to service_role;

-- A chave está ligada? Lida pelos dois gatilhos abaixo.
create or replace function public.fn_importacao_historica_em_curso()
returns boolean language sql stable set search_path = public as $$
  select coalesce(current_setting('deskcomm.importacao_historica', true), '') = 'on';
$$;
revoke execute on function public.fn_importacao_historica_em_curso() from public, anon;
grant execute on function public.fn_importacao_historica_em_curso() to authenticated, service_role;

-- Os três gatilhos, iguais à última definição, com a chave na frente.
create or replace function public.fn_demanda_abre_no_inbound()
returns trigger language plpgsql security definer set search_path=public as $fn$
begin
  -- A REAÇÃO NÃO É MENSAGEM RECEBIDA. Sem este corte, o INSERT da linha
  -- `type='reaction'` chamava `fn_service_inbound`, que reabre a conversa
  -- encerrada e abre uma demanda nova para um gesto que não é fala.
  if new.type = 'reaction' then
    return new;
  end if;
  -- HISTÓRICO IMPORTADO (9011) não é atendimento: a mensagem de meses atrás
  -- não reabre conversa, não abre demanda e não entra na fila.
  if public.fn_importacao_historica_em_curso() then
    return new;
  end if;
  perform public.fn_service_inbound(new.id);
  return new;
end; $fn$;
revoke execute on function public.fn_demanda_abre_no_inbound() from public,anon,authenticated;

create or replace function public.fn_emit_message_event() returns trigger
language plpgsql set search_path to 'public', 'pg_temp' as $fn$
declare
  v_event text;
begin
  -- A reação não vira evento. O `type='reaction'` sai antes de escolher o
  -- evento: sem isto, a linha emitia `message.received` (ou, quando o operador
  -- reagia, `message.outbound`) e acordava push, webhook de saída, campanha e
  -- follow-up — consumidores que não filtram o tipo. Nenhum evento é a resposta
  -- certa: reação não é mensagem, e não existe evento de reação.
  if new.type = 'reaction' then
    return new;
  end if;
  -- HISTÓRICO IMPORTADO (9011): a mensagem antiga não é fato novo. Nenhum
  -- evento — senão IA, automação e follow-up acordariam para conversa de meses.
  if public.fn_importacao_historica_em_curso() then
    return new;
  end if;
  if new.direction = 'inbound' then
    if exists (select 1 from public.conversations c
               where c.id = new.conversation_id and c.organization_id = new.organization_id and c.is_group) then
      v_event := 'message.group_received';
    else
      v_event := 'message.received';
    end if;
  else
    v_event := case new.status
                 when 'sending' then 'message.sending'
                 when 'sent' then 'message.sent'
                 when 'failed' then 'message.failed'
                 else 'message.outbound'
               end;
  end if;

  perform public.fn_log_event(
    new.organization_id, v_event,
    jsonb_build_object(
      'message_id', new.id, 'conversation_id', new.conversation_id,
      'contact_id', new.contact_id, 'direction', new.direction,
      'type', new.type, 'status', new.status, 'external_id', new.external_id,
      'channel_session_id', new.channel_session_id,
      'body_preview', "left"(new.body, 280)
    )
  );
  return new;
end$fn$;
grant all on function public.fn_emit_message_event() to anon;
grant all on function public.fn_emit_message_event() to authenticated;
grant all on function public.fn_emit_message_event() to service_role;

create or replace function public.fn_reply_inbound_revision() returns trigger language plpgsql security definer set search_path=public as $fn$
begin
  -- A revisão de contexto é "o cliente falou de novo" — e a reação não é fala.
  -- Sem o corte, um 👍 somava +1 e invalidava o rascunho de resposta da tela à
  -- toa, além de contar junto com a reabertura (que este bloco também acabou de
  -- desligar).
  -- HISTÓRICO IMPORTADO (9011) também não é fala nova.
  if public.fn_importacao_historica_em_curso() then
    return new;
  end if;
  if new.direction='inbound' and new.type <> 'reaction' then
    update public.conversations set reply_context_revision=reply_context_revision+1 where organization_id=new.organization_id and id=new.conversation_id and contact_id=new.contact_id;
  end if;
  return new;
end;$fn$;
revoke all on function public.fn_reply_inbound_revision() from public,anon,authenticated;

-- Uma conversa antiga, inteira, numa transação.
--
-- `p_mensagens`: array de objetos `{external_id, direction, sent_at, type,
-- body, status, media_url, media_mime, metadata}`, em qualquer ordem.
-- `p_pipeline` nulo = só o histórico, sem negócio.
create or replace function public.fn_importar_conversa_historica(
  p_org uuid,
  p_session uuid,
  p_contact uuid,
  p_thread text,
  p_mensagens jsonb,
  p_pipeline uuid,
  p_stage uuid,
  p_titulo text,
  p_importacao uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_conv uuid;
  v_contact uuid;
  v_nova boolean := false;
  v_corte timestamptz;
  v_elegiveis integer := 0;
  v_gravadas integer := 0;
  v_max timestamptz;
  v_max_in timestamptz;
  v_max_out timestamptz;
  v_preview text;
  v_com_midia uuid[] := '{}';
  v_ultima timestamptz;
  v_lead uuid;
  v_lead_motivo text := 'sem_destino';
begin
  perform set_config('deskcomm.importacao_historica', 'on', true);

  if not exists (select 1 from public.channel_sessions where id = p_session and organization_id = p_org) then
    raise exception 'importacao_sessao_alheia' using errcode = '42501';
  end if;
  if not exists (select 1 from public.contacts where id = p_contact and organization_id = p_org) then
    raise exception 'importacao_contato_alheio' using errcode = '42501';
  end if;
  if p_pipeline is not null and not exists (
    select 1 from public.crm_stages s
     where s.id = p_stage and s.pipeline_id = p_pipeline and s.organization_id = p_org
  ) then
    raise exception 'importacao_etapa_alheia' using errcode = '42501';
  end if;

  -- A conversa: pela thread do provedor primeiro (é a mesma pessoa), depois
  -- pela conversa do contato nesta sessão, e só então uma nova — FECHADA.
  select id, contact_id into v_conv, v_contact
    from public.conversations
   where organization_id = p_org and channel_session_id = p_session and provider_conversation_id = p_thread
   limit 1;
  if v_conv is null then
    insert into public.conversations
      (organization_id, contact_id, channel_session_id, channel, status, is_group,
       unread_count_for_assignee, metadata, service_closed_at, provider_conversation_id)
    values
      (p_org, p_contact, p_session, 'whatsapp', 'closed', false,
       0, jsonb_build_object('importada_de', 'zernio', 'importacao_id', p_importacao), now(), p_thread)
    on conflict (organization_id, contact_id, channel_session_id) where is_group = false do nothing
    returning id into v_conv;
    if v_conv is not null then
      v_nova := true;
      v_contact := p_contact;
    else
      select id, contact_id into v_conv, v_contact
        from public.conversations
       where organization_id = p_org and contact_id = p_contact and channel_session_id = p_session and is_group = false
       limit 1;
      update public.conversations set provider_conversation_id = p_thread
       where id = v_conv and organization_id = p_org and provider_conversation_id is null;
    end if;
  end if;
  if v_conv is null or v_contact is null then
    raise exception 'importacao_conversa_nao_resolvida' using errcode = 'P0002';
  end if;

  -- Só o que vem ANTES da primeira mensagem que o CRM já tem nesta conversa:
  -- o que veio depois chegou pelo webhook e já está aqui.
  select min(coalesce(sent_at, created_at)) into v_corte
    from public.messages where organization_id = p_org and conversation_id = v_conv;

  -- A deduplicação é EXPLÍCITA: `messages_org_external_id_unique` é
  -- `deferrable initially deferred`, então nem `on conflict` a aceita como
  -- árbitro nem o INSERT repetido falharia antes do commit — derrubaria a
  -- conversa inteira no fim. Fica o `distinct on` (a mesma mensagem duas vezes
  -- na entrada) e o `not exists` (já está no banco, pelo webhook ou por uma
  -- importação anterior).
  with entrada as (
    select distinct on (x.external_id) x.*
      from jsonb_to_recordset(coalesce(p_mensagens, '[]'::jsonb)) as x(
        external_id text, direction text, sent_at timestamptz, type text, body text,
        status text, media_url text, media_mime text, metadata jsonb)
     where x.external_id is not null and x.sent_at is not null
       and x.direction in ('inbound', 'outbound')
       and (v_corte is null or x.sent_at < v_corte)
     order by x.external_id, x.sent_at
  ),
  gravadas as (
    insert into public.messages
      (organization_id, conversation_id, contact_id, channel_session_id, external_id, direction,
       sent_via, status, type, body, media_url, media_mime, metadata, sent_at, created_at)
    select p_org, v_conv, v_contact, p_session, e.external_id, e.direction,
           'external_device', coalesce(e.status, case when e.direction = 'inbound' then 'delivered' else 'sent' end),
           coalesce(e.type, 'text'), e.body, e.media_url, e.media_mime,
           coalesce(e.metadata, '{}'::jsonb), e.sent_at, e.sent_at
      from entrada e
     where not exists (
       select 1 from public.messages m
        where m.organization_id = p_org and m.external_id = e.external_id
     )
     order by e.sent_at
    returning id, direction, sent_at, body, media_url
  )
  select (select count(*) from entrada),
         count(*),
         max(g.sent_at),
         max(g.sent_at) filter (where g.direction = 'inbound'),
         max(g.sent_at) filter (where g.direction = 'outbound'),
         (array_agg(left(coalesce(g.body, ''), 200) order by g.sent_at desc))[1],
         coalesce(array_agg(g.id) filter (where g.media_url is not null), '{}')
    into v_elegiveis, v_gravadas, v_max, v_max_in, v_max_out, v_preview, v_com_midia
    from gravadas g;

  -- Carimbos SEM contador de não lidas e SEM espera da fila: é passado.
  if v_gravadas > 0 then
    update public.conversations set
      last_message_preview = case when last_message_at is null or v_max >= last_message_at
                                  then v_preview else last_message_preview end,
      last_message_at = greatest(last_message_at, v_max),
      last_inbound_at = greatest(last_inbound_at, v_max_in),
      last_outbound_at = greatest(last_outbound_at, v_max_out)
    where id = v_conv and organization_id = p_org;
    update public.contacts set last_activity_at = greatest(last_activity_at, v_max)
     where id = v_contact and organization_id = p_org;
  end if;

  select max(coalesce(sent_at, created_at)) into v_ultima
    from public.messages where organization_id = p_org and conversation_id = v_conv;

  if p_pipeline is not null then
    if v_ultima is null then
      v_lead_motivo := 'sem_mensagens';
    elsif exists (select 1 from public.contacts where id = v_contact and organization_id = p_org and is_blocked) then
      -- Quem pediu para parar não vira negócio de recuperação.
      v_lead_motivo := 'contato_bloqueado';
    else
      v_lead := public.fn_nascer_lead_da_conversa(
        p_org, v_contact, p_pipeline, p_stage,
        coalesce(nullif(btrim(p_titulo), ''), 'Contato antigo do WhatsApp'),
        'importado_zernio',
        jsonb_build_object('importacao_id', p_importacao, 'conversation_id', v_conv, 'ultima_mensagem_em', v_ultima),
        array['lead-antigo']::text[]
      );
      v_lead_motivo := case when v_lead is null then 'ja_tinha_negocio_aberto' else 'criado' end;
    end if;
  end if;

  return jsonb_build_object(
    'conversation_id', v_conv,
    'contact_id', v_contact,
    'conversa_nova', v_nova,
    'elegiveis', v_elegiveis,
    'gravadas', v_gravadas,
    'repetidas', greatest(v_elegiveis - v_gravadas, 0),
    'corte', v_corte,
    'ultima_mensagem_em', v_ultima,
    'lead_id', v_lead,
    'lead_motivo', v_lead_motivo,
    'com_midia', to_jsonb(v_com_midia)
  );
end;
$$;
revoke execute on function public.fn_importar_conversa_historica(uuid, uuid, uuid, text, jsonb, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_importar_conversa_historica(uuid, uuid, uuid, text, jsonb, uuid, uuid, text, uuid) to service_role;

notify pgrst, 'reload schema';
