-- manifest: PC-050 — quem votou na enquete do grupo vira conversa com a IA: `enquetes_config` (chave por organização, desligada, e o campo do POST de onde vem o voto; guarda só os NOMES dos campos vistos), `enquetes_do_grupo` (código, pergunta e opções, cada uma com o que quer dizer e se a IA chama no privado) e `enquetes_votos` (um voto por contato e enquete; voto trocado atualiza). As três só do servidor (RLS sem policy, sem grant a anon/authenticated)
-- 9041: enquete do grupo (PC-050).
--
-- ─── O caminho ──────────────────────────────────────────────────────────────
--
-- O escritório faz enquete num grupo do WhatsApp que fica na plataforma de
-- atendimento (canal do PC-047). Quem vota quer contato. Um diálogo da
-- plataforma, disparado pelo voto, manda ao votante o modelo aprovado da Meta
-- pelo número oficial e faz o "POST PARA URL" para a entrada do canal, com um
-- campo que identifica a enquete e a opção (contrato recomendado: o diálogo
-- grava `enquete:<código>:<opção>` num campo personalizado).
--
--   * `enquetes_config`: a chave (desligada) e o campo de onde vem o voto,
--     escolhido na tela a partir dos NOMES de campo vistos nos POSTs recebidos
--     (`campos_vistos`; nunca os valores). Se a plataforma mudar o formato, a
--     pessoa remapeia sem código.
--   * `enquetes_do_grupo`: as enquetes cadastradas; por opção, o que ela quer
--     dizer e se a IA chama no privado. Opção "não" = `chamar = false`.
--   * `enquetes_votos`: um voto por contato e enquete. O mesmo voto de novo é o
--     mesmo voto; voto trocado só atualiza a opção. O voto nunca manda mensagem:
--     a primeira mensagem ao votante é o modelo da Meta que a PLATAFORMA manda.
--
-- O agente recebe, no ritual de abertura, "votou na enquete X, opção Y" (só com
-- a chave ligada e voto dos últimos 14 dias). Nada do grupo é lido nem guardado:
-- só o voto que o diálogo do votante entrega.
--
-- As três tabelas são só do servidor: RLS ligada sem policy, sem grant a
-- anon/authenticated (molde de `agencia_pagamentos`, 9030). A tela lê e grava
-- pela rota, com a organização da sessão. Sem dado migrado. Número 9041, faixa
-- do fork. Idempotente; apêndice igual no fim do `baseline.sql` (só tabelas, sem função).

create table if not exists public.enquetes_config (
  organization_id   uuid primary key references public.organizations(id) on delete cascade,
  ligada            boolean not null default false,
  -- Nome do campo do POST (`bot_context`) ou de um campo personalizado
  -- (`campos_personalizados.ia_origem`). Só nome, nunca valor.
  campo_do_voto     text check (campo_do_voto is null or campo_do_voto ~ '^[A-Za-z0-9_$-]{1,60}(\.[A-Za-z0-9_$ -]{1,60})?$'),
  campos_vistos     text[] not null default '{}' check (cardinality(campos_vistos) <= 80),
  campos_vistos_em  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.enquetes_config is
  'PC-050 (migration 9041): a chave da enquete do grupo por organização (desligada) e o campo do POST do canal de atendimento de onde vem o voto. campos_vistos guarda só os NOMES dos campos vistos nos POSTs (somados; nunca os de conteúdo, como texto, nome ou telefone), para a tela oferecer a escolha. Só o servidor: RLS sem policy.';

create table if not exists public.enquetes_do_grupo (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  codigo           text not null check (codigo ~ '^[a-z0-9_-]{1,40}$'),
  pergunta         text not null check (char_length(btrim(pergunta)) between 1 and 300),
  -- [{ "valor": "...", "significado": "...", "chamar": true }], de 1 a 12 opções.
  opcoes           jsonb not null check (jsonb_typeof(opcoes) = 'array' and jsonb_array_length(opcoes) between 1 and 12),
  ativa            boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint enquetes_do_grupo_codigo_unico unique (organization_id, codigo)
);

comment on table public.enquetes_do_grupo is
  'PC-050 (migration 9041): enquetes do grupo cadastradas pela organização — código (o que o diálogo da plataforma manda), pergunta e opções (valor, o que quer dizer, se a IA chama no privado). Só o servidor: RLS sem policy.';

create table if not exists public.enquetes_votos (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  enquete_id       uuid not null references public.enquetes_do_grupo(id) on delete cascade,
  contact_id       uuid not null references public.contacts(id) on delete cascade,
  opcao            text not null check (char_length(opcao) between 1 and 100),
  chamar           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint enquetes_votos_um_por_contato unique (organization_id, enquete_id, contact_id)
);

comment on table public.enquetes_votos is
  'PC-050 (migration 9041): o voto de um contato numa enquete do grupo, entregue pelo diálogo da plataforma de atendimento. Um por contato e enquete; voto trocado atualiza a opção. Nunca dispara mensagem. Só o servidor: RLS sem policy.';

create index if not exists enquetes_votos_contato
  on public.enquetes_votos (organization_id, contact_id, updated_at desc);

alter table public.enquetes_config enable row level security;
alter table public.enquetes_do_grupo enable row level security;
alter table public.enquetes_votos enable row level security;
revoke all on public.enquetes_config from public, anon, authenticated;
revoke all on public.enquetes_do_grupo from public, anon, authenticated;
revoke all on public.enquetes_votos from public, anon, authenticated;
grant select, insert, update on public.enquetes_config to service_role;
grant select, insert, update, delete on public.enquetes_do_grupo to service_role;
grant select, insert, update on public.enquetes_votos to service_role;

drop trigger if exists trg_enquetes_config_touch on public.enquetes_config;
create trigger trg_enquetes_config_touch
  before update on public.enquetes_config
  for each row execute function public.fn_touch_updated_at();

drop trigger if exists trg_enquetes_do_grupo_touch on public.enquetes_do_grupo;
create trigger trg_enquetes_do_grupo_touch
  before update on public.enquetes_do_grupo
  for each row execute function public.fn_touch_updated_at();

drop trigger if exists trg_enquetes_votos_touch on public.enquetes_votos;
create trigger trg_enquetes_votos_touch
  before update on public.enquetes_votos
  for each row execute function public.fn_touch_updated_at();
