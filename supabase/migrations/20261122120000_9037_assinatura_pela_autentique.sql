-- manifest: **Assinatura eletrônica pela Autentique (PC-046).** O vocabulário do serviço de assinatura cresce com `autentique` nos dois CHECKs (`assinatura_eletronica_contas.provedor` e `crm_contracts.provedor_assinatura`; o conjunto antigo é subconjunto do novo, então nenhuma linha fica de fora). `assinatura_eletronica_contas` ganha `aviso_hmac_encrypted/_iv/_tag`: o segredo do endpoint que a Autentique gera quando o aviso é cadastrado no PAINEL dela (não há rota da API para isso), cifrado em AES-GCM como a chave, porque o HMAC do aviso é conferido com ele (hash não serve). Número 9037, faixa do fork. Idempotente; apêndice igual no `baseline.sql`.
-- 9037: assinatura eletrônica pela Autentique (PC-046).
--
-- Nenhum gatilho, nenhuma função: só vocabulário e três colunas anuláveis.
-- Desligado de fábrica: nada muda para quem não escolher a Autentique em
-- Configurações › Assinatura eletrônica.

alter table public.assinatura_eletronica_contas drop constraint if exists assinatura_eletronica_contas_provedor_check;
alter table public.assinatura_eletronica_contas
  add constraint assinatura_eletronica_contas_provedor_check
  check (provedor = any (array['zapsign', 'autentique']::text[]));

alter table public.crm_contracts drop constraint if exists crm_contracts_provedor_assinatura_check;
alter table public.crm_contracts
  add constraint crm_contracts_provedor_assinatura_check
  check (provedor_assinatura = any (array['manual', 'zapsign', 'autentique']::text[]));

alter table public.assinatura_eletronica_contas add column if not exists aviso_hmac_encrypted bytea;
alter table public.assinatura_eletronica_contas add column if not exists aviso_hmac_iv bytea;
alter table public.assinatura_eletronica_contas add column if not exists aviso_hmac_tag bytea;

comment on column public.assinatura_eletronica_contas.aviso_hmac_encrypted is
  'PC-046 (migration 9037): o segredo do endpoint do aviso gerado pelo serviço no painel dele (Autentique), cifrado em AES-GCM com a chave da instalação. Confere o HMAC SHA-256 do aviso. NULL = ainda não colado (ou serviço que cadastra o aviso pela API).';
