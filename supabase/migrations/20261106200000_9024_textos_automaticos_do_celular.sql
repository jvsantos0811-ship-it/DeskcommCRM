-- manifest: PM-027 §6 (fork) — fn_textos_automaticos_do_celular: por organização e janela (90 dias), os textos que saíram do celular do escritório IGUAIS em 3+ conversas, com quantas vezes saíram até 60 s depois da mensagem do lead; o painel "Esperando a equipe" e o aviso "Ninguém respondeu" tratam como automático o texto com 80% ou mais das vezes no prazo (a saudação do WhatsApp Business e o robô do histórico importado), mais o índice parcial das saídas do celular por organização e data; security invoker, só o service_role executa
--
-- POR QUE PELO TEXTO, E NÃO MENSAGEM A MENSAGEM. A saudação automática do
-- WhatsApp Business e o robô da plataforma antiga (histórico importado) chegam
-- como `external_device`, iguais à fala de uma pessoa pelo celular. Decidir
-- cada mensagem por "saiu até 60 s depois do lead" deixa passar a automática
-- que saiu atrasada — na Bórbora a saudação saiu 3 vezes entre 61 s e 502 s —,
-- e ela contaria como PESSOA: tiraria o lead do painel "Esperando a equipe".
-- O erro que esconde lead é não reconhecer a automática. Por isso a decisão é
-- do TEXTO: igual em 3 ou mais conversas e 80% ou mais das vezes no prazo; aí
-- TODA mensagem com aquele texto é automática. Medido na Bórbora (60 dias):
-- saudação 95%, menu do robô 100%, "[Unsupported message]" 80%; de pessoa,
-- "Ok" 39%, "Boa tarde" 41%, "Só um momento" 38%.
--
-- Esta função só CONTA (texto, conversas, vezes, no prazo); a proporção e a
-- decisão moram em `lib/messaging/textos-automaticos.ts`, junto com a mesma
-- normalização do texto (espaços juntos, sem espaço nas pontas, minúsculas).
--
-- "Depois da mensagem do lead" = a última mensagem recebida do lead na mesma
-- conversa até aquele envio.
--
-- SECURITY INVOKER e executável só pelo service_role (o painel e o cron leem
-- com o cliente de serviço e filtram a organização da sessão à mão): ninguém
-- pela anon key nem logado alcança a contagem como RPC. As duas origens de
-- EXECUTE (o grant a PUBLIC da criação e o default ACL do baseline para anon)
-- são revogadas.
--
-- O índice parcial cobre só as saídas do celular — uma fração pequena da
-- tabela —, por organização e data: a janela de 90 dias deixa de varrer as
-- mensagens da organização inteira.
--
-- Idempotente: `if not exists` e `create or replace`.

create index if not exists messages_celular_saida_idx
  on public.messages (organization_id, created_at)
  where direction = 'outbound' and sent_via = 'external_device';

create or replace function public.fn_textos_automaticos_do_celular(
  p_org uuid,
  p_desde timestamptz,
  p_segundos integer default 60,
  p_min_conversas integer default 3
)
returns table (texto text, conversas integer, vezes integer, no_prazo integer)
language sql
stable
security invoker
set search_path = public
as $$
  with saidas as (
    select m.conversation_id,
           lower(btrim(regexp_replace(coalesce(m.body, ''), '\s+', ' ', 'g'))) as texto,
           m.created_at
      from public.messages m
     where m.organization_id = p_org
       and m.direction = 'outbound'
       and m.sent_via = 'external_device'
       and m.created_at >= p_desde
  ),
  com_o_lead as (
    select s.conversation_id, s.texto, s.created_at, l.created_at as do_lead
      from saidas s
      left join lateral (
        select i.created_at
          from public.messages i
         where i.conversation_id = s.conversation_id
           and i.organization_id = p_org
           and i.direction = 'inbound'
           and i.created_at <= s.created_at
         order by i.created_at desc
         limit 1
      ) l on true
     where s.texto <> ''
  )
  select c.texto,
         count(distinct c.conversation_id)::integer,
         count(*)::integer,
         (count(*) filter (
            where c.do_lead is not null
              and c.created_at - c.do_lead <= make_interval(secs => p_segundos)
         ))::integer
    from com_o_lead c
   group by c.texto
  having count(distinct c.conversation_id) >= p_min_conversas
$$;

revoke execute on function public.fn_textos_automaticos_do_celular(uuid, timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.fn_textos_automaticos_do_celular(uuid, timestamptz, integer, integer) to service_role;

comment on function public.fn_textos_automaticos_do_celular(uuid, timestamptz, integer, integer) is
  'PM-027 §6 (migration 9024): os textos que o celular do escritório mandou IGUAIS em 3+ conversas desde p_desde, com quantas vezes saíram até p_segundos depois da mensagem do lead. A decisão (80% no prazo = automático) mora em lib/messaging/textos-automaticos.ts. Só o service_role executa.';
