-- manifest: **Equipe respondeu = humano assumiu (PC-029).** `channel_sessions.responsavel_user_id`: a pessoa que fica com a conversa quando alguém responde pelo celular do número (coexistência) sem pessoa identificada; nula = a conversa fica sem dono, marcada "Equipe (celular)". `fn_cancelar_agendadas_da_conversa(org, conversa)`: cancela as mensagens agendadas ainda em `scheduled` da conversa e deixa a nota do "Sistema" no fio (a mesma frase da passagem para humano, migration 9007), chamada quando a equipe assume respondendo; devolve quantas cancelou; só `service_role`. Número 9026, faixa do fork. Idempotente; apêndice igual no `baseline.sql`, antes da VARREDURA anon.
-- 9026: a equipe que responde assume a conversa (PC-029).
--
-- ─── responsavel_user_id ────────────────────────────────────────────────────
--
-- O eco da mensagem enviada pelo app do WhatsApp Business no celular não diz
-- QUEM da equipe respondeu. O escritório escolhe, por número, a pessoa que
-- fica com essas conversas (Conexões). `on delete set null`: a pessoa saiu da
-- equipe, a conversa passa a ficar sem dono — nunca some.
--
-- ─── fn_cancelar_agendadas_da_conversa ──────────────────────────────────────
--
-- A passagem IA → pessoa já cancela as agendadas por gatilho (9007). A equipe
-- que assume respondendo não grava passagem (não é a IA passando), então o
-- cancelamento é chamado direto pelo servidor, com a MESMA nota. `sending` não
-- é tocada (já está saindo). Falha não sobe: devolve 0 e deixa WARNING.

alter table public.channel_sessions
  add column if not exists responsavel_user_id uuid references auth.users(id) on delete set null;

comment on column public.channel_sessions.responsavel_user_id is
  'PC-029: quem fica com a conversa quando alguém da equipe responde pelo celular deste número (coexistência) sem pessoa identificada. Nula = a conversa fica sem dono, marcada "Equipe (celular)".';

create or replace function public.fn_cancelar_agendadas_da_conversa(
  p_organization_id uuid,
  p_conversation_id uuid
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fuso text;
  v_espanhol boolean;
  v_trecho text;
  v_quando text;
  v_total integer := 0;
  r record;
begin
  begin
    select o.timezone, coalesce(o.locale, 'pt-BR') like 'es%'
      into v_fuso, v_espanhol
      from public.organizations o
     where o.id = p_organization_id;

    if v_fuso is null or not exists (select 1 from pg_timezone_names where name = v_fuso) then
      v_fuso := 'America/Sao_Paulo';
    end if;

    for r in
      update public.scheduled_messages s
         set status = 'cancelled',
             cancelled_at = now(),
             cancelled_by_user_id = null,
             updated_at = now()
       where s.organization_id = p_organization_id
         and s.conversation_id = p_conversation_id
         and s.status = 'scheduled'
      returning s.body, s.send_at
    loop
      v_total := v_total + 1;
      v_trecho := regexp_replace(btrim(r.body), '\s+', ' ', 'g');
      if char_length(v_trecho) > 120 then
        v_trecho := left(v_trecho, 117) || '…';
      end if;

      if v_espanhol then
        v_quando := to_char(r.send_at at time zone v_fuso, 'DD/MM "a las" HH24:MI');
        insert into public.conversation_notes
          (organization_id, conversation_id, body, created_by_user_id, created_by_name)
        values (
          p_organization_id, p_conversation_id,
          'Mensaje programado cancelado: la conversación pasó a atención humana. Saldría el '
            || v_quando || '. Si todavía tiene sentido, prográmelo de nuevo.'
            || E'\n\n' || 'Texto: "' || v_trecho || '"',
          null, 'Sistema');
      else
        v_quando := to_char(r.send_at at time zone v_fuso, 'DD/MM "às" HH24:MI');
        insert into public.conversation_notes
          (organization_id, conversation_id, body, created_by_user_id, created_by_name)
        values (
          p_organization_id, p_conversation_id,
          'Mensagem agendada cancelada: a conversa passou para atendimento humano. Ela sairia em '
            || v_quando || '. Se ainda fizer sentido, agende de novo.'
            || E'\n\n' || 'Texto: "' || v_trecho || '"',
          null, 'Sistema');
      end if;
    end loop;
  exception when others then
    raise warning 'fn_cancelar_agendadas_da_conversa: % (conversa %)', sqlerrm, p_conversation_id;
    return 0;
  end;
  return v_total;
end;
$$;

revoke execute on function public.fn_cancelar_agendadas_da_conversa(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_cancelar_agendadas_da_conversa(uuid, uuid) to service_role;

comment on function public.fn_cancelar_agendadas_da_conversa(uuid, uuid) is
  'PC-029: a equipe assumiu respondendo — cancela as agendadas em scheduled da conversa, com a nota do Sistema (a mesma da passagem, 9007). Devolve quantas cancelou; falha vira WARNING e 0. Só service_role. Migration 9026 (fork).';
