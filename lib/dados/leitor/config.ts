/**
 * A CONFIGURAÇÃO DO LEITOR DA CONVERSA — `organizations.settings.leitor`, a mesma
 * chave do alcance (`lib/dados/alcance-do-leitor.ts`), que guarda os dois sem um
 * apagar o outro (merge não destrutivo nas rotas).
 *
 * O Leitor só roda quando está LIGADO e tem MODELO APROVADO (PM-027 §8: "sem
 * modelo escolhido, o Leitor não roda"; "só liga com 100% nos casos que
 * bloqueiam"). Quem liga e aprova é a tela Provedores (com a bateria); até lá a
 * organização nasce desligada.
 *
 * `ligado_em` marca o começo: nada anterior conta (sem carga inicial, §3).
 * O prompt é molde: prefixos das mensagens prontas de anúncio e o termo do
 * segmento para "contrato" são da organização (§4).
 */
import { z } from "zod";

import { CHAVE_DO_ALCANCE } from "@/lib/dados/alcance-do-leitor";

const modeloSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  model_id: z.string().trim().min(1).max(120),
});
export type ModeloDoLeitor = z.infer<typeof modeloSchema>;

export const configDoLeitorSchema = z.object({
  ligado: z.boolean().default(false),
  ligado_em: z.string().datetime({ offset: true }).nullable().default(null),
  /** O modelo que passou na bateria e foi ligado. */
  modelo: modeloSchema.nullable().default(null),
  /** O modelo de reserva (se o provedor do principal falhar), também aprovado na bateria. */
  reserva: modeloSchema.nullable().default(null),
  prefixos_de_anuncio: z.array(z.string().trim().min(1).max(20)).max(20).default([]),
  termo_do_contrato: z.string().trim().min(1).max(40).default("contrato"),
});
export type ConfigDoLeitor = z.infer<typeof configDoLeitorSchema>;

export const CONFIG_PADRAO: ConfigDoLeitor = {
  ligado: false,
  ligado_em: null,
  modelo: null,
  reserva: null,
  prefixos_de_anuncio: [],
  termo_do_contrato: "contrato",
};

/** Lê a configuração do `settings` da organização. Nunca lança: inválida vira desligada. */
export function configDoLeitor(settings: unknown): ConfigDoLeitor {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return CONFIG_PADRAO;
  const bruto = (settings as Record<string, unknown>)[CHAVE_DO_ALCANCE];
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return CONFIG_PADRAO;
  const b = bruto as Record<string, unknown>;
  const r = configDoLeitorSchema.safeParse({
    ligado: b.ligado,
    ligado_em: b.ligado_em,
    modelo: b.modelo,
    reserva: b.reserva,
    prefixos_de_anuncio: b.prefixos_de_anuncio,
    termo_do_contrato: b.termo_do_contrato,
  });
  return r.success ? r.data : CONFIG_PADRAO;
}

/** O Leitor desta organização pode rodar agora? Devolve o marco e o modelo, ou por que não. */
export function leitorPodeRodar(
  c: ConfigDoLeitor,
): { pode: true; ligadoEm: Date; modelo: ModeloDoLeitor } | { pode: false; porque: "desligado" | "sem_modelo" } {
  if (!c.ligado || !c.ligado_em) return { pode: false, porque: "desligado" };
  if (!c.modelo) return { pode: false, porque: "sem_modelo" };
  return { pode: true, ligadoEm: new Date(c.ligado_em), modelo: c.modelo };
}
