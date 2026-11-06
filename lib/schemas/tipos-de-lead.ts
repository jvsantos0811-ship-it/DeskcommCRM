import { z } from "zod";

/**
 * O CONTRATO DA TELA "VALOR POR TIPO DE LEAD" (v3, seção 1.1) — lido pela tela
 * E pela rota (`/api/v1/tipos-de-lead`).
 *
 * Um tipo de lead é uma linha de `catalog_products` com `tipo_de_lead = true`.
 * O `codigo` (obrigatório no catálogo) é gerado pela rota a partir do nome: quem
 * cadastra "Auxílio-acidente" não pensa em SKU.
 */
export const tipoDeLeadCreateSchema = z.object({
  nome: z.string().trim().min(2, "o nome precisa de ao menos 2 letras").max(120),
  categoria: z.string().trim().max(80).optional(),
  preco_cents: z.number().int().min(0, "o valor não pode ser negativo"),
  valor_confirmado: z.boolean().default(false),
});

export const tipoDeLeadPatchSchema = z
  .object({
    nome: tipoDeLeadCreateSchema.shape.nome,
    categoria: z.string().trim().max(80).nullable(),
    preco_cents: tipoDeLeadCreateSchema.shape.preco_cents,
    valor_confirmado: z.boolean(),
    ativo: z.boolean(),
    /**
     * O checklist de requisitos mínimos do tipo (Regra v2 §2.2, migration 9022):
     * o Leitor da conversa confere cada item na conversa. Vazio = sem checklist.
     */
    requisitos: z.array(z.string().trim().min(1).max(160)).max(12),
  })
  .partial();

export type TipoDeLeadCreate = z.infer<typeof tipoDeLeadCreateSchema>;
export type TipoDeLeadPatch = z.infer<typeof tipoDeLeadPatchSchema>;

export interface TipoDeLeadNaTela {
  id: string;
  nome: string;
  categoria: string | null;
  preco_cents: number;
  moeda: string;
  valor_confirmado: boolean;
  ativo: boolean;
  requisitos: string[];
}

export const COLUNAS_DO_TIPO_DE_LEAD = "id, nome, categoria, preco_cents, moeda, valor_confirmado, ativo, requisitos";

/** O código interno do item no catálogo: `tl-` + o nome sem acento, em minúsculas. */
export function codigoDoTipoDeLead(nome: string): string {
  const slug = nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `tl-${slug || "tipo"}`;
}
