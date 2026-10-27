-- manifest: **Passagem para humano cancela as mensagens agendadas da conversa.** Gatilho AFTER INSERT em `passagens_de_atendimento` — a linha que TODO caminho de passagem IA → humano grava (`registrarPassagem`, `lib/escalacao/passagem.ts`): as `scheduled_messages` daquela conversa ainda em `scheduled` viram `cancelled`, e cada uma deixa uma nota no fio (`conversation_notes`, "Sistema") com o trecho do texto e a hora em que sairia, no idioma e no fuso da organização. Decisão do dono (item 2.2 do briefing de 26/10/2026): recado agendado antes da passagem não fala por cima de quem assumiu. `sending` não é tocada (já está saindo). Falha do gatilho nunca derruba a passagem. Número 9007, faixa do fork. Idempotente; apêndice igual no `baseline.sql`, antes da VARREDURA anon.
-- 9007: a passagem para humano cancela as mensagens agendadas da conversa.
--
-- ─── O que acontecia ────────────────────────────────────────────────────────
--
-- Um atendente agenda "te mando o link amanhã às 9h" numa conversa que a IA
-- ainda atende. No meio da noite a IA passa a conversa para uma pessoa (pedido
-- do cliente, etapa "só atendimento humano", teto de gasto…). Às 9h o recado
-- saía mesmo assim, por cima de quem assumiu e talvez já tinha resolvido tudo
-- de outro jeito. O #11 fechou essa porta para a API e as integrações; o
-- agendamento, que sai em nome de quem agendou, continuava aberto.
--
-- ─── Por que no banco, e por que NESTA tabela ───────────────────────────────
--
-- Passagem tem treze caminhos de código, em dois motores (pg.Pool e
-- supabase-js). Todos gravam a mesma linha em `passagens_de_atendimento`, e é
-- por isso que o gatilho mora nela: um caminho novo de passagem já nasce
-- cancelando, sem ninguém lembrar de chamar nada. É escrita local, na mesma
-- transação — nenhum HTTP (anti-pattern 9).
--
-- ─── O que NÃO é tocado ─────────────────────────────────────────────────────
--
--  - `sending`: o cron já pegou a linha e está enviando. Cancelar ali não
--    impede a saída e mentiria no estado. A disputa com o cron é resolvida pela
--    trava da linha: os dois atualizam `where status = 'scheduled'`, e quem
--    chega depois não acha mais a linha nesse estado.
--  - O que for agendado DEPOIS da passagem: já é de quem está atendendo.
--  - A volta para o automático (`reconhecido_em`) é UPDATE, e o gatilho é só de
--    INSERT.
--
-- ─── Por que a falha do gatilho não sobe ────────────────────────────────────
--
-- Quando esta linha é gravada a passagem já aconteceu (o `force_human`, o
-- aviso ao cliente). Um erro aqui — fuso inválido gravado na organização, por
-- exemplo — derrubaria o REGISTRO da passagem, que é o que a Central e o
-- relatório leem. O bloco interno desfaz só os cancelamentos e deixa um WARNING
-- no log do Postgres; a passagem fica gravada.

create or replace function public.fn_passagem_cancela_agendadas()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fuso text;
  v_espanhol boolean;
  v_trecho text;
  v_quando text;
  r record;
begin
  begin
    select o.timezone, coalesce(o.locale, 'pt-BR') like 'es%'
      into v_fuso, v_espanhol
      from public.organizations o
     where o.id = new.organization_id;

    if v_fuso is null or not exists (select 1 from pg_timezone_names where name = v_fuso) then
      v_fuso := 'America/Sao_Paulo';
    end if;

    for r in
      update public.scheduled_messages s
         set status = 'cancelled',
             cancelled_at = now(),
             cancelled_by_user_id = null,
             updated_at = now()
       where s.organization_id = new.organization_id
         and s.conversation_id = new.conversation_id
         and s.status = 'scheduled'
      returning s.body, s.send_at
    loop
      v_trecho := regexp_replace(btrim(r.body), '\s+', ' ', 'g');
      if char_length(v_trecho) > 120 then
        v_trecho := left(v_trecho, 117) || '…';
      end if;

      if v_espanhol then
        v_quando := to_char(r.send_at at time zone v_fuso, 'DD/MM "a las" HH24:MI');
        insert into public.conversation_notes
          (organization_id, conversation_id, body, created_by_user_id, created_by_name)
        values (
          new.organization_id, new.conversation_id,
          'Mensaje programado cancelado: la conversación pasó a atención humana. Saldría el '
            || v_quando || '. Si todavía tiene sentido, prográmelo de nuevo.'
            || E'\n\n' || 'Texto: "' || v_trecho || '"',
          null, 'Sistema');
      else
        v_quando := to_char(r.send_at at time zone v_fuso, 'DD/MM "às" HH24:MI');
        insert into public.conversation_notes
          (organization_id, conversation_id, body, created_by_user_id, created_by_name)
        values (
          new.organization_id, new.conversation_id,
          'Mensagem agendada cancelada: a conversa passou para atendimento humano. Ela sairia em '
            || v_quando || '. Se ainda fizer sentido, agende de novo.'
            || E'\n\n' || 'Texto: "' || v_trecho || '"',
          null, 'Sistema');
      end if;
    end loop;
  exception when others then
    raise warning 'fn_passagem_cancela_agendadas: % (conversa %)', sqlerrm, new.conversation_id;
  end;
  return null;
end;
$$;

-- As DUAS origens de EXECUTE (o default privileges do baseline e o grant a
-- PUBLIC do Postgres). Função de gatilho não é chamada por ninguém: disparar o
-- gatilho não exige EXECUTE de quem grava a passagem.
revoke execute on function public.fn_passagem_cancela_agendadas() from public, anon, authenticated;

drop trigger if exists trg_passagem_cancela_agendadas on public.passagens_de_atendimento;
create trigger trg_passagem_cancela_agendadas
  after insert on public.passagens_de_atendimento
  for each row
  execute function public.fn_passagem_cancela_agendadas();

comment on function public.fn_passagem_cancela_agendadas() is
  'Gatilho da passagem IA → humano: cancela as mensagens agendadas ainda em scheduled da conversa e deixa uma nota no fio por mensagem. '
  'Nunca derruba o registro da passagem (falha vira WARNING). Migration 9007 (fork).';
