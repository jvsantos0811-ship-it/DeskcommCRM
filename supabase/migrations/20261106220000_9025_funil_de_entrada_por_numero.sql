-- manifest: cada número conectado (channel_sessions) decide se a conversa nova abre card no funil e em qual funil/etapa (abre_card, funil_de_entrada_id, etapa_de_entrada_id); padrão "Sim · funil padrão da empresa", nada muda até alguém mexer
--
-- ═══ O PROBLEMA, MEDIDO ═══
--
-- Toda conversa nova, de QUALQUER número da empresa, abria card no funil padrão
-- (`crm_pipelines.is_default`). Numa empresa com um número comercial e outro de
-- uso interno, o segundo enchia o funil de vendas: em 06/11/2026 um número que
-- não é comercial abriu 7 cards em duas horas (5 por mensagem recebida e 2 pela
-- primeira mensagem enviada do celular). Não havia como contornar sem código:
-- `garantirLeadDaConversa` decidia só pelo contato e pelo funil padrão.
--
-- ═══ O QUE ENTRA ═══
--
-- Três colunas no próprio número (`channel_sessions`), lidas por
-- `garantirLeadDaConversa` (lib/leads/nascimento-do-lead.ts), que é o ponto
-- comum de todo caminho que faz nascer card de conversa (mensagem recebida por
-- qualquer provedor e primeira mensagem enviada do celular):
--
--   * `abre_card`            — false: a conversa entra normalmente (contato,
--     mensagens, Inbox, opt-out), só o card não nasce;
--   * `funil_de_entrada_id`  — NULL = funil padrão da empresa;
--   * `etapa_de_entrada_id`  — NULL = primeira etapa aberta do funil.
--
-- Colunas e não `metadata`: a FK composta com a organização (mesmo desenho da
-- 0542, destino da intenção do roteador) garante que um número nunca aponte
-- para funil ou etapa de OUTRA empresa, e `on delete set null (coluna)` zera só
-- o destino quando o funil ou a etapa é excluído — o número volta ao padrão em
-- vez de quebrar. Funil ARQUIVADO não é excluído: quem cuida dele é a regra no
-- código (o card cai no funil padrão e a tela do número avisa), porque perder o
-- lead é pior que errar o funil.
--
-- Padrão `abre_card = true` e destino nulo: todo número que já existe e todo
-- número novo continuam exatamente como antes.
--
-- Idempotente: `add column if not exists` e constraint em `do` com
-- `duplicate_object`. Sem função nova (nada a revogar de anon).

alter table public.channel_sessions
  add column if not exists abre_card boolean not null default true,
  add column if not exists funil_de_entrada_id uuid,
  add column if not exists etapa_de_entrada_id uuid;

do $$ begin
  alter table public.channel_sessions
    add constraint channel_sessions_funil_de_entrada_mesma_org
    foreign key (organization_id, funil_de_entrada_id)
    references public.crm_pipelines (organization_id, id)
    on delete set null (funil_de_entrada_id);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.channel_sessions
    add constraint channel_sessions_etapa_de_entrada_mesma_org
    foreign key (organization_id, etapa_de_entrada_id)
    references public.crm_stages (organization_id, id)
    on delete set null (etapa_de_entrada_id);
exception when duplicate_object then null; end $$;

comment on column public.channel_sessions.abre_card is
  'Conversa nova por este número abre card no funil? false = só a conversa entra (contato, mensagens, Inbox); o card não nasce (motivo numero_sem_funil). Padrão true.';
comment on column public.channel_sessions.funil_de_entrada_id is
  'Funil onde nasce o card das conversas novas deste número. NULL = funil padrão da empresa. Funil arquivado: o card nasce no padrão e a tela avisa.';
comment on column public.channel_sessions.etapa_de_entrada_id is
  'Etapa de entrada dentro de funil_de_entrada_id. NULL = primeira etapa aberta do funil.';
