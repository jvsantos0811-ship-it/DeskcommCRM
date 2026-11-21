-- manifest: PC-044 (fork) — Porta de escrita do MODELO DO EVENTO NA AGENDA (`settings.modelo_do_evento_agenda`: título com campos e nível da descrição), irmã da 0648: manager, suporte de escrita e MFA por auth.uid(), chave de topo, null apaga (volta ao comportamento de sempre), devolve {modelo,mudou}.
-- ---- Modelo do evento na agenda (migration 9035) ----
--
-- PC-044. Cada empresa escolhe como o compromisso aparece no calendário da
-- equipe: o título (com campos como {primeiro_nome} e {final_telefone}) e o que
-- vai na descrição (nenhuma / basica / completa). AUSENTE = o comportamento de
-- sempre. A leitura é `lerModeloDoEvento` (lib/agenda/modelo-do-evento.ts).
--
-- Chave PRÓPRIA de topo, e não dentro de `settings.agenda`, pelo motivo da 0343
-- e da 0648: `fn_agenda_settings` substitui o objeto `agenda` inteiro.
-- Piso `manager`, suporte de escrita e MFA, conferidos por `auth.uid()`.

create or replace function public.fn_definir_modelo_do_evento_agenda(p_org uuid,p_modelo jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_atual jsonb; v_novo jsonb; v_linhas int; v_titulo text; v_desc text;
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
  v_novo := jsonb_build_object('titulo',v_titulo,'descricao',v_desc);
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

comment on function public.fn_definir_modelo_do_evento_agenda(uuid,jsonb) is
  'PC-044: grava settings.modelo_do_evento_agenda (título com campos e nível da descrição do compromisso no calendário). Gerente ou acima, suporte de escrita e MFA; null apaga. Devolve {modelo,mudou}.';

notify pgrst, 'reload schema';
