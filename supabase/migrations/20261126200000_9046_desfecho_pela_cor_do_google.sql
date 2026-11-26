-- manifest: PC-062: desfecho da ligação pela cor do Google (por tipo de atendimento, desligado): cores de Realizado e Faltou no tipo, porta única só do service_role e autoria 'google_color' no carimbo do compromisso

-- PC-062: a cor que a equipe pinta no Google depois da ligação vira o desfecho
-- (Realizado / Faltou), por tipo de atendimento e desligado de fábrica. A cor da
-- presença do lead (5, 10, 11) nunca serve: ela é pintada pelo próprio CRM.
alter table public.calendar_event_types add column if not exists outcome_color_completed text;
alter table public.calendar_event_types add column if not exists outcome_color_no_show text;
-- Antes da constraint, limpa o que um clone possa ter de fora do vocabulário.
update public.calendar_event_types set outcome_color_completed = null
 where outcome_color_completed is not null and outcome_color_completed not in ('1','2','3','4','6','7','8','9');
update public.calendar_event_types set outcome_color_no_show = null
 where outcome_color_no_show is not null
   and (outcome_color_no_show not in ('1','2','3','4','6','7','8','9') or outcome_color_no_show = outcome_color_completed);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'calendar_event_types_outcome_colors_check') then
    alter table public.calendar_event_types add constraint calendar_event_types_outcome_colors_check check (
      (outcome_color_completed is null or outcome_color_completed in ('1','2','3','4','6','7','8','9'))
      and (outcome_color_no_show is null or outcome_color_no_show in ('1','2','3','4','6','7','8','9'))
      and (outcome_color_completed is null or outcome_color_no_show is null or outcome_color_completed <> outcome_color_no_show)
    );
  end if;
end $$;
comment on column public.calendar_event_types.outcome_color_completed is
  'PC-062: colorId do Google que a equipe pinta quando a ligação aconteceu. Lido pelo sync, vira status completed. Nulo = desligado.';
comment on column public.calendar_event_types.outcome_color_no_show is
  'PC-062: colorId do Google que a equipe pinta quando a pessoa faltou. Lido pelo sync, vira status no_show. Nulo = desligado.';

create or replace function public.fn_appointment_stamp()
returns trigger language plpgsql security definer set search_path=public as $$
declare changed boolean; actor uuid;
begin
 if new.contact_id is not null and not exists(select 1 from public.contacts where id=new.contact_id and organization_id=new.organization_id) then
  raise exception 'appointment_contact_scope' using errcode='23503'; end if;
 if new.conversation_id is not null and not exists(select 1 from public.conversations where id=new.conversation_id and organization_id=new.organization_id and contact_id=new.contact_id and not is_group and (auth.uid() is null or public.fn_can_view_conversation(organization_id,assigned_to_user_id))) then
  raise exception 'appointment_conversation_scope' using errcode='23503'; end if;
 if tg_op='INSERT' then
  new.revision:=1;
  -- Legado importado sem autoria não vira fato certificado.
  new.outcome_source_kind:=null; new.outcome_user_id:=null; new.outcome_message_id:=null;
  new.outcome_recorded_at:=null;
  return new;
 end if;
 changed:=row(new.starts_at,new.ends_at,new.status,new.contact_id,new.conversation_id) is distinct from row(old.starts_at,old.ends_at,old.status,old.contact_id,old.conversation_id);
 new.revision:=old.revision+case when changed then 1 else 0 end;
 new.revision_started_at:=case when changed then clock_timestamp() else old.revision_started_at end;
 if changed then new.confirmation_next_at:=null; end if;
 if new.status is distinct from old.status and new.status in ('completed','no_show') then
  actor:=auth.uid();
  -- PC-062 (migration 9046): a equipe pintou o evento no Google com a cor de
  -- desfecho do tipo. Só a função `fn_appointment_outcome_from_google`, sem
  -- sessão de usuário (service_role), liga esta marca, na própria transação.
  if actor is null and current_setting('app.desfecho_pelo_google', true) = 'on' then
   if new.starts_at>now() then raise exception 'appointment_not_started' using errcode='22023'; end if;
   new.outcome_user_id:=null; new.outcome_message_id:=null; new.outcome_recorded_at:=clock_timestamp();
   new.outcome_source_kind:='google_color';
   return new;
  end if;
  if actor is null or not public.fn_role_at_least(new.organization_id,'agent') or not public.fn_support_write_allowed(new.organization_id) then
   raise exception 'appointment_human_confirmation_required' using errcode='42501'; end if;
  if new.starts_at>now() then raise exception 'appointment_not_started' using errcode='22023'; end if;
  new.outcome_user_id:=actor; new.outcome_recorded_at:=clock_timestamp();
  new.outcome_source_kind:=case when new.outcome_message_id is null then 'user' else 'contact_message' end;
  if new.outcome_message_id is not null and not exists(
   select 1 from public.messages m join public.conversations c on c.id=m.conversation_id and c.organization_id=m.organization_id
   where m.id=new.outcome_message_id and m.organization_id=new.organization_id and m.contact_id=new.contact_id
    and (new.conversation_id is null or m.conversation_id=new.conversation_id)
    and m.direction='inbound' and m.service_revision is not null and m.service_revision=c.service_revision
    and m.demanda_id is not distinct from c.current_demanda_id and m.created_at>=old.revision_started_at
    and not c.is_group and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id)
  ) then raise exception 'appointment_message_not_evidence' using errcode='42501'; end if;
 elsif changed then
  new.outcome_source_kind:=null; new.outcome_user_id:=null; new.outcome_message_id:=null;
  new.outcome_recorded_at:=null;
 else
  new.outcome_source_kind:=old.outcome_source_kind;
  -- SET NULL por retenção da FK é erosão de referência, não nova autoria.
  new.outcome_user_id:=case when new.outcome_user_id is null and not exists(select 1 from auth.users where id=old.outcome_user_id) then null else old.outcome_user_id end;
  new.outcome_message_id:=case when new.outcome_message_id is null and not exists(select 1 from public.messages where id=old.outcome_message_id and organization_id=old.organization_id) then null else old.outcome_message_id end;
  new.outcome_recorded_at:=old.outcome_recorded_at;
 end if;
 return new;
end; $$;

-- A ÚNICA porta: sem sessão de usuário, só para o status de desfecho, e só
-- quando o tipo do compromisso tem a cor daquele desfecho configurada. Liga a
-- marca da transação, passa pelo mesmo núcleo de alteração (revisão, avisos,
-- evento de recuperação da falta) e desliga a marca.
create or replace function public.fn_appointment_outcome_from_google(p_org uuid, p_id uuid, p_revision bigint, p_status text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.calendar_appointments; t public.calendar_event_types; r jsonb;
begin
 if auth.uid() is not null then raise exception 'google_outcome_forbidden' using errcode='42501'; end if;
 if p_status not in ('completed','no_show') then raise exception 'google_outcome_invalid' using errcode='22023'; end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id=p_id;
 if not found then raise exception 'appointment_not_found' using errcode='P0002'; end if;
 select * into t from public.calendar_event_types where organization_id=p_org and id=a.event_type_id;
 if not found
    or (p_status='completed' and t.outcome_color_completed is null)
    or (p_status='no_show' and t.outcome_color_no_show is null) then
  raise exception 'google_outcome_off' using errcode='42501';
 end if;
 perform set_config('app.desfecho_pelo_google','on',true);
 r := public.fn_appointment_change_core(p_org,p_id,p_revision,jsonb_build_object('status',p_status),false,null);
 perform set_config('app.desfecho_pelo_google','',true);
 return r;
end; $$;
revoke execute on function public.fn_appointment_outcome_from_google(uuid,uuid,bigint,text) from public, anon, authenticated;
grant execute on function public.fn_appointment_outcome_from_google(uuid,uuid,bigint,text) to service_role;
