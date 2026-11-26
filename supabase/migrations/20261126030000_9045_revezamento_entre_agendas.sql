-- manifest: PC-054 — revezamento entre agendas da mesma conexão do Google (`calendar_event_types.rotation_calendar_ids`): sem agenda escolhida, o compromisso cai na agenda da vez que está livre (`calendar_appointments.target_calendar_id`), e a guarda de duplo clique passa a ser por agenda
--
-- O caso que pede isto: um escritório tem UMA conta Google conectada (a de quem
-- atende no CRM) e, dentro dela, a agenda de cada especialista. As especialistas
-- não têm usuário no CRM. Até aqui o CRM gravava todo compromisso na agenda de
-- DESTINO de quem atende — uma só —, e não havia como dividir as marcações
-- entre as duas agendas.
--
-- O que muda, e o que NÃO muda:
--   * `calendar_event_types.rotation_calendar_ids uuid[]` — as agendas
--     (`calendar_connection_calendars.id`) entre as quais o tipo reveza, na ordem
--     da vez. Nulo ou vazio = como antes (destino único). Mesma forma do rodízio
--     de responsáveis (migration 9039): coluna na tabela-mãe, que já tem RLS e
--     grants; quem garante que cada id é uma agenda da conta de quem atende é a
--     rota (`/api/v1/agenda/tipos`) e a LEITURA (`fn_agenda_revezamento_do_dono`),
--     que descarta o que deixou de valer — array não tem FK, e nenhum dos dois
--     lados confia no outro.
--   * `calendar_appointments.target_calendar_id` — a agenda que o revezamento
--     escolheu para ESTE compromisso. Nula = como antes (a agenda de destino de
--     quem atende). SEM FK, de propósito: com `on delete set null`, desconectar o
--     Google (que apaga as agendas da conexão) zeraria a agenda de dois
--     compromissos do mesmo instante em agendas diferentes, e a guarda por agenda
--     (abaixo) recusaria o DELETE com 23505 — ninguém conseguiria desconectar.
--     Ponteiro solto é tratado nas duas pontas: o claim recusa agenda que não é
--     mais da conta de quem atende, e a coleta não conta o id que não conhece.
--   * `fn_google_appointment` (claim): com `target_calendar_id`, o evento vai
--     para essa agenda, e só se ela ainda for de uma conexão de quem atende.
--     Cópia da última definição (migration 0654) + o bloco do revezamento no
--     claim + a conferência de sobreposição do `apply_remote` (quando alguém muda
--     o evento direto no Google) por agenda e sem os "não vai".
--   * `calendar_appointments_sem_duplicata_idx` (0182, 9040): o mesmo instante
--     na MESMA agenda continua recusado; em agendas diferentes do mesmo
--     responsável passa a ser permitido. O índice novo é mais FROUXO que o
--     antigo (acrescenta uma coluna à chave), então nenhum dado existente o
--     viola — não há o que deduplicar antes.
--   * Duas leituras novas (`security definer`, só ocupação e o nome da agenda do
--     revezamento): `fn_agenda_revezamento_do_dono` e
--     `fn_agenda_ocupacao_google_das_agendas`. Mesmo desenho da 0260: a RLS de
--     `calendar_connections` esconde a conexão de um atendente, e a grade dele
--     ficaria cega para a agenda da especialista.

-- ─── 1 · as colunas ────────────────────────────────────────────────────────
alter table public.calendar_event_types
  add column if not exists rotation_calendar_ids uuid[];

comment on column public.calendar_event_types.rotation_calendar_ids is
  'PC-054: agendas (calendar_connection_calendars.id) da conta Google de quem atende entre as quais o tipo reveza, na ordem da vez. Nulo/vazio = destino único, como antes. Validadas na rota e filtradas na leitura (fn_agenda_revezamento_do_dono).';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'calendar_event_types_rotation_calendar_ids_tamanho'
       and conrelid = 'public.calendar_event_types'::regclass
  ) then
    -- Dado fora da régua antes da constraint (clone que gravou à mão): corta
    -- para as 10 primeiras em vez de quebrar o update.sh.
    update public.calendar_event_types
       set rotation_calendar_ids = rotation_calendar_ids[1:10]
     where cardinality(rotation_calendar_ids) > 10;
    alter table public.calendar_event_types
      add constraint calendar_event_types_rotation_calendar_ids_tamanho
      check (rotation_calendar_ids is null or cardinality(rotation_calendar_ids) <= 10);
  end if;
end $$;

alter table public.calendar_appointments
  add column if not exists target_calendar_id uuid;

-- Sem FK (ver o cabeçalho). O drop é para o banco que tenha recebido um rascunho
-- desta migration com a FK; em qualquer outro é no-op.
alter table public.calendar_appointments
  drop constraint if exists calendar_appointments_target_calendar_id_fkey;

comment on column public.calendar_appointments.target_calendar_id is
  'PC-054: a agenda que o revezamento do tipo escolheu para este compromisso (calendar_connection_calendars.id). Nula = a agenda de destino de quem atende, como antes. Sem FK de propósito: desconectar o Google apaga as agendas, e um set null juntaria na mesma chave da guarda de duplo clique compromissos de agendas diferentes. Agenda que sumiu: o claim recusa e deixa o motivo.';

-- ─── 2 · a guarda de duplo clique passa a ser POR AGENDA ───────────────────
-- Só recria quando a definição ainda não conhece a agenda, para o update.sh não
-- reconstruir o índice a cada atualização. O coalesce põe todo compromisso sem
-- agenda escolhida numa "agenda" só (a de destino), que é onde ele cai.
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'calendar_appointments_sem_duplicata_idx'
       and indexdef like '%target_calendar_id%'
  ) then
    drop index if exists public.calendar_appointments_sem_duplicata_idx;
    create unique index calendar_appointments_sem_duplicata_idx
      on public.calendar_appointments (
        organization_id, owner_user_id,
        (coalesce(target_calendar_id, '00000000-0000-0000-0000-000000000000'::uuid)),
        starts_at)
      where status in ('pending', 'confirmed') and owner_user_id is not null
        and lead_presence is distinct from 'nao_vai';
  end if;
end $$;

comment on index public.calendar_appointments_sem_duplicata_idx is
  'Fecha a janela entre a validação do motor de slots e o INSERT: dois POSTs simultâneos para o mesmo instante, o mesmo atendente e a MESMA agenda (PC-054: target_calendar_id; sem ela, a de destino) não viram dois compromissos. Parcial em (pending, confirmed) porque cancelado e realizado não ocupam ninguém; em owner_user_id não nulo porque NULL não colide com NULL; e sem a presença nao_vai (PC-052) porque quem não vai libera o horário.';

-- ─── 3 · a agenda escolhida vai para o Google ──────────────────────────────
create or replace function public.fn_google_appointment(p_org uuid,p_id uuid,p_action text,p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; c public.calendar_connection_calendars; conn public.calendar_connections;
 contact uuid; claim jsonb:=p_args->'claim'; result jsonb; b jsonb; changed boolean; remote jsonb;
begin
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002';end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact);end if;
 -- Seleção/reserva compartilham membership antes dos locks de calendário/appointment.
 perform 1 from public.user_organizations m join public.calendar_appointments x on x.organization_id=m.organization_id and x.owner_user_id=m.user_id
  where x.organization_id=p_org and x.id=p_id for update of m;
 if p_args?'calendar_fence' then
  perform public.fn_google_calendar_fence(p_org,(p_args->'calendar_fence'->>'id')::uuid,p_args->'calendar_fence'->'claim',p_args->'calendar_fence'->'cursor');
 end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if a.contact_id is distinct from contact then raise exception 'appointment_stale' using errcode='PT409';end if;
 if contact is not null and exists(select 1 from public.contacts where organization_id=p_org and id=contact and is_anonymized) then
  if p_action='claim' then return jsonb_build_object('terminal','redacted');end if;
  raise exception 'google_contact_redacted' using errcode='42501';end if;
 if not exists(select 1 from public.user_organizations where organization_id=p_org and user_id=a.owner_user_id and revoked_at is null) then
  raise exception 'google_owner_unavailable' using errcode='42501';end if;
 if p_action='claim' then
  if a.google_claim_until>clock_timestamp() then return null;end if;
  if a.google_event_id is null and a.status<>'cancelled' then
   if a.target_calendar_id is not null then
    -- PC-054 (migration 9045): o compromisso nasceu numa agenda escolhida pelo
    -- revezamento do tipo. Vai para ELA, e só se ela ainda é de uma conexão de
    -- quem atende (o revezamento nunca grava na agenda de outra pessoa).
    select k.* into c from public.calendar_connection_calendars k join public.calendar_connections x on x.id=k.connection_id and x.organization_id=k.organization_id
     where k.organization_id=p_org and k.id=a.target_calendar_id and x.user_id=a.owner_user_id;
    if not found then
     update public.calendar_appointments set google_sync_error='A agenda do revezamento não está mais na conta Google de quem atende. Confira o tipo de atendimento.',google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return null;
    end if;
   else
   select k.* into c from public.calendar_connection_calendars k join public.calendar_connections x on x.id=k.connection_id and x.organization_id=k.organization_id
    where k.organization_id=p_org and x.user_id=a.owner_user_id and k.is_destination;
   if not found or (select count(*) from public.calendar_connection_calendars k join public.calendar_connections x on x.id=k.connection_id and x.organization_id=k.organization_id where k.organization_id=p_org and x.user_id=a.owner_user_id and k.is_destination)<>1 then
    update public.calendar_appointments set google_sync_error='Escolha uma agenda de destino nas configurações.',google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return null;
   end if;
   end if;
   if not c.available or c.access_role not in ('owner','writer') then
    update public.calendar_appointments set google_sync_error='A agenda de destino não permite publicação. Confira o acesso nas configurações.',google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return null;end if;
   update public.calendar_appointments set google_connection_id=c.connection_id,google_calendar_id=c.external_calendar_id,
    google_event_id='deskcommapp'||replace(id::text,'-',''),google_pending_write='{"reservation":true}'::jsonb where organization_id=p_org and id=p_id returning * into a;
  end if;
  update public.calendar_appointments set google_claim_token=gen_random_uuid(),google_claim_epoch=google_claim_epoch+1,
   google_claim_until=clock_timestamp()+interval '90 seconds' where organization_id=p_org and id=p_id returning * into a;
 else
  if a.google_claim_token is distinct from (claim->>'token')::uuid or a.google_claim_epoch::text is distinct from claim->>'epoch'
   or a.google_claim_until is null or a.google_claim_until<=clock_timestamp() then raise exception 'google_stale' using errcode='PT409';end if;
  if p_action='renew' then
   if a.revision::text is distinct from p_args->>'revision' or a.google_local_revision::text is distinct from p_args->>'local_revision' then raise exception 'google_stale' using errcode='PT409';end if;
   if not exists(select 1 from public.calendar_connections x join public.calendar_connection_calendars k on k.organization_id=x.organization_id and k.connection_id=x.id
    where x.organization_id=p_org and x.id=a.google_connection_id and x.user_id=a.owner_user_id and x.status='healthy' and k.external_calendar_id=a.google_calendar_id and k.available and k.access_role in ('writer','owner')) then raise exception 'google_connection_unavailable' using errcode='42501';end if;
   update public.calendar_appointments set google_claim_until=clock_timestamp()+interval '90 seconds' where organization_id=p_org and id=p_id returning * into a;
  elsif p_action='release' then
   update public.calendar_appointments set google_claim_token=null,google_claim_until=null where organization_id=p_org and id=p_id;return 'true';
  else
   if a.revision::text is distinct from p_args->>'revision' or a.google_local_revision::text is distinct from p_args->>'local_revision'
    or a.google_event_id is distinct from p_args->>'event_id' or a.google_connection_id::text is distinct from p_args->>'connection_id'
    or a.google_calendar_id is distinct from p_args->>'calendar_id' then raise exception 'google_stale' using errcode='PT409';end if;
   if p_action='error' then
    update public.calendar_appointments set google_sync_error=left(p_args->>'message',200),google_next_attempt_at=now()+interval '15 minutes',
     meeting_state=case when meeting_state='pending' and meeting_attempts>=19 then 'failed' else meeting_state end,
     meeting_last_error=case when meeting_state='pending' then 'unknown' else meeting_last_error end,
     meeting_attempts=meeting_attempts+case when meeting_state='pending' then 1 else 0 end,
     meeting_next_attempt_at=case when meeting_state='pending' then now()+make_interval(secs=>least(900,15*power(2,least(meeting_attempts,6)))::double precision+floor(random()*5)) else meeting_next_attempt_at end
     where organization_id=p_org and id=p_id;return 'true';end if;
   if a.google_event_id is not null then
    select * into conn from public.calendar_connections where organization_id=p_org and id=a.google_connection_id and user_id=a.owner_user_id;
    select * into c from public.calendar_connection_calendars where organization_id=p_org and connection_id=a.google_connection_id and external_calendar_id=a.google_calendar_id;
    if conn.id is null or conn.status<>'healthy' or c.id is null or not c.available then raise exception 'google_connection_unavailable' using errcode='42501';end if;
   end if;
   if p_action='meet' then
    perform public.fn_meet_observe(p_org,p_id,p_args);
    select * into a from public.calendar_appointments where organization_id=p_org and id=p_id;
   elsif p_action='prepare' then
    if c.access_role not in ('owner','writer') or (a.google_pending_write is not null and a.google_pending_write<>'{"reservation":true}'::jsonb) or a.google_conflict is not null then raise exception 'google_write_unavailable' using errcode='PT409';end if;
    if p_args->'operation'?'conference_request_id' and (a.meeting_request_id is distinct from (p_args->'operation'->>'conference_request_id')::uuid or a.meeting_state<>'pending' or a.meeting_received_at is not null or a.status='cancelled') then raise exception 'meet_stale' using errcode='PT409';end if;
    update public.calendar_appointments set meeting_requested_at=case when p_args->'operation'?'conference_request_id' then coalesce(meeting_requested_at,now()) else meeting_requested_at end,google_pending_write=p_args->'operation' where organization_id=p_org and id=p_id;return 'true';
   elsif p_action='idle' then
   -- idle = convergente sem nada a fazer e sem falha nesta rodada: erro
   -- guardado aqui e de rodada passada e nao pode sobreviver (#2467).
    update public.calendar_appointments set google_sync_error=null,google_next_attempt_at=now()+interval '15 minutes' where organization_id=p_org and id=p_id;return 'true';
   elsif p_action='commit' then
    result:=p_args->'result'; b:=result->'base';remote:=result->'remote';
    if result?'operation_id' and a.google_pending_write->>'operation_id' is distinct from result->>'operation_id' then raise exception 'google_stale' using errcode='PT409';end if;
    if result?'apply_remote' then
     if a.status not in ('pending','confirmed') then raise exception 'google_outcome_protected' using errcode='PT409';end if;
     -- PC-054 (9045): quem não vai libera o horário (como no motor e no índice), e
     -- com revezamento entre agendas só a MESMA agenda conflita. Sem revezamento
     -- (nenhum dos dois com agenda escolhida), a régua de sempre: o dono inteiro.
     if not coalesce((remote->>'cancelled')::boolean,false) and exists(select 1 from public.calendar_appointments other
      where other.organization_id=p_org and other.owner_user_id=a.owner_user_id and other.id<>a.id and other.status in ('pending','confirmed')
      and other.lead_presence is distinct from 'nao_vai'
      and other.starts_at<(remote->>'ends_at')::timestamptz and other.ends_at>(remote->>'starts_at')::timestamptz
      and not ((a.target_calendar_id is not null or other.target_calendar_id is not null) and (
       (other.google_calendar_id is not null and (other.google_connection_id is distinct from a.google_connection_id or other.google_calendar_id is distinct from a.google_calendar_id))
       or (other.google_calendar_id is null and other.target_calendar_id is not null and other.target_calendar_id is distinct from
        (select k.id from public.calendar_connection_calendars k where k.organization_id=p_org and k.connection_id=a.google_connection_id and k.external_calendar_id=a.google_calendar_id))))) then
      return jsonb_build_object('overlap',true);end if;
     changed:=row(a.starts_at,a.ends_at,a.time_zone,a.status='cancelled') is distinct from row((remote->>'starts_at')::timestamptz,(remote->>'ends_at')::timestamptz,remote->>'time_zone',(remote->>'cancelled')::boolean);
     perform public.fn_appointment_change_core(p_org,p_id,a.revision,
      jsonb_build_object('starts_at',remote->>'starts_at','ends_at',remote->>'ends_at','time_zone',remote->>'time_zone')||
      case when (remote->>'cancelled')::boolean then '{"status":"cancelled","cancellation_reason":"Cancelado no Google"}'::jsonb else '{}'::jsonb end,true,b);
     if changed then
      insert into public.crm_lead_activities(organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,reason,payload)
       select p_org,l.lead_id,a.contact_id,case when (remote->>'cancelled')::boolean then 'appointment_cancelled' else 'appointment_rescheduled' end,
        'agenda',p_id,'system',case when (remote->>'cancelled')::boolean then 'Cancelado no Google' else 'Remarcado no Google' end,jsonb_build_object('origin','google','appointment_id',p_id,'resolution_actor_id',a.google_conflict->'resolution'->>'actor_id')
       from public.crm_lead_links l where l.organization_id=p_org and l.target_id=p_id and l.target_kind='appointment' group by l.lead_id;
     end if;
    end if;
    update public.calendar_appointments set
     google_base_projection=case when result?'base' then b else google_base_projection end,
     google_etag=case when result?'etag' then result->>'etag' else google_etag end,
     google_conflict=case when result?'conflict' then nullif(result->'conflict','null'::jsonb) else google_conflict end,
     google_pending_write=case when coalesce((result->>'retry_creation')::boolean,false) and a.google_base_projection is null and a.google_pending_write->>'method'='POST'
      then '{"reservation":true}'::jsonb when coalesce((result->>'clear_pending')::boolean,false) then null else google_pending_write end,
     google_synced_local_revision=case when coalesce((result->>'ack')::boolean,false) then a.google_local_revision else google_synced_local_revision end,
     google_synced_at=case when coalesce((result->>'ack')::boolean,false) then now() else google_synced_at end,
     google_sync_error=null,google_next_attempt_at=now()+interval '5 minutes'
     where organization_id=p_org and id=p_id returning * into a;
   else raise exception 'google_action_invalid' using errcode='22023';end if;
  end if;
 end if;
 return to_jsonb(a)||jsonb_build_object('revision',a.revision::text,'google_local_revision',a.google_local_revision::text,
  'google_synced_local_revision',a.google_synced_local_revision::text,'meeting_allowed_types',(select allowed_conference_types from public.calendar_connection_calendars where organization_id=p_org and connection_id=a.google_connection_id and external_calendar_id=a.google_calendar_id),'claim',jsonb_build_object('token',a.google_claim_token,'epoch',a.google_claim_epoch::text,'lease_until',a.google_claim_until));
end;$$;

revoke all on function public.fn_google_appointment(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.fn_google_appointment(uuid,uuid,text,jsonb) to service_role;


-- ─── 4 · as leituras do revezamento ────────────────────────────────────────
-- As agendas do revezamento de um dono, e a de destino dele. Devolve o NOME só
-- das agendas que estão na lista pedida (é o nome que a IA diz ao cliente: a
-- especialista); a de destino volta sem nome, só com o ponteiro, porque é o que
-- a coleta precisa para saber onde cai o compromisso sem agenda escolhida.
-- `utilizavel` é a régua da escrita e da leitura: aceita publicação e conta para
-- conflito (sem contar, os compromissos pessoais da agenda não são lidos e o
-- horário pareceria livre).
create or replace function public.fn_agenda_revezamento_do_dono(
  p_org uuid,
  p_owner uuid,
  p_agendas uuid[]
)
returns table (
  agenda_id uuid,
  connection_id uuid,
  external_calendar_id text,
  nome text,
  na_lista boolean,
  destino boolean,
  disponivel boolean,
  aceita_escrita boolean,
  conta_conflito boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select k.id, k.connection_id, k.external_calendar_id,
         case when k.id = any(coalesce(p_agendas, array[]::uuid[])) then k.name end,
         k.id = any(coalesce(p_agendas, array[]::uuid[])),
         k.is_destination,
         k.available,
         k.access_role in ('owner', 'writer'),
         k.counts_for_conflicts
    from public.calendar_connection_calendars k
    join public.calendar_connections c
      on c.organization_id = k.organization_id
     and c.id = k.connection_id
   where (auth.uid() is null
          or p_org in (select public.fn_user_org_ids())
          or public.fn_is_platform_admin())
     and k.organization_id = p_org
     and c.user_id = p_owner
     and (k.id = any(coalesce(p_agendas, array[]::uuid[])) or k.is_destination);
$$;

-- A ocupação do Google do dono, POR AGENDA. Igual a
-- `fn_agenda_ocupacao_google_do_dono` (0260) mais a agenda de cada evento, e só
-- das agendas pedidas. Evento de agenda sem linha no catálogo volta com
-- `agenda_id` nulo: quem lê o conta em TODAS (a mesma direção segura de
-- `fn_google_counts_for_conflicts`: o erro barato é mostrar ocupado a mais).
create or replace function public.fn_agenda_ocupacao_google_das_agendas(
  p_org uuid,
  p_owner uuid,
  p_agendas uuid[],
  p_de timestamptz,
  p_ate timestamptz
)
returns table (
  agenda_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  transparency text,
  status text,
  connection_status text
)
language sql
stable
security definer
set search_path = public
as $$
  select k.id, e.starts_at, e.ends_at, e.transparency, e.status, c.status
    from public.calendar_selected_external_events e
    join public.calendar_connections c
      on c.organization_id = e.organization_id
     and c.id = e.connection_id
    left join public.calendar_connection_calendars k
      on k.organization_id = e.organization_id
     and k.connection_id = e.connection_id
     and k.external_calendar_id = e.external_calendar_id
   where (auth.uid() is null
          or p_org in (select public.fn_user_org_ids())
          or public.fn_is_platform_admin())
     and e.organization_id = p_org
     and c.user_id = p_owner
     and (k.id is null or k.id = any(coalesce(p_agendas, array[]::uuid[])))
     -- Cruzamento ESTRITO, a régua de `colide`: encostar não é ocupar.
     and e.starts_at < p_ate
     and e.ends_at > p_de;
$$;

-- Função nova em `public` nasce EXPOSTA — as DUAS origens de EXECUTE (CLAUDE.md).
revoke execute on function public.fn_agenda_revezamento_do_dono(uuid, uuid, uuid[]) from public, anon;
grant  execute on function public.fn_agenda_revezamento_do_dono(uuid, uuid, uuid[]) to authenticated, service_role;
revoke execute on function public.fn_agenda_ocupacao_google_das_agendas(uuid, uuid, uuid[], timestamptz, timestamptz) from public, anon;
grant  execute on function public.fn_agenda_ocupacao_google_das_agendas(uuid, uuid, uuid[], timestamptz, timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
