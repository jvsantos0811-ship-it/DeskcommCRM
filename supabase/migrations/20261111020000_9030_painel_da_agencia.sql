-- manifest: **Painel da agência no /admin (PC-028).** Três tabelas da INSTALAÇÃO, só do dono (RLS ligada sem policy; `anon` e `authenticated` sem nenhum acesso; escrita pelo `service_role` das rotas de plataforma): `agencia_clientes` (o cadastro manual de cada organização cliente — plano, implantação e se foi paga, mensalidade, início, próximo vencimento, fim do teste, cancelamento), `agencia_pagamentos` (os pagamentos lançados à mão — data, valor, forma, observação, quem lançou e quando; só se acrescenta) e `agencia_config` (uma linha: cotação do dólar, tabela de preço do WhatsApp por categoria e o limiar do alerta de custo). Duas funções de leitura, SECURITY INVOKER e só para o `service_role`: `fn_agencia_numeros(desde, até)` (por organização: leads recebidos, qualificados, passados para a equipe, contratos ganhos, mediana da 1ª resposta, conversas e mensagens da IA, modelos da Meta por categoria e os grátis da janela do anúncio, custo de IA, última conversa nova) e `fn_agencia_por_agente(desde, até)` (custo e contatos atendidos por agente). Só números agregados: nenhum texto de conversa, nome ou telefone. Sem dado migrado. Número 9030, faixa do fork. Idempotente; apêndice igual no `baseline.sql`, antes da VARREDURA anon.
-- 9030: o painel da agência (PC-028).
--
-- ─── Por que tabelas novas ──────────────────────────────────────────────────
--
-- A cobrança do produto (`cobranca_planos`/`cobranca_assinaturas`, migration
-- 0583) existe quando a instalação cobra pelo Stripe/Asaas — e ela não guarda
-- a lista de pagamentos, nem implantação, nem mensalidade negociada fora do
-- plano. A agência do João cobra por fora (implantação + mensalidade por
-- plano), então o painel precisa de lançamento manual. O painel usa a cobrança
-- do produto quando ela existe e o lançamento manual para o resto.
--
-- ─── Quem lê e escreve ──────────────────────────────────────────────────────
--
-- Só o dono da instalação, pelas rotas `/api/v1/admin/agencia/*`
-- (`requirePlatformAdmin`), que usam o `service_role`. Organização cliente
-- NUNCA vê: sem policy, sem grant para `authenticated`.

create table if not exists public.agencia_clientes (
  organization_id     uuid primary key references public.organizations(id) on delete cascade,
  plano               text check (plano is null or char_length(plano) between 1 and 60),
  implantacao_cents   bigint not null default 0 check (implantacao_cents >= 0),
  implantacao_paga    boolean not null default false,
  mensalidade_cents   bigint not null default 0 check (mensalidade_cents >= 0),
  inicio              date,
  proximo_vencimento  date,
  teste_ate           date,
  cancelada_em        date,
  observacao          text check (observacao is null or char_length(observacao) <= 1000),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by          uuid
);

comment on table public.agencia_clientes is
  'PC-028 (migration 9030): o cadastro manual de cada organização cliente da agência — plano, implantação, mensalidade, início, próximo vencimento, fim do teste, cancelamento. Da INSTALAÇÃO: RLS ligada sem policy, só o service_role (rotas /api/v1/admin/agencia).';

create table if not exists public.agencia_pagamentos (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  tipo             text not null default 'mensalidade' check (tipo in ('mensalidade', 'implantacao', 'outro')),
  pago_em          date not null,
  valor_cents      bigint not null check (valor_cents > 0),
  forma            text not null check (forma in ('pix', 'boleto', 'cartao', 'transferencia', 'dinheiro', 'outro')),
  observacao       text check (observacao is null or char_length(observacao) <= 500),
  lancado_por      uuid,
  lancado_em       timestamptz not null default now()
);

comment on table public.agencia_pagamentos is
  'PC-028 (migration 9030): os pagamentos lançados à mão pelo dono da instalação, com quem lançou e quando. Só se acrescenta (a tela não edita nem apaga). Da INSTALAÇÃO: RLS ligada sem policy, só o service_role.';

create index if not exists agencia_pagamentos_org_data
  on public.agencia_pagamentos (organization_id, pago_em desc);

create table if not exists public.agencia_config (
  id                boolean primary key default true check (id),
  cotacao_usd_brl   numeric(10, 4) not null default 5.5000 check (cotacao_usd_brl > 0),
  -- Preço por mensagem de modelo da Meta, em centavos de real, por categoria.
  -- Mensagem de serviço (resposta dentro da janela de 24 h) não é cobrada.
  precos_whatsapp   jsonb not null default '{"marketing": 35, "utilidade": 4, "autenticacao": 4}'::jsonb,
  alerta_custo_pct  numeric(5, 2) not null default 15 check (alerta_custo_pct > 0 and alerta_custo_pct <= 100),
  updated_at        timestamptz not null default now(),
  updated_by        uuid
);

comment on table public.agencia_config is
  'PC-028 (migration 9030): uma linha só — a cotação do dólar, a tabela de preço do WhatsApp por categoria (centavos de real por mensagem de modelo) e o limiar do alerta de custo sobre a mensalidade. Editável na tela da agência.';

insert into public.agencia_config (id) values (true) on conflict (id) do nothing;

alter table public.agencia_clientes enable row level security;
alter table public.agencia_pagamentos enable row level security;
alter table public.agencia_config enable row level security;
revoke all on public.agencia_clientes from anon, authenticated;
revoke all on public.agencia_pagamentos from anon, authenticated;
revoke all on public.agencia_config from anon, authenticated;
grant select, insert, update, delete on public.agencia_clientes to service_role;
grant select, insert on public.agencia_pagamentos to service_role;
grant select, insert, update on public.agencia_config to service_role;

drop trigger if exists trg_agencia_clientes_touch on public.agencia_clientes;
create trigger trg_agencia_clientes_touch
  before update on public.agencia_clientes
  for each row execute function public.fn_touch_updated_at();

drop trigger if exists trg_agencia_config_touch on public.agencia_config;
create trigger trg_agencia_config_touch
  before update on public.agencia_config
  for each row execute function public.fn_touch_updated_at();

-- ─── Os números por organização, num período ────────────────────────────────
--
-- Tudo agregado: contagens, somas e uma mediana. Nenhum texto de mensagem é
-- lido (de `messages` só direção, quem enviou, o NOME do modelo e o horário).
--
--   · leads recebidos     cards criados no período (sem base importada,
--                         cadastro manual e teste — o universo do painel);
--   · qualificados        desses, os que chegaram a etapa com chance >= 50%
--                         ou de ganho (a mesma régua do retrato de Dados);
--   · passados à equipe   passagens IA → pessoa criadas no período;
--   · ganhos              cards ganhos no período (pela data do ganho);
--   · 1ª resposta         mediana, em segundos, entre a 1ª mensagem do
--                         cliente e a 1ª resposta, nos cards do período;
--   · conversas da IA     conversas com ao menos uma resposta da IA no período;
--   · modelos da Meta     mensagens de modelo enviadas no período, pela
--                         categoria do modelo aprovado (sem categoria conhecida
--                         conta como marketing, o mais caro); "grátis do
--                         anúncio" = modelo enviado até 72 h depois de o contato
--                         chegar por anúncio de clique para o WhatsApp;
--   · custo de IA         soma de `llm_calls.cost_cents` (centavos de DÓLAR) no
--                         período — a mesma leitura da tela de Usage.

create or replace function public.fn_agencia_numeros(p_desde timestamptz, p_ate timestamptz)
returns table (
  organization_id uuid,
  leads_recebidos integer,
  qualificados integer,
  passados_para_equipe integer,
  ganhos integer,
  mediana_primeira_resposta_seg numeric,
  conversas_ia integer,
  mensagens_ia integer,
  modelos_marketing integer,
  modelos_utilidade integer,
  modelos_autenticacao integer,
  modelos_gratis_anuncio integer,
  ia_custo_usd_cents numeric,
  ultima_conversa_nova_em timestamptz
)
  language sql stable security invoker
  set search_path = public, pg_temp
as $fn$
  with orgs as (
    select o.id from public.organizations o
  ),
  leads as (
    select l.organization_id, l.id, l.contact_id, l.status, s.win_probability, s.is_won
      from public.crm_leads l
      join public.crm_stages s on s.id = l.stage_id
     where l.created_at >= p_desde and l.created_at < p_ate
       and coalesce(l.source, '') not in ('importado_zernio', 'manual')
       and l.title not ilike 'teste%'
  ),
  qualif as (
    select l.organization_id, count(*)::int as n
      from leads l
     where coalesce(l.win_probability, 0) >= 50 or l.is_won or l.status = 'won'
        or exists (
          select 1 from public.crm_lead_activities a
            join public.crm_stages s2 on s2.id::text = a.payload->>'to_stage_id'
           where a.organization_id = l.organization_id and a.lead_id = l.id
             and a.type in ('stage_changed', 'demand_closed')
             and (coalesce(s2.win_probability, 0) >= 50 or s2.is_won))
     group by 1
  ),
  primeira as (
    select l.organization_id,
           percentile_cont(0.5) within group (order by extract(epoch from (fr.t - fi.t)))::numeric as mediana
      from leads l
      join lateral (
        select min(m.created_at) as t from public.messages m
         where m.organization_id = l.organization_id and m.contact_id = l.contact_id and m.direction = 'inbound'
      ) fi on fi.t is not null
      join lateral (
        select min(m.created_at) as t from public.messages m
         where m.organization_id = l.organization_id and m.contact_id = l.contact_id
           and m.direction = 'outbound' and m.created_at >= fi.t
      ) fr on fr.t is not null
     group by 1
  ),
  ia as (
    select m.organization_id, count(*)::int as msgs, count(distinct m.conversation_id)::int as conversas
      from public.messages m
     where m.created_at >= p_desde and m.created_at < p_ate
       and m.direction = 'outbound' and m.sent_via = 'ai'
     group by 1
  ),
  modelos as (
    select m.organization_id,
           case
             when c.source_metadata ? 'ad_id'
                  and m.created_at < c.created_at + interval '72 hours' then 'gratis'
             else coalesce(
               (select case upper(t.category)
                         when 'UTILITY' then 'utilidade'
                         when 'AUTHENTICATION' then 'autenticacao'
                         else 'marketing' end
                  from public.meta_templates t
                 where t.organization_id = m.organization_id and t.name = m.template_name
                 limit 1),
               'marketing')
           end as categoria
      from public.messages m
      join public.contacts c on c.id = m.contact_id
     where m.created_at >= p_desde and m.created_at < p_ate
       and m.direction = 'outbound' and m.template_name is not null
  ),
  por_categoria as (
    select organization_id,
           count(*) filter (where categoria = 'marketing')::int as marketing,
           count(*) filter (where categoria = 'utilidade')::int as utilidade,
           count(*) filter (where categoria = 'autenticacao')::int as autenticacao,
           count(*) filter (where categoria = 'gratis')::int as gratis
      from modelos group by 1
  ),
  custo as (
    select k.organization_id, coalesce(sum(k.cost_cents), 0)::numeric as usd
      from public.llm_calls k
     where k.created_at >= p_desde and k.created_at < p_ate
     group by 1
  ),
  passagens as (
    select p.organization_id, count(*)::int as n
      from public.passagens_de_atendimento p
     where p.criado_em >= p_desde and p.criado_em < p_ate
     group by 1
  ),
  ganhos as (
    select l.organization_id, count(*)::int as n
      from public.crm_leads l
     where l.status = 'won' and l.closed_at >= p_desde and l.closed_at < p_ate
     group by 1
  ),
  ultima as (
    select c.organization_id, max(c.created_at) as em
      from public.conversations c
     where coalesce(c.is_group, false) = false
     group by 1
  )
  select o.id,
         coalesce((select count(*) from leads l where l.organization_id = o.id), 0)::int,
         coalesce(q.n, 0),
         coalesce(pa.n, 0),
         coalesce(g.n, 0),
         pr.mediana,
         coalesce(ia.conversas, 0),
         coalesce(ia.msgs, 0),
         coalesce(pc.marketing, 0),
         coalesce(pc.utilidade, 0),
         coalesce(pc.autenticacao, 0),
         coalesce(pc.gratis, 0),
         coalesce(cu.usd, 0),
         u.em
    from orgs o
    left join qualif q on q.organization_id = o.id
    left join passagens pa on pa.organization_id = o.id
    left join ganhos g on g.organization_id = o.id
    left join primeira pr on pr.organization_id = o.id
    left join ia on ia.organization_id = o.id
    left join por_categoria pc on pc.organization_id = o.id
    left join custo cu on cu.organization_id = o.id
    left join ultima u on u.organization_id = o.id
$fn$;

comment on function public.fn_agencia_numeros(timestamptz, timestamptz) is
  'PC-028 (migration 9030): os números agregados de cada organização no período, para o painel da agência (/admin). Só contagens, somas e uma mediana — nenhum texto, nome ou telefone. Custo de IA em centavos de DÓLAR, a mesma leitura de llm_calls da tela de Usage. SECURITY INVOKER, só o service_role.';

revoke execute on function public.fn_agencia_numeros(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.fn_agencia_numeros(timestamptz, timestamptz) to service_role;

create or replace function public.fn_agencia_por_agente(p_desde timestamptz, p_ate timestamptz)
returns table (
  organization_id uuid,
  agent_id uuid,
  custo_usd_cents numeric,
  contatos integer
)
  language sql stable security invoker
  set search_path = public, pg_temp
as $fn$
  select k.organization_id,
         k.agent_id,
         coalesce(sum(k.cost_cents), 0)::numeric,
         count(distinct k.contact_id)::int
    from public.llm_calls k
   where k.created_at >= p_desde and k.created_at < p_ate
   group by 1, 2
$fn$;

comment on function public.fn_agencia_por_agente(timestamptz, timestamptz) is
  'PC-028 (migration 9030): custo de IA (centavos de dólar) e contatos atendidos por agente de cada organização no período. Agente nulo = chamada fora de um agente (classificadores, resumo). SECURITY INVOKER, só o service_role.';

revoke execute on function public.fn_agencia_por_agente(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.fn_agencia_por_agente(timestamptz, timestamptz) to service_role;
