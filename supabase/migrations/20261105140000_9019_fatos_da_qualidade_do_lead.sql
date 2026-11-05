-- manifest: v3 seção 2 (fork) — fn_dados_qualidade_do_lead: os fatos de cada lead (respostas, última resposta, chance, interesse, duplicado de desqualificado) para a nota 0–100, o nível A–D e os filtros do funil; security invoker
--
-- UMA LINHA POR LEAD, com os FATOS que a nota precisa — não a nota.
--
-- A nota, o nível, a temperatura e a situação saem de `lib/dados/qualidade.ts`
-- (`calcularQualidade`), onde moram os pesos, numa constante só, para calibrar
-- depois com as vendas fechadas. Aqui ficam só os fatos que dependem das
-- mensagens, que não vão para a tela: escrever os pesos também em SQL seria a
-- segunda cópia que um dia diverge. O card do funil, o filtro `?nivel=` e o
-- painel de Dados chamam esta função e aquela regra — os mesmos leads A nos três.
--
-- SECURITY INVOKER: vale a RLS de quem pergunta. O atendente em "só os seus"
-- recebe só os leads dele (policy `crm_leads_select`, migration 0036), e a
-- função não abre lead de ninguém. Com o cliente de serviço (o retrato diário do
-- painel), a RLS não se aplica: quem recorta é `p_org`, sempre obrigatório.
--
-- Os fatos (regras da ordem v3, seção 5, iguais às do painel do Gestor):
--   · mensagens_da_empresa  mensagens `outbound` para o contato;
--   · respostas             `inbound` DEPOIS da primeira `outbound` ("respondeu");
--   · ultima_resposta_em    a última `inbound`;
--   · duplicado_de_desqualificado  card aberto de um contato que tem card perdido;
--   · interesse             procurado nesta ordem, até achar:
--       1. custom_fields.servico | interesse | procedimento | beneficio;
--       2. marcador ben- | srv- | int- (do negócio ou das conversas do contato);
--       3. palavras do lead (mensagens dele e a mensagem do anúncio).
--     O nome é o do TIPO DE LEAD do catálogo quando casa (é o que o filtro
--     `?servico=` usa). As famílias de palavras (auxílio-doença, acidente,
--     BPC/LOAS, aposentadoria, pensão, maternidade) só valem no passo 3 quando
--     a organização tem um tipo de lead daquela família — numa clínica, "sofri
--     um acidente" não vira "Auxílio-acidente".
--   · no_universo           o recorte do painel: funil padrão, sem a base
--     importada nem cadastro manual, sem card de teste. O quadro não usa: todo
--     card tem nota.
--
-- Idempotente: `create or replace`. A assinatura nova sai por `drop ... if
-- exists` com a lista de argumentos, para que mudar o retorno numa próxima
-- migration não esbarre no "cannot change return type".

drop function if exists public.fn_dados_qualidade_do_lead(uuid, uuid);

create or replace function public.fn_dados_qualidade_do_lead(
  p_org uuid,
  p_pipeline_id uuid default null
) returns table (
  lead_id uuid,
  pipeline_id uuid,
  status text,
  criado_em timestamptz,
  etapa_desde timestamptz,
  chance_da_etapa integer,
  prazo_da_etapa_horas numeric,
  chance_da_ia numeric,
  faixa_da_ia text,
  mensagens_da_empresa integer,
  respostas integer,
  primeira_mensagem_do_lead_em timestamptz,
  primeira_resposta_da_empresa_em timestamptz,
  ultima_resposta_em timestamptz,
  duplicado_de_desqualificado boolean,
  interesse text,
  interesse_registrado boolean,
  no_universo boolean
)
  language sql stable security invoker
  set search_path = public, pg_temp
as $fn$
  with l as (
    select l.id, l.pipeline_id, l.contact_id, l.status, l.created_at, l.stage_changed_at,
           l.custom_fields, l.tags, l.source, l.title,
           l.source_metadata->'ad_raw'->'welcome_message'->>'text' as anuncio,
           coalesce(s.win_probability, 0)::int as wp,
           s.expected_duration_hours as sla_h,
           p.is_default
      from public.crm_leads l
      join public.crm_stages s on s.id = l.stage_id
      join public.crm_pipelines p on p.id = l.pipeline_id
     where l.organization_id = p_org
       and (p_pipeline_id is null or l.pipeline_id = p_pipeline_id)
  ),
  contatos as (
    select distinct contact_id from l where contact_id is not null
  ),
  tipos as (
    select c.nome, public.fn_nome_do_tipo_de_lead(c.nome) as chave
      from public.catalog_products c
     where c.organization_id = p_org and c.tipo_de_lead and c.ativo
  ),
  familia(ordem, rotulo, no_nome, na_fala) as (values
    (1, 'Incapacidade (auxílio-doença)', 'doen|incapac', 'aux[ií]lio[- ]?doen|incapacidade|afastad|per[ií]cia'),
    (2, 'Auxílio-acidente',              'acident',      'acidente'),
    (3, 'BPC/LOAS',                      'bpc|loas',     'bpc|loas|defici[eê]n|autis'),
    (4, 'Aposentadoria',                 'aposent',      'aposentad|aposentar|tempo de contribui'),
    (5, 'Pensão por morte',              'pens',         'pens[aã]o por morte|faleceu|falecimento|vi[uú]v'),
    (6, 'Salário-maternidade',           'matern',       'maternidade|gr[aá]vida|gestante')
  ),
  -- O tipo de lead da organização que pertence a cada família (se houver).
  fam as (
    select f.*,
           (select t.nome from tipos t where t.nome ~* f.no_nome order by t.nome limit 1) as do_catalogo
      from familia f
  ),
  m as (
    select mm.contact_id,
           min(mm.created_at) filter (where mm.direction = 'inbound')  as first_in,
           min(mm.created_at) filter (where mm.direction = 'outbound') as first_out,
           max(mm.created_at) filter (where mm.direction = 'inbound')  as last_in,
           count(*) filter (where mm.direction = 'outbound')::int       as n_out
      from public.messages mm
     where mm.organization_id = p_org
       and mm.contact_id in (select contact_id from contatos)
     group by 1
  ),
  r as (
    select mm.contact_id, count(*)::int as n_resp
      from public.messages mm
      join m on m.contact_id = mm.contact_id
     where mm.organization_id = p_org
       and mm.direction = 'inbound'
       and mm.created_at > m.first_out
     group by 1
  ),
  fr as (
    select mm.contact_id, min(mm.created_at) as t
      from public.messages mm
      join m on m.contact_id = mm.contact_id
     where mm.organization_id = p_org
       and mm.direction = 'outbound'
       and mm.created_at >= m.first_in
     group by 1
  ),
  -- Passo 3 do interesse: a primeira família (na ordem) que aparece na fala do
  -- lead, só entre as famílias que têm tipo de lead no catálogo.
  fala as (
    select mm.contact_id, min(f.ordem) as ordem
      from public.messages mm
      join fam f on f.do_catalogo is not null
     where mm.organization_id = p_org
       and mm.contact_id in (select contact_id from contatos)
       and mm.direction = 'inbound'
       and mm.body is not null
       and lower(mm.body) ~ f.na_fala
     group by 1
  ),
  marcadores_da_conversa as (
    select c.contact_id, array_agg(distinct t) as tags
      from public.conversations c, unnest(c.tags) t
     where c.organization_id = p_org
       and c.contact_id in (select contact_id from contatos)
     group by 1
  ),
  perdidos as (
    select distinct d.contact_id
      from public.crm_leads d
     where d.organization_id = p_org
       and d.status = 'lost'
       and d.contact_id in (select contact_id from contatos)
  ),
  b as (
    select l.*,
           m.first_in, m.last_in, coalesce(m.n_out, 0) as n_out,
           coalesce(r.n_resp, 0) as n_resp, fr.t as first_reply,
           sc.ai_probability as aip, sc.ai_probability_band as band,
           (l.status = 'open' and pd.contact_id is not null) as dup,
           coalesce(
             nullif(btrim(l.custom_fields->>'servico'), ''),
             nullif(btrim(l.custom_fields->>'interesse'), ''),
             nullif(btrim(l.custom_fields->>'procedimento'), ''),
             nullif(btrim(l.custom_fields->>'beneficio'), '')
           ) as campo,
           (select x from unnest(l.tags || coalesce(mc.tags, '{}'::text[])) x
             where x ~ '^(ben|srv|int)-' limit 1) as marcador,
           fa.ordem as ordem_da_fala
      from l
      left join m on m.contact_id = l.contact_id
      left join r on r.contact_id = l.contact_id
      left join fr on fr.contact_id = l.contact_id
      left join fala fa on fa.contact_id = l.contact_id
      left join marcadores_da_conversa mc on mc.contact_id = l.contact_id
      left join perdidos pd on pd.contact_id = l.contact_id
      left join public.crm_lead_scores sc on sc.lead_id = l.id and sc.organization_id = p_org
  )
  select b.id,
         b.pipeline_id,
         b.status,
         b.created_at,
         b.stage_changed_at,
         b.wp,
         b.sla_h,
         b.aip,
         b.band,
         b.n_out,
         b.n_resp,
         b.first_in,
         b.first_reply,
         b.last_in,
         b.dup,
         coalesce(
           -- 1 · o campo escrito: o tipo de lead pelo nome; senão a família; senão como está.
           case when b.campo is not null then coalesce(
             (select t.nome from tipos t where t.chave = public.fn_nome_do_tipo_de_lead(b.campo) limit 1),
             (select coalesce(f.do_catalogo, f.rotulo) from fam f where b.campo ~* f.no_nome order by f.ordem limit 1),
             b.campo)
           end,
           -- 2 · o marcador ben-/srv-/int-: o mesmo caminho, com o resto do nome.
           case when b.marcador is not null then coalesce(
             (select t.nome from tipos t
               where t.chave = public.fn_nome_do_tipo_de_lead(substr(b.marcador, 5)) limit 1),
             (select coalesce(f.do_catalogo, f.rotulo) from fam f where b.marcador ~* f.no_nome order by f.ordem limit 1),
             initcap(replace(substr(b.marcador, 5), '-', ' ')))
           end,
           -- 3 · as palavras do lead (e a mensagem do anúncio), só família com tipo no catálogo.
           (select f.do_catalogo from fam f
             where f.do_catalogo is not null
               and (f.ordem = b.ordem_da_fala or (b.anuncio is not null and lower(b.anuncio) ~ f.na_fala))
             order by f.ordem limit 1)
         ),
         (b.campo is not null or b.marcador is not null),
         (b.is_default
           and b.source not in ('importado_zernio', 'manual')
           and b.title not ilike 'teste%')
    from b
$fn$;

comment on function public.fn_dados_qualidade_do_lead(uuid, uuid) is
  'v3 §2 (migration 9019): os fatos de cada lead para a nota de qualidade — a nota e os pesos moram em lib/dados/qualidade.ts. SECURITY INVOKER: vale a RLS de quem pergunta; com o cliente de serviço, p_org recorta.';

revoke execute on function public.fn_dados_qualidade_do_lead(uuid, uuid) from public, anon;
grant execute on function public.fn_dados_qualidade_do_lead(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
