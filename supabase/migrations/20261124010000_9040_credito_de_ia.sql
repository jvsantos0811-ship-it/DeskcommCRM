-- manifest: PC-051 — crédito de IA comprado pelo CRM quando o teto do plano acaba: pacotes da INSTALAÇÃO (`cobranca_pacotes_credito_ia`, preço em reais e quanto de IA libera), oferta por plano (`cobranca_planos.oferece_credito_ia`, desligada), compras e cortesias por organização (`ia_creditos`, só o servidor lê e escreve) e `fn_credito_de_ia_disponivel(org)`, que soma ao teto do mês o crédito pago que ainda vale (vence no fim do mês seguinte ao pagamento; consome primeiro o incluído no plano, depois o crédito mais antigo)
-- 9040: crédito de IA (PC-051).
--
-- ─── O que existe antes ─────────────────────────────────────────────────────
--
-- O teto de IA do plano (`cobranca_planos.teto_ia_usd_cents`, lido por
-- `fn_limite_do_plano(org, 'ia_usd_cents')`) BLOQUEIA a chave da instalação
-- quando o gasto do mês (`fn_gasto_de_ia_do_mes`) o alcança: as conversas vão
-- para a equipe. A saída que faltava é a 4ª: comprar crédito.
--
-- ─── O desenho ──────────────────────────────────────────────────────────────
--
--   * pacotes (`cobranca_pacotes_credito_ia`): da INSTALAÇÃO, como os planos.
--     Preço em centavos de REAL (o cliente nunca vê dólar) e quanto de IA o
--     pacote libera, em centavos de DÓLAR (a régua de `llm_calls.cost_cents`).
--     Sem pacote ativo = como antes.
--   * oferta por plano (`cobranca_planos.oferece_credito_ia`): nasce `false`.
--     Pacote cadastrado e plano sem a oferta = como antes.
--   * compras e cortesias (`ia_creditos`): uma linha por compra (nasce
--     `pendente`, vira `pago` só quando o provedor confirma, relido na API) ou
--     por cortesia do dono (nasce `pago`, com motivo). Tabela só do servidor:
--     RLS ligada SEM policy, sem grant a anon/authenticated — o molde de
--     `agencia_pagamentos` (9030). A tela da empresa lê pela rota, que confere
--     o papel e usa a organização da sessão.
--   * `fn_credito_de_ia_disponivel(org)`: o crédito que vale no mês corrente,
--     ANTES do consumo deste mês. O teto efetivo do mês é
--     `teto do plano + esse crédito`. Regras do João (23/11):
--       - o que sobrar vence no fim do mês SEGUINTE ao do pagamento;
--       - só o crédito comprado passa de um mês para o outro; o incluído no
--         plano não acumula;
--       - consumo: primeiro o incluído no plano do mês, depois o crédito
--         comprado, o mais antigo primeiro.
--     Por mês m, desde o mês do 1º crédito pago: A = o que sobrou dos créditos
--     do mês anterior; B = os pagos em m; excesso = max(0, gasto(m) − teto).
--     O excesso come A primeiro (vence antes), depois B; o que sobra de B passa
--     a ser o A do mês seguinte; o que sobra de A vence. No mês corrente a
--     função devolve A + B.
--     ⚠️ O teto dos meses passados é o do plano ATUAL (o histórico de plano não
--     é guardado por mês): quem trocou de plano no mês anterior pode ver o
--     consumo do crédito daquele mês calculado com o teto novo.
--     ⚠️ O gasto de cada mês passado é somado aqui (janela [m, m+1)), pela mesma
--     régua de `fn_gasto_de_ia_do_mes` (soma de `llm_calls.cost_cents`); o gate
--     só chama esta função quando o gasto do mês já alcançou o teto do plano.
--
-- Sem dado migrado. Número 9040, faixa do fork. Idempotente; apêndice igual no
-- `baseline.sql`, antes da VARREDURA anon.

create table if not exists public.cobranca_pacotes_credito_ia (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null check (char_length(btrim(nome)) between 1 and 60),
  -- Centavos de REAL. Mínimo de R$ 5,00: o mesmo piso de boleto dos planos.
  preco_cents   bigint not null check (preco_cents >= 500 and preco_cents <= 100000000),
  -- Centavos de DÓLAR: quanto de IA o pacote libera (régua de llm_calls.cost_cents).
  ia_usd_cents  integer not null check (ia_usd_cents >= 100),
  arquivado_em  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.cobranca_pacotes_credito_ia is
  'PC-051 (migration 9040): pacotes de crédito de IA da INSTALAÇÃO — preço em centavos de real e quanto de IA o pacote libera (centavos de dólar). Arquivado sai da oferta. RLS ligada sem policy: só o service_role (rotas /api/v1/admin/cobranca/creditos-ia e /api/v1/cobranca/credito-ia).';

alter table public.cobranca_planos
  add column if not exists oferece_credito_ia boolean not null default false;

comment on column public.cobranca_planos.oferece_credito_ia is
  'PC-051: a empresa neste plano pode comprar crédito de IA (pacotes de cobranca_pacotes_credito_ia). Nasce false: sem a oferta, o teto do plano bloqueia como antes.';

create table if not exists public.ia_creditos (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  pacote_id        uuid references public.cobranca_pacotes_credito_ia(id) on delete set null,
  origem           text not null check (origem in ('compra', 'cortesia')),
  status           text not null default 'pendente' check (status in ('pendente', 'pago', 'cancelado')),
  -- Centavos de REAL cobrados (nulo na cortesia).
  preco_cents      bigint check (preco_cents is null or preco_cents > 0),
  -- Centavos de DÓLAR liberados quando pago.
  ia_usd_cents     integer not null check (ia_usd_cents > 0),
  provedor         text check (provedor is null or provedor in ('stripe', 'asaas')),
  pagamento_ref    text check (pagamento_ref is null or char_length(pagamento_ref) between 1 and 200),
  link_pagamento   text check (link_pagamento is null or char_length(link_pagamento) <= 2000),
  motivo           text check (motivo is null or char_length(btrim(motivo)) between 3 and 300),
  pago_em          timestamptz,
  vence_em         timestamptz,
  criado_por       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint ia_creditos_pago_tem_datas check (status <> 'pago' or (pago_em is not null and vence_em is not null)),
  constraint ia_creditos_cortesia_tem_motivo check (origem <> 'cortesia' or motivo is not null),
  constraint ia_creditos_compra_tem_preco check (origem <> 'compra' or preco_cents is not null)
);

comment on table public.ia_creditos is
  'PC-051 (migration 9040): crédito de IA de cada organização — compra (nasce pendente, vira pago só com o pagamento relido no provedor) ou cortesia do dono (nasce paga, com motivo). Vence no fim do mês seguinte ao do pagamento. Só o servidor lê e escreve: RLS ligada sem policy, sem grant a anon/authenticated.';

create unique index if not exists ia_creditos_pagamento_unico
  on public.ia_creditos (provedor, pagamento_ref)
  where pagamento_ref is not null;

create index if not exists ia_creditos_org_status
  on public.ia_creditos (organization_id, status, pago_em);

alter table public.cobranca_pacotes_credito_ia enable row level security;
alter table public.ia_creditos enable row level security;
revoke all on public.cobranca_pacotes_credito_ia from public, anon, authenticated;
revoke all on public.ia_creditos from public, anon, authenticated;
grant select, insert, update on public.cobranca_pacotes_credito_ia to service_role;
grant select, insert, update on public.ia_creditos to service_role;

drop trigger if exists trg_cobranca_pacotes_credito_ia_touch on public.cobranca_pacotes_credito_ia;
create trigger trg_cobranca_pacotes_credito_ia_touch
  before update on public.cobranca_pacotes_credito_ia
  for each row execute function public.fn_touch_updated_at();

drop trigger if exists trg_ia_creditos_touch on public.ia_creditos;
create trigger trg_ia_creditos_touch
  before update on public.ia_creditos
  for each row execute function public.fn_touch_updated_at();

create or replace function public.fn_credito_de_ia_disponivel(p_org uuid)
returns numeric
  language plpgsql
  stable
  security invoker
  set search_path = public, pg_temp
as $fn$
declare
  v_teto       numeric := public.fn_limite_do_plano(p_org, 'ia_usd_cents');
  v_mes_atual  timestamptz := date_trunc('month', now());
  v_mes        timestamptz;
  v_sobra      numeric := 0;  -- A: o que sobrou dos créditos pagos no mês anterior
  v_novos      numeric;       -- B: pagos no mês
  v_gasto      numeric;
  v_excesso    numeric;
begin
  -- Sem teto do plano não há o que somar: a empresa não é bloqueada por plano.
  if v_teto is null then
    return 0;
  end if;

  select date_trunc('month', min(c.pago_em))
    into v_mes
    from public.ia_creditos c
   where c.organization_id = p_org
     and c.status = 'pago';
  if v_mes is null then
    return 0;
  end if;

  loop
    select coalesce(sum(c.ia_usd_cents), 0)
      into v_novos
      from public.ia_creditos c
     where c.organization_id = p_org
       and c.status = 'pago'
       and c.pago_em >= v_mes
       and c.pago_em < v_mes + interval '1 month';

    if v_mes >= v_mes_atual then
      return v_sobra + v_novos;
    end if;

    select coalesce(sum(l.cost_cents), 0)
      into v_gasto
      from public.llm_calls l
     where l.organization_id = p_org
       and l.created_at >= v_mes
       and l.created_at < v_mes + interval '1 month';

    v_excesso := greatest(0, v_gasto - v_teto);
    -- O excesso come primeiro o que vence no fim deste mês (A); o resto, os
    -- comprados neste mês (B). O que sobra de B é o A do mês seguinte.
    v_sobra := greatest(0, v_novos - greatest(0, v_excesso - v_sobra));
    v_mes := v_mes + interval '1 month';
  end loop;
end;
$fn$;

comment on function public.fn_credito_de_ia_disponivel(uuid) is
  'PC-051: crédito de IA pago que vale no mês corrente, ANTES do consumo deste mês (centavos de dólar). O teto efetivo é fn_limite_do_plano(org,''ia_usd_cents'') + este valor. Crédito vence no fim do mês seguinte ao do pagamento; consumo: incluído no plano, depois o crédito mais antigo. Sem teto do plano = 0. security invoker: recebe a organização por argumento.';

revoke execute on function public.fn_credito_de_ia_disponivel(uuid) from public, anon, authenticated;
grant execute on function public.fn_credito_de_ia_disponivel(uuid) to service_role;

notify pgrst, 'reload schema';
