import { z } from "zod";

import { INTERVALOS } from "@/lib/cobranca/vocabulario";

/**
 * O plano de cobrança da instalação (`cobranca_planos`, spec da cobrança §2.2).
 * São os mesmos limites dos CHECKs da tabela, para a recusa sair com nome antes
 * do banco. A régua é a mesma na rota e no formulário de /admin/cobranca.
 * `moeda` não entra: é BRL, fixada pelo default e pelo CHECK.
 */
const INT4_MAX = 2_147_483_647;
const campos = {
  nome: z.string().trim().min(1).max(60),
  preco_cents: z.number().int().min(500, "O preço mínimo é R$ 5,00: abaixo disso o boleto não sai."),
  intervalo: z.enum(INTERVALOS),
  trial_dias: z.number().int().min(0).max(90),
  max_assentos: z.number().int().min(1).max(INT4_MAX).nullable(),
  max_canais: z.number().int().min(1).max(INT4_MAX).nullable(),
  teto_ia_usd_cents: z.number().int().min(100).max(INT4_MAX).nullable(),
  padrao_no_cadastro: z.boolean(),
  oferecido_ao_cliente: z.boolean(),
  /** PC-051: a empresa neste plano pode comprar crédito de IA. */
  oferece_credito_ia: z.boolean(),
};

export const novoPlanoSchema = z.strictObject({
  nome: campos.nome,
  preco_cents: campos.preco_cents,
  intervalo: campos.intervalo,
  trial_dias: campos.trial_dias,
  max_assentos: campos.max_assentos.optional(),
  max_canais: campos.max_canais.optional(),
  teto_ia_usd_cents: campos.teto_ia_usd_cents.optional(),
  padrao_no_cadastro: campos.padrao_no_cadastro.optional(),
  oferecido_ao_cliente: campos.oferecido_ao_cliente.optional(),
  oferece_credito_ia: campos.oferece_credito_ia.optional(),
});

export const edicaoDoPlanoSchema = z
  .strictObject({ ...campos, arquivado: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nada para mudar.");

export const COLUNAS_DO_PLANO =
  "id, nome, preco_cents, moeda, intervalo, trial_dias, max_assentos, max_canais, teto_ia_usd_cents, padrao_no_cadastro, oferecido_ao_cliente, oferece_credito_ia, arquivado_em, created_at, updated_at";

/**
 * PC-051: pacote de crédito de IA da instalação (`cobranca_pacotes_credito_ia`).
 * Preço em centavos de REAL (piso de boleto, R$ 5,00) e quanto de IA libera em
 * centavos de DÓLAR (a régua de `llm_calls.cost_cents`; piso US$ 1,00).
 */
const camposDoPacote = {
  nome: z.string().trim().min(1).max(60),
  preco_cents: z.number().int().min(500, "O preço mínimo é R$ 5,00: abaixo disso o boleto não sai.").max(100_000_000),
  ia_usd_cents: z.number().int().min(100, "O pacote libera no mínimo US$ 1,00 de IA.").max(INT4_MAX),
};

export const novoPacoteDeCreditoSchema = z.strictObject(camposDoPacote);

export const edicaoDoPacoteDeCreditoSchema = z
  .strictObject({ ...camposDoPacote, arquivado: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nada para mudar.");

export const cortesiaDeCreditoSchema = z.strictObject({
  organization_id: z.string().uuid(),
  ia_usd_cents: z.number().int().min(100).max(INT4_MAX),
  motivo: z.string().trim().min(3).max(300),
});
