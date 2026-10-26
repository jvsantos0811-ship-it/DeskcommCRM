-- manifest: **Etapa "só atendimento humano" no agent-engine.** A coluna `crm_stages.requires_human` existia e só o worker legado a lia (morto desde a v1.17.0). Agora o motor de agentes a lê no começo do turno e passa a conversa para uma pessoa, gravando a passagem com a origem nova `etapa_do_funil`. Esta migration só amplia o CHECK de `passagens_de_atendimento.origem`; a coluna da etapa já existe. Faixa do fork (9005). Idempotente; apêndice igual no `baseline.sql`.
-- 9005: etapa que exige humano, lida pelo motor de agentes.
--
-- Por que uma origem nova, e não `legado_etapa`: as origens `legado_*` são os
-- caminhos do motor B (worker legado). Gravar `legado_etapa` para o motor novo
-- faria a pergunta "que parte do sistema decidiu isto?" ter resposta errada.
alter table public.passagens_de_atendimento
  drop constraint if exists passagens_de_atendimento_origem_check;
alter table public.passagens_de_atendimento
  add constraint passagens_de_atendimento_origem_check
  check (origem in (
    'pedido_explicito','opt_out_provavel','ferramenta_do_modelo',
    'teto_de_gasto','caso_escalado','sentimento','legado_pedido',
    'legado_juridico','legado_etapa','legado_confianca','legado_teto',
    'mcp_externo','runtime_nativo','etapa_do_funil'));
