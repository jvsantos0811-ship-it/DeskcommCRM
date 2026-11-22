-- manifest: Canal ChatGuru (PC-047): colunas do canal em channel_sessions, 'chatguru' nos CHECKs de provider e do arquivo de webhook, índice único do phone_id entre ativos; nasce vazio
--
-- ─── O que entra ────────────────────────────────────────────────────────────
-- Um provedor de canal de mensagem novo: a IA atende DENTRO do ChatGuru que o
-- escritório já usa. O ChatGuru manda cada mensagem do chat por um "POST PARA
-- URL" (ação dos diálogos dele) para a nossa entrada por token, e a resposta
-- sai pela API v1 dele (`message_send`).
--
-- A credencial é da ORGANIZAÇÃO e é colada pela tela (Conexões): servidor da
-- conta (ex.: s7), account_id, phone_id e a API key, esta cifrada por
-- `fn_encrypt_oauth`. O `phone_id` é o `sessionRef` deste canal.
--
-- `chatguru_config` guarda o que o operador escolhe na tela (o diálogo que
-- devolve o chat à equipe, o campo que desliga a IA no chat e as ações que a IA
-- pode executar). Schema único em `lib/channels/atendimento-externo/config.ts`.
--
-- Nasce VAZIO em toda instalação: sem uma conexão gravada pela tela, nada muda
-- (a "chave por organização" deste canal é a própria conexão, e a IA do número
-- nasce fechada, como em todo canal novo).
--
-- ─── Por que recriar os CHECKs inteiros ─────────────────────────────────────
-- Mesmo racional da 0387: `channel_sessions_provider_check` é o vocabulário
-- fechado e `channel_sessions_provider_ref_check` exige a coluna do provider da
-- vez NOT NULL; `webhook_events_log_provider_check` precisa do valor para a rota
-- genérica arquivar o corpo cru antes de conferir o segredo. Alargamento puro
-- nos três: nenhuma linha existente pode violar um CHECK que aceita mais.
--
-- ─── Índice único entre ativos ──────────────────────────────────────────────
-- `chatguru_phone_id` é identificador do PROVIDER. Duas organizações com o
-- mesmo phone_id seriam duas IAs no mesmo chat. A dedup com sufixo
-- `-conflito-<id>` torna a primeira passada idempotente num banco que já tenha
-- linhas repetidas (mesmo desenho da 0165 e da 0387).

alter table public.channel_sessions
  add column if not exists chatguru_servidor text,
  add column if not exists chatguru_account_id text,
  add column if not exists chatguru_phone_id text,
  add column if not exists chatguru_api_key_encrypted bytea,
  add column if not exists chatguru_config jsonb not null default '{}'::jsonb;

comment on column public.channel_sessions.chatguru_phone_id is
  'phone_id do número no ChatGuru (canal PC-047). É o sessionRef deste canal. Espelhado em lib/channels/session-ref.ts.';
comment on column public.channel_sessions.chatguru_api_key_encrypted is
  'API key do ChatGuru, cifrada por fn_encrypt_oauth. Nunca volta à tela depois de gravada.';
comment on column public.channel_sessions.chatguru_config is
  'Escolhas do operador para o canal ChatGuru (diálogo de transferência, campo da IA, ações da IA). Schema em lib/channels/atendimento-externo/config.ts.';

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
    check (provider in ('waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls', 'datafy', 'chatguru'));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha' and waha_session_name is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls' and wacalls_session_id is not null) or
    (provider = 'datafy' and datafy_phone_number_id is not null) or
    (provider = 'chatguru' and chatguru_phone_id is not null)
  );

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy', 'stripe', 'asaas', 'chatguru'
  ));

with ativos as (
  select id,
         row_number() over (
           partition by chatguru_phone_id
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and chatguru_phone_id is not null
)
update public.channel_sessions s
   set chatguru_phone_id = s.chatguru_phone_id || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_chatguru_phone_id_ativo_unique
  on public.channel_sessions (chatguru_phone_id)
  where archived_at is null and chatguru_phone_id is not null;

notify pgrst, 'reload schema';
