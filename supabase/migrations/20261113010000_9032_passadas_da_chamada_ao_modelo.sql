-- manifest: **O que cada passada de uma resposta da IA consumiu (PC-035, medição).** Coluna nova `llm_calls.passadas` (jsonb, nula): uma lista com, por passada do laço de ferramentas, os tokens de entrada, os lidos e os gravados no cache (com a divisão entre o cache de 5 minutos e o de 1 hora quando o provedor informa), os de saída, os NOMES das ferramentas pedidas e quantos caracteres o modelo escreveu fora de ferramenta. Só números e nomes: nenhum texto de mensagem, argumento ou resultado. `llm_calls` guardava só a soma da chamada, e é o número de passadas que multiplica o custo de uma resposta; sem o detalhe, a medição de antes e depois era estimativa. Só as chamadas com laço gravam; as demais ficam nulas. O esquema mora em `lib/ai/usage/passadas.ts`. Nenhum dado migrado. Número 9032, faixa do fork. Idempotente; apêndice igual no `baseline.sql`, antes da VARREDURA anon.
-- 9032: llm_calls.passadas.

alter table public.llm_calls add column if not exists passadas jsonb;

comment on column public.llm_calls.passadas is
  'Migration 9032 (PC-035): o consumo de cada passada do laço de ferramentas desta chamada — lista de {n, entrada, cache_lido, cache_gravado, cache_gravado_5m, cache_gravado_1h, saida, ferramentas[], texto_descartado_chars}. Só números e nomes de ferramenta, nunca conteúdo. Nula nas chamadas sem laço. Esquema e leitura: lib/ai/usage/passadas.ts.';
