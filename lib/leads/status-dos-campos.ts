/**
 * O STATUS DE CADA CAMPO DE QUALIFICAÇÃO (PC-003, item 2).
 *
 * Um campo marcado `com_status` no funil guarda o dado em
 * `crm_leads.custom_fields` e o status da resposta em
 * `crm_leads.status_dos_campos` (migration 9011). O status existe porque o
 * dado sozinho não diz se a pessoa CONFIRMOU ("sim, foi acidente de trabalho"),
 * NEGOU, NÃO SABE ou se contradisse — e é essa diferença que decide se a IA
 * pode avançar o negócio.
 *
 * Para a trava da IA: CONFIRMADO, NEGADO e NAO_SE_APLICA contam como
 * preenchido; NAO_SABE, PENDENTE e CONTRADITORIO (e a ausência) barram.
 */
import { z } from "zod";

export const STATUS_DE_CAMPO = [
  "CONFIRMADO",
  "NEGADO",
  "NAO_SABE",
  "NAO_SE_APLICA",
  "PENDENTE",
  "CONTRADITORIO",
] as const;
export type StatusDeCampo = (typeof STATUS_DE_CAMPO)[number];

/** Os status que RESPONDEM a pergunta — os únicos que liberam a trava. */
export const STATUS_QUE_PREENCHEM: ReadonlySet<StatusDeCampo> = new Set([
  "CONFIRMADO",
  "NEGADO",
  "NAO_SE_APLICA",
]);

export const statusDeCampoSchema = z.enum(STATUS_DE_CAMPO);

/**
 * O mapa `chave do campo → status` que as escritas aceitam. `null` apaga o
 * status de um campo (volta a "sem status"). Chave com o mesmo formato da
 * chave de campo personalizado.
 */
export const statusDosCamposEntradaSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_]*$/i).max(40), statusDeCampoSchema.nullable())
  .refine((m) => Object.keys(m).length <= 50, { message: "no máximo 50 campos" });

/** Lê o mapa do banco de forma tolerante — lixo vira "sem status". */
export function statusDosCampos(raw: unknown): Record<string, StatusDeCampo> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const saida: Record<string, StatusDeCampo> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && (STATUS_DE_CAMPO as readonly string[]).includes(v)) {
      saida[k] = v as StatusDeCampo;
    }
  }
  return saida;
}

/** Junta o mapa atual com a mudança pedida (`null` remove a chave). */
export function mesclaStatusDosCampos(
  atual: unknown,
  mudanca: Record<string, StatusDeCampo | null>,
): Record<string, StatusDeCampo> {
  const saida = { ...statusDosCampos(atual) };
  for (const [k, v] of Object.entries(mudanca)) {
    if (v === null) delete saida[k];
    else saida[k] = v;
  }
  return saida;
}
