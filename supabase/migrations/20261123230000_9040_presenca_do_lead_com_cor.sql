-- manifest: PC-052 parte 2: presença do lead no compromisso (aguardando, confirmada, não vai) ligada por tipo de atendimento, com cor no Google e "não vai" liberando o horário; opção "agenda interna" no modelo do evento

-- A presença é do LEAD ("vou", "não vou"), não do compromisso: o `status`
-- continua sendo da equipe. Nula = o tipo não usa presença (o de sempre).
alter table public.calendar_appointments add column if not exists lead_presence text;
-- O que já foi pintado no Google. Nulo = falta pintar: a alteração zera quando a
-- presença ou o horário mudam, e o cron de sync repinta (idempotente).
alter table public.calendar_appointments add column if not exists lead_presence_painted text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'calendar_appointments_lead_presence_check') then
    alter table public.calendar_appointments add constraint calendar_appointments_lead_presence_check
      check (lead_presence is null or lead_presence in ('aguardando', 'confirmada', 'nao_vai'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calendar_appointments_lead_presence_painted_check') then
    alter table public.calendar_appointments add constraint calendar_appointments_lead_presence_painted_check
      check (lead_presence_painted is null or lead_presence_painted in ('aguardando', 'confirmada', 'nao_vai'));
  end if;
end $$;
comment on column public.calendar_appointments.lead_presence is
  'PC-052: presença do lead (aguardando, confirmada, nao_vai). Nula quando o tipo não usa presença. nao_vai libera o horário: o motor não conta, o índice de instante não vê e o lembrete não sai; o evento fica no Google em vermelho e transparente.';
comment on column public.calendar_appointments.lead_presence_painted is
  'PC-052: a presença que já está pintada no Google. Diferente de lead_presence = o cron de sync repinta.';

alter table public.calendar_event_types add column if not exists lead_presence_enabled boolean not null default false;
comment on column public.calendar_event_types.lead_presence_enabled is
  'PC-052: marcações deste tipo nascem com presença "aguardando" e o evento do Google ganha cor pela presença (amarelo, verde, vermelho). Desligado = como sempre.';

-- O índice de instante único deixa de ver quem não vai: a remarcação nasce em
-- cima do horário vermelho. Só recria quando a definição ainda é a antiga, para
-- o update.sh não reconstruir o índice a cada atualização.
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'calendar_appointments_sem_duplicata_idx'
      and indexdef like '%lead_presence%'
  ) then
    drop index if exists public.calendar_appointments_sem_duplicata_idx;
    create unique index calendar_appointments_sem_duplicata_idx
      on public.calendar_appointments (organization_id, owner_user_id, starts_at)
      where status in ('pending', 'confirmed') and owner_user_id is not null
        and lead_presence is distinct from 'nao_vai';
  end if;
end $$;
comment on index public.calendar_appointments_sem_duplicata_idx is
  'Fecha a janela entre a validação do motor de slots e o INSERT: dois POSTs simultâneos para o mesmo instante e o mesmo atendente não viram dois compromissos. Parcial em (pending, confirmed) porque cancelado e realizado não ocupam ninguém; em owner_user_id não nulo porque NULL não colide com NULL; e sem a presença nao_vai (PC-052) porque quem não vai libera o horário. Quem captura o 23505 é a rota, que devolve 409 dizendo qual compromisso está ali.';

-- A alteração passa a aceitar a presença (cópia da última definição + lead_presence).
create or replace function public.fn_appointment_change_core(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb,p_remote boolean,p_base jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; contact uuid; origin jsonb; event_id uuid;
begin
 if p_remote and (auth.uid() is not null or (p_patch-'starts_at'-'ends_at'-'time_zone'-'status'-'cancellation_reason')<>'{}'::jsonb or coalesce(p_patch->>'status','cancelled')<>'cancelled') then raise exception 'google_patch_forbidden' using errcode='42501';end if;
 if auth.uid() is not null and (not public.fn_role_at_least(p_org,'agent') or not public.fn_support_write_allowed(p_org)) then raise exception 'appointment_forbidden' using errcode='42501'; end if;
 if auth.uid() is not null and not public.fn_session_mfa_proven() then raise exception 'appointment_mfa_required' using errcode='42501';end if;
 select contact_id into contact from public.calendar_appointments where organization_id=p_org and id=p_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002'; end if;
 if contact is not null then perform public.fn_service_lock(p_org,contact); end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id for update;
 if a.contact_id is distinct from contact or a.revision is distinct from p_revision then raise exception 'appointment_stale' using errcode='PT409'; end if;
 -- A AGENDA DO COLEGA É UMA OPÇÃO DA ORGANIZAÇÃO (migration 0343, issue #978).
 if auth.uid() is not null and not public.fn_role_at_least(p_org,'manager')
    and not public.fn_colegas_podem_mexer_na_agenda(p_org)
    and a.owner_user_id is distinct from auth.uid() then
  raise exception 'appointment_do_colega' using errcode='42501';
 end if;
 if p_remote and a.status not in ('pending','confirmed') then raise exception 'google_outcome_protected' using errcode='PT409';end if;
 if a.status='cancelled' then raise exception 'appointment_cancelled' using errcode='22023'; end if;
 if contact is not null then origin:=jsonb_build_object('kind','command','observed',public.fn_service_observe_command(p_org,contact)); end if;
 update public.calendar_appointments set
  google_base_projection=case when p_remote then p_base else google_base_projection end,
  starts_at=case when p_patch?'starts_at' then (p_patch->>'starts_at')::timestamptz else starts_at end,
  ends_at=case when p_patch?'ends_at' then (p_patch->>'ends_at')::timestamptz else ends_at end,
  time_zone=coalesce(p_patch->>'time_zone',time_zone),
  status=coalesce(p_patch->>'status',status),
  cancelled_at=case when p_patch->>'status'='cancelled' then now() else cancelled_at end,
  cancellation_reason=case when p_patch?'cancellation_reason' then p_patch->>'cancellation_reason' else cancellation_reason end,
  notes=case when p_patch?'notes' then p_patch->>'notes' else notes end,
  guest_email=case when p_patch?'guest_email' then p_patch->>'guest_email' else guest_email end,
  outcome_message_id=case when p_patch?'outcome_message_id' then (p_patch->>'outcome_message_id')::uuid else null end,
  confirmation_next_at=case when p_patch?'confirmation_next_at' then (p_patch->>'confirmation_next_at')::timestamptz else confirmation_next_at end,
  -- PC-052 (migration 9040): presença do lead. Mudar o horário volta a presença
  -- para 'aguardando' (o lead ainda não confirmou o horário novo).
  lead_presence=case when p_patch?'lead_presence' then p_patch->>'lead_presence'
   when lead_presence is not null and p_patch?'starts_at' and (p_patch->>'starts_at')::timestamptz is distinct from starts_at then 'aguardando'
   else lead_presence end,
  -- Presença ou horário mudaram: o Google precisa ser repintado (o cron de sync
  -- procura lead_presence_painted nulo).
  lead_presence_painted=case when p_patch?'lead_presence' or p_patch?'starts_at' then null else lead_presence_painted end
 where organization_id=p_org and id=p_id returning * into a;
 if p_patch?'confirmation_next_at' and (a.confirmation_next_at<=now() or a.confirmation_next_at>now()+interval '24 hours') then raise exception 'appointment_invalid_snooze' using errcode='22023'; end if;
 update public.followup_enrollments set status='cancelled',cancel_reason='O compromisso mudou. Revise o próximo passo.',completed_at=now(),next_eval_at=null,claimed_until=null
  where organization_id=p_org and appointment_id=p_id and appointment_revision<>a.revision and status in ('active','waiting_reply','paused_handoff','paused_manual');
 update public.agent_inbox_items set status='resolved',resolved_at=now()
  where organization_id=p_org and ref_kind='appointment' and ref_id=p_id and status='open'
   and (appointment_revision<>a.revision or a.status in ('completed','no_show','cancelled') or p_patch?'confirmation_next_at');
 if contact is not null and a.status='no_show' and a.outcome_recorded_at is not null and a.revision<>p_revision then
  insert into public.event_log(organization_id,event_type,entity_kind,entity_id,payload)
   values(p_org,'appointment.outcome_confirmed','appointment',p_id,
    jsonb_build_object('appointment_revision',a.revision,'service_origin',origin)) returning id into event_id;
 end if;
 return to_jsonb(a);
end; $$;
revoke all on function public.fn_appointment_change_core(uuid,uuid,bigint,jsonb,boolean,jsonb) from public,anon,authenticated;

-- O modelo do evento passa a guardar a opção "agenda interna" (cópia da última
-- definição + agenda_interna).
create or replace function public.fn_definir_modelo_do_evento_agenda(p_org uuid,p_modelo jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_atual jsonb; v_novo jsonb; v_linhas int; v_titulo text; v_desc text; v_interna jsonb;
begin
 if auth.uid() is null
    or not public.fn_role_at_least(p_org,'manager')
    or not public.fn_support_write_allowed(p_org) then
  raise exception 'modelo_do_evento_forbidden' using errcode='42501';
 end if;
 if not public.fn_session_mfa_proven() then raise exception 'mfa_required' using errcode='42501'; end if;

 if p_modelo is null or p_modelo = 'null'::jsonb then
  v_novo := null;
 else
  if jsonb_typeof(p_modelo) <> 'object' then raise exception 'modelo_do_evento_invalido' using errcode='22023'; end if;
  v_titulo := btrim(coalesce(p_modelo->>'titulo',''));
  v_desc := p_modelo->>'descricao';
  if length(v_titulo) < 1 or length(v_titulo) > 200
     or v_desc is null or v_desc not in ('nenhuma','basica','completa') then
   raise exception 'modelo_do_evento_invalido' using errcode='22023';
  end if;
  -- PC-052 (migration 9040): "agenda interna" — o contato nunca é convidado e a
  -- descrição vai em todos os eventos. Só se grava quando ligada (ausente = desligada).
  v_interna := p_modelo->'agenda_interna';
  if v_interna is not null and jsonb_typeof(v_interna) not in ('boolean','null') then
   raise exception 'modelo_do_evento_invalido' using errcode='22023';
  end if;
  v_novo := jsonb_build_object('titulo',v_titulo,'descricao',v_desc)
   || case when v_interna = 'true'::jsonb then jsonb_build_object('agenda_interna',true) else '{}'::jsonb end;
 end if;

 select settings->'modelo_do_evento_agenda' into v_atual from public.organizations where id = p_org;
 if v_atual is not distinct from v_novo then
  return jsonb_build_object('modelo',v_novo,'mudou',false);
 end if;

 if v_novo is null then
  update public.organizations set settings = coalesce(settings,'{}'::jsonb) - 'modelo_do_evento_agenda' where id = p_org;
 else
  update public.organizations
     set settings = coalesce(settings,'{}'::jsonb) || jsonb_build_object('modelo_do_evento_agenda',v_novo)
   where id = p_org;
 end if;
 get diagnostics v_linhas = row_count;
 if v_linhas = 0 then raise exception 'modelo_do_evento_sem_organizacao' using errcode='P0002'; end if;
 return jsonb_build_object('modelo',v_novo,'mudou',true);
end; $$;

revoke all on function public.fn_definir_modelo_do_evento_agenda(uuid,jsonb) from public,anon;
grant execute on function public.fn_definir_modelo_do_evento_agenda(uuid,jsonb) to authenticated,service_role;

-- O vermelho tem estado final: quem disse que não vai NÃO entra na varredura de
-- confirmação (o aviso "Confirme a presença no compromisso" seria um pedido sem
-- saída certa — cancelar apagaria o registro vermelho do Google, "faltou" ligaria
-- o follow-up de falta para quem avisou). Cópia da ÚLTIMA definição, com o filtro
-- `lead_presence is distinct from 'nao_vai'` nos dois selects.
create or replace function public.fn_appointment_confirmation_sweep(p_limit int default 100,p_now timestamptz default now())
returns int language plpgsql security definer set search_path=public as $$
declare a record; candidate record; n int:=0; expired boolean;
begin
 -- Escolhe o mesmo lote vencido e obtém mutexes em ordem, sem row lock prévio.
 for candidate in select * from (
  select c.id,c.organization_id,c.contact_id,c.ends_at
  from public.calendar_appointments c join public.organizations o on o.id=c.organization_id
  where c.status in ('pending','confirmed')
   and c.ends_at+make_interval(mins=>public.fn_agenda_minutes(o.settings,'confirmation_delay_minutes',10))<=p_now
   and (c.confirmation_next_at is null or c.confirmation_next_at<=p_now)
   and c.lead_presence is distinct from 'nao_vai'
   and not exists(select 1 from public.contacts ct where ct.organization_id=c.organization_id and ct.id=c.contact_id and ct.is_anonymized)
  order by c.ends_at,c.id limit greatest(1,least(p_limit,500))
 ) due order by organization_id,contact_id,id
 loop
  if candidate.contact_id is not null and not pg_try_advisory_xact_lock(hashtextextended(candidate.organization_id::text||':'||candidate.contact_id::text,222)) then continue;end if;
  select c.*,o.settings into a from public.calendar_appointments c join public.organizations o on o.id=c.organization_id
   where c.id=candidate.id and c.organization_id=candidate.organization_id and c.contact_id is not distinct from candidate.contact_id
    and c.status in ('pending','confirmed')
    and c.ends_at+make_interval(mins=>public.fn_agenda_minutes(o.settings,'confirmation_delay_minutes',10))<=p_now
    and (c.confirmation_next_at is null or c.confirmation_next_at<=p_now)
    and c.lead_presence is distinct from 'nao_vai'
    and not exists(select 1 from public.contacts ct where ct.organization_id=c.organization_id and ct.id=c.contact_id and ct.is_anonymized)
   for update of c skip locked;
  if not found then continue;end if;
  expired:=a.ends_at+make_interval(mins=>public.fn_agenda_minutes(a.settings,'unknown_protection_minutes',1440))<=p_now;
  insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id,appointment_revision)
   values(a.organization_id,'appointment_outcome_required',case when expired then 'critical' else 'warn' end,
    case when expired then 'Presença sem confirmação há mais tempo' else 'Confirme a presença no compromisso' end,
    'Compromisso: '||a.title||'. Abra e registre se a pessoa compareceu, faltou ou cancelou. O horário sozinho não confirma falta.',
    'appointment',a.id,a.revision)
   on conflict(organization_id,ref_id,appointment_revision,kind) where ref_kind='appointment' and appointment_revision is not null
   do update set status='open',resolved_at=null,severity=excluded.severity,title=excluded.title;
  update public.calendar_appointments set confirmation_next_at=case when expired then p_now+interval '24 hours' else least(p_now+interval '24 hours',a.ends_at+make_interval(mins=>public.fn_agenda_minutes(a.settings,'unknown_protection_minutes',1440))) end where id=a.id and organization_id=a.organization_id;
  n:=n+1;
 end loop;
 return n;
end; $$;

revoke all on function public.fn_appointment_confirmation_sweep(int,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_appointment_confirmation_sweep(int,timestamptz) to service_role;


