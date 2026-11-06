-- manifest: PM-025 §7 (fork) — aviso "Um lead escreveu e ninguém respondeu" na Central: `agent_inbox_items_kind_check` ganha `ninguem_respondeu` (lista completa; esta passa a ser a última migration que a reconstrói), um aviso ABERTO por conversa (índice único parcial) e a tabela `conferencias_de_fim_da_conversa`, que guarda a resposta da leitura curta ("a conversa terminou?") por mensagem do lead, para a rodada de 5 em 5 minutos não perguntar duas vezes nem pagar duas vezes
--
-- O AVISO QUE FALTAVA. Na Bórbora, 7 conversas do funil de vendas ficaram dias
-- com a última mensagem do lead sem resposta, e nada na Central dizia isso. O
-- cron `ninguem-respondeu` (a cada 5 min) olha as conversas das organizações que
-- ligaram o aviso e abre um item quando a última mensagem é do lead e ninguém —
-- IA ou pessoa, inclusive pelo celular — respondeu em 1 hora de EXPEDIENTE
-- (`lib/dados/expediente.ts`). A regra inteira mora em
-- `lib/escalacao/ninguem-respondeu.ts`; aqui só o que precisa do banco.
--
-- ─── O vocabulário ──────────────────────────────────────────────────────────
-- Reconstrói o CHECK com a lista inteira mais o kind novo (drop + add no mesmo
-- arquivo, `tests/unit/reconstruir-constraint-derruba-antes.test.ts`).
--
-- ─── Um aberto por conversa ────────────────────────────────────────────────
-- Índice único parcial em (organização, kind, conversa) enquanto `open`: a
-- rodada pode correr duas vezes ao mesmo tempo sem abrir dois itens (o segundo
-- insert dá 23505 e é ignorado). Fechado, a conversa pode ganhar outro aviso
-- numa espera seguinte. Kind novo: não há linha antiga para deduplicar.
--
-- ─── A memória da leitura curta ────────────────────────────────────────────
-- Quando a forma da mensagem não decide ("obrigado" decide; "vou verificar" não),
-- uma leitura curta (ponto `conferir_fim_da_conversa`) diz se a conversa
-- terminou. A resposta é gravada por MENSAGEM do lead: a rodada seguinte lê a
-- tabela em vez de perguntar de novo. Sem texto de conversa, sem nome, sem
-- motivo livre: só ids, o veredito, a origem e o modelo (LGPD). Leitura: membro
-- da organização; escrita: só o service_role (o cron).
--
-- Idempotente: `drop constraint if exists`, `if not exists`, `drop policy if exists`.

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'voice_call_missed',
    'case_stale',
    'aviso_de_caso_nao_entregue',
    'followup_sem_agente',
    'canal_mudo_sem_numero',
    'proposal_expired_notice',
    'proposal_acceptance_rate_drop',
    'proposal_promised_not_created',
    'proposta_travada',
    'proposta_pronta_para_revisao',
    'org_reativada',
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    'canal_pausado',
    'cobranca',
    'email_de_login_trocado',
    -- (migration 0655, issue #2529) A tarefa vencida só aparecia em vermelho
    -- para quem ABRIA a lista de tarefas: quem não abria perdia o prazo em
    -- silêncio. O cron `task-reminder` varre `crm_tasks` com prazo na janela e
    -- nasce com estes DOIS kinds — um por momento, e não um genérico: a
    -- Central dá rótulo e destino por kind, e "tarefa perto do vencimento" e
    -- "tarefa venceu sem conclusão" pedem leituras diferentes de quem abre.
    -- Nascem com `ref_kind='task'`, levando à lista de tarefas. Entra NESTA
    -- lista pelas razões de sempre (#159, bloco único por constraint; e a
    -- janela do `midia-nao-lida.test.ts`, que os valores novos têm de manter
    -- dentro dos primeiros 2000 caracteres após o `add constraint`).
    'task_due',
    'task_overdue',
    -- (migration 9021, PM-025 §7) O lead escreveu e nem a IA nem uma pessoa
    -- respondeu em 1 hora de expediente. Um aberto por conversa (índice
    -- abaixo), com `ref_kind='conversation'`; resolve sozinho quando alguém
    -- responde. Fica no fim da lista pelas razões de sempre (#159).
    'ninguem_respondeu',
    'other'
  ));


create unique index if not exists agent_inbox_ninguem_respondeu_aberto_unico
  on public.agent_inbox_items (organization_id, kind, ref_id)
  where status = 'open' and kind = 'ninguem_respondeu';

create table if not exists public.conferencias_de_fim_da_conversa (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  -- A última mensagem do lead quando a pergunta foi feita. Sem FK: a mensagem
  -- pode ser apagada pela anonimização, e o veredito sem texto não precisa dela.
  message_id uuid not null,
  terminou boolean not null,
  -- leitura = o modelo respondeu; sem_modelo = não há modelo nem chave (avisa);
  -- teto = o teto de gasto da IA parou (avisa); falhou = a chamada deu erro (avisa).
  origem text not null default 'leitura',
  modelo text,
  created_at timestamptz not null default now(),
  constraint conferencias_de_fim_da_conversa_unica unique (organization_id, conversation_id, message_id)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'conferencias_de_fim_da_conversa_origem_check') then
    alter table public.conferencias_de_fim_da_conversa
      add constraint conferencias_de_fim_da_conversa_origem_check
      check (origem in ('leitura', 'sem_modelo', 'teto', 'falhou'));
  end if;
end $$;

create index if not exists conferencias_de_fim_da_conversa_conversa_idx
  on public.conferencias_de_fim_da_conversa (organization_id, conversation_id);

comment on table public.conferencias_de_fim_da_conversa is
  'PM-025 §7 (migration 9021): o veredito da leitura curta "a conversa terminou?" por mensagem do lead, para o aviso Ninguém respondeu não perguntar duas vezes. Sem texto nem nome. Leitura: membro da organização; escrita só pelo service_role.';

alter table public.conferencias_de_fim_da_conversa enable row level security;

drop policy if exists conferencias_de_fim_da_conversa_select on public.conferencias_de_fim_da_conversa;
create policy conferencias_de_fim_da_conversa_select on public.conferencias_de_fim_da_conversa
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

revoke all on table public.conferencias_de_fim_da_conversa from public, anon, authenticated;
grant select on table public.conferencias_de_fim_da_conversa to authenticated;
grant all on table public.conferencias_de_fim_da_conversa to service_role;
