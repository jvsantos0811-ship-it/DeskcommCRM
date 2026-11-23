-- manifest: PC-052 — rodízio de responsáveis por tipo de atendimento (`calendar_event_types.rotation_owner_user_ids`): sem responsável escolhido, a vez passa entre as pessoas da lista, e quem não tem horário na janela cede a vez à próxima
--
-- Por que uma coluna `uuid[]` e não uma tabela de vínculo:
--   * a lista é ORDENADA e curta (o rodízio é entre poucas pessoas da equipe);
--     a ordem é a do array, sem coluna de posição para manter;
--   * a tabela-mãe já tem RLS e grants; uma coluna nova herda os dois, e uma
--     tabela nova pediria RLS, grants e semente no teste de isolamento só para
--     guardar uma lista de ids;
--   * quem garante que cada id é da organização é a rota (`/api/v1/agenda/tipos`),
--     que só aceita membro ativo, e a LEITURA (`lib/agenda/rodizio.ts`), que
--     descarta quem saiu da equipe — array não tem FK, e por isso nenhum dos
--     dois lados confia no outro.
--
-- Nulo ou vazio = como antes: vale `default_owner_user_id`.

alter table public.calendar_event_types
  add column if not exists rotation_owner_user_ids uuid[];

comment on column public.calendar_event_types.rotation_owner_user_ids is
  'PC-052: rodízio de responsáveis, na ordem da vez. Nulo/vazio = default_owner_user_id. Ids validados na rota (membro ativo) e filtrados na leitura (lib/agenda/rodizio.ts).';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'calendar_event_types_rotation_owner_user_ids_tamanho'
       and conrelid = 'public.calendar_event_types'::regclass
  ) then
    -- Dados fora da régua antes da constraint (clone que gravou à mão):
    -- corta para os 10 primeiros em vez de quebrar o update.sh.
    update public.calendar_event_types
       set rotation_owner_user_ids = rotation_owner_user_ids[1:10]
     where cardinality(rotation_owner_user_ids) > 10;
    alter table public.calendar_event_types
      add constraint calendar_event_types_rotation_owner_user_ids_tamanho
      check (rotation_owner_user_ids is null or cardinality(rotation_owner_user_ids) <= 10);
  end if;
end $$;
