-- manifest: **"Parou antes da qualificação" no painel de Dados (PC-025).** Função nova `fn_dados_ritmo_da_conversa(org, funil, desde, até, posição do marco)`, SECURITY INVOKER (vale a RLS de quem pergunta): para cada card do funil que entrou no período, o horário da primeira mensagem do cliente, da primeira resposta da empresa, quantas vezes o cliente escreveu depois dela, a última mensagem do cliente, o agente de IA da conversa mais recente e se o card já chegou à etapa marco de qualificação (ou depois dela). Das mensagens lê só a direção e o horário — nunca o texto. Sem tabela nova, sem dado migrado, nada escrito. Número 9029, faixa do fork. Idempotente; apêndice igual no `baseline.sql`, antes da VARREDURA anon.
-- 9029: o ritmo da conversa por card, para o painel de Dados (PC-025, item 3).
--
-- ─── Por que uma função, e não `fn_dados_qualidade_do_lead` ─────────────────
--
-- A função da nota (9019) procura o interesse nas PALAVRAS do lead (passo 3),
-- então lê o texto das mensagens. A medida "parou antes da qualificação" não
-- pode ler texto (só contagem e horário), e precisa de qualquer funil, não só
-- do padrão. Esta função lê de `messages` apenas `direction` e `created_at`.
--
-- ─── O universo ─────────────────────────────────────────────────────────────
--
-- O mesmo recorte do painel: sem a base importada (`importado_zernio`), sem
-- cadastro manual e sem card de teste (título "teste…"). O período é o de
-- ENTRADA do card (`created_at`), em instantes já calculados no fuso da
-- organização por quem chama.
--
-- ─── "Chegou ao marco" ──────────────────────────────────────────────────────
--
-- A etapa atual tem posição maior ou igual à do marco, ou a linha do tempo tem
-- uma passagem para uma etapa deste funil nessa altura. Etapa de PERDA não conta
-- (perder não é qualificar). Sem marco (`p_posicao_do_marco` nulo) é sempre
-- falso: quem chama mostra "configure o marco" antes de contar.

create or replace function public.fn_dados_ritmo_da_conversa(
  p_org uuid,
  p_pipeline_id uuid,
  p_desde timestamptz,
  p_ate timestamptz,
  p_posicao_do_marco numeric default null
) returns table (
  lead_id uuid,
  titulo text,
  status text,
  stage_id uuid,
  etapa_posicao numeric,
  criado_em timestamptz,
  origem text,
  anuncio_id text,
  primeira_do_cliente_em timestamptz,
  primeira_resposta_em timestamptz,
  respostas_depois integer,
  ultima_do_cliente_em timestamptz,
  agente_id uuid,
  chegou_ao_marco boolean
)
  language sql stable security invoker
  set search_path = public, pg_temp
as $fn$
  with l as (
    select l.id, l.title, l.status, l.stage_id, s.position, l.created_at, l.contact_id, l.source,
           nullif(btrim(l.source_metadata->>'ad_id'), '') as ad_id
      from public.crm_leads l
      join public.crm_stages s on s.id = l.stage_id
     where l.organization_id = p_org
       and l.pipeline_id = p_pipeline_id
       and l.created_at >= p_desde
       and l.created_at < p_ate
       and coalesce(l.source, '') not in ('importado_zernio', 'manual')
       and l.title not ilike 'teste%'
  ),
  contatos as (
    select distinct contact_id from l where contact_id is not null
  ),
  -- Só direção e horário: o texto da mensagem nunca é lido aqui.
  m as (
    select mm.contact_id,
           min(mm.created_at) filter (where mm.direction = 'inbound') as primeira_in,
           max(mm.created_at) filter (where mm.direction = 'inbound') as ultima_in
      from public.messages mm
     where mm.organization_id = p_org
       and mm.contact_id in (select contact_id from contatos)
     group by 1
  ),
  resp as (
    select mm.contact_id, min(mm.created_at) as t
      from public.messages mm
      join m on m.contact_id = mm.contact_id
     where mm.organization_id = p_org
       and mm.direction = 'outbound'
       and mm.created_at >= m.primeira_in
     group by 1
  ),
  depois as (
    select mm.contact_id, count(*)::int as n
      from public.messages mm
      join resp on resp.contact_id = mm.contact_id
     where mm.organization_id = p_org
       and mm.direction = 'inbound'
       and mm.created_at > resp.t
     group by 1
  ),
  ag as (
    select distinct on (c.contact_id) c.contact_id, c.active_ai_agent_id
      from public.conversations c
     where c.organization_id = p_org
       and c.contact_id in (select contact_id from contatos)
       and coalesce(c.is_group, false) = false
     order by c.contact_id, c.last_message_at desc nulls last, c.created_at desc
  )
  select l.id,
         l.title,
         l.status,
         l.stage_id,
         l.position,
         l.created_at,
         l.source,
         l.ad_id,
         m.primeira_in,
         resp.t,
         coalesce(depois.n, 0),
         m.ultima_in,
         ag.active_ai_agent_id,
         case
           when p_posicao_do_marco is null then false
           else (
             l.position >= p_posicao_do_marco
             or exists (
               select 1
                 from public.crm_lead_activities a
                 join public.crm_stages s2 on s2.id::text = a.payload->>'to_stage_id'
                where a.organization_id = p_org
                  and a.lead_id = l.id
                  and a.type in ('stage_changed', 'demand_closed')
                  and s2.pipeline_id = p_pipeline_id
                  and not s2.is_lost
                  and s2.position >= p_posicao_do_marco
             )
           )
         end
    from l
    left join m on m.contact_id = l.contact_id
    left join resp on resp.contact_id = l.contact_id
    left join depois on depois.contact_id = l.contact_id
    left join ag on ag.contact_id = l.contact_id
   order by l.created_at, l.id
$fn$;

comment on function public.fn_dados_ritmo_da_conversa(uuid, uuid, timestamptz, timestamptz, numeric) is
  'PC-025 (migration 9029): por card do funil que entrou no período, o ritmo da conversa (primeira mensagem do cliente, primeira resposta, respostas depois, última do cliente), o agente de IA da conversa mais recente e se chegou ao marco de qualificação. Lê das mensagens só direção e horário. SECURITY INVOKER: vale a RLS de quem pergunta.';

revoke execute on function public.fn_dados_ritmo_da_conversa(uuid, uuid, timestamptz, timestamptz, numeric) from public, anon;
grant execute on function public.fn_dados_ritmo_da_conversa(uuid, uuid, timestamptz, timestamptz, numeric) to authenticated, service_role;
