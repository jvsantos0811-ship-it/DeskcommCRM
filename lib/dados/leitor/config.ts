/**
 * A CONFIGURAÇÃO DO LEITOR DA CONVERSA — `organizations.settings.leitor`, a mesma
 * chave do alcance (`lib/dados/alcance-do-leitor.ts`), que guarda os dois sem um
 * apagar o outro (merge não destrutivo nas rotas).
 *
 * O Leitor só roda quando está LIGADO e tem MODELO APROVADO (PM-027 §8: "sem
 * modelo escolhido, o Leitor não roda"; "só liga com 100% nos casos que
 * bloqueiam").
 *
 * A ESCOLHA DA ORGANIZAÇÃO (decisão do dono, 06/11: o Leitor liga sozinho em
 * toda empresa, nas atuais e nas novas) é uma de quatro, e é ela que distingue o
 * "nunca mexeu" do "desligou de propósito":
 *   - `padrao`    — segue o modelo padrão da INSTALAÇÃO (`padrao.ts`), escolhido
 *                   pelo dono da plataforma entre os aprovados na bateria. É o
 *                   valor de quem nunca mexeu. Sem padrão gravado, não lê.
 *   - `propria`   — o admin da empresa escolheu outro modelo aprovado no cartão.
 *   - `desligado` — o admin desligou; o padrão NUNCA o religa sozinho.
 *   - `claude`    — PC-036: quem lê é uma tarefa agendada do Claude, de fora, pela
 *                   porta Ficha da agência (`lib/mcp/agencia/ferramentas-da-ficha.ts`).
 *                   O cron do Leitor NUNCA chama modelo nesta organização: a
 *                   configuração efetiva sai DESLIGADA para ele, e só
 *                   `leitorPeloClaude` sabe do marco. Só o dono da instalação
 *                   escolhe (é ele quem tem a chave da porta Ficha).
 * Quem lê a configuração para RODAR usa `configEfetivaDoLeitor`, nunca o
 * `configDoLeitor` cru: só a efetiva sabe do padrão da instalação.
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

export const ESCOLHAS_DO_LEITOR = ["padrao", "propria", "desligado", "claude"] as const;
export type EscolhaDoLeitor = (typeof ESCOLHAS_DO_LEITOR)[number];

export const configDoLeitorSchema = z.object({
  /** `null` = nunca mexeu (ver `escolhaDaOrg`). */
  escolha: z.enum(ESCOLHAS_DO_LEITOR).nullable().default(null),
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
  escolha: null,
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
    escolha: b.escolha ?? null,
    ligado: b.ligado,
    ligado_em: b.ligado_em,
    modelo: b.modelo,
    reserva: b.reserva,
    prefixos_de_anuncio: b.prefixos_de_anuncio,
    termo_do_contrato: b.termo_do_contrato,
  });
  return r.success ? r.data : CONFIG_PADRAO;
}

// ─── o padrão da instalação e a configuração efetiva ───────────────────────

const padraoSchema = z.object({
  modelo: modeloSchema,
  reserva: modeloSchema.nullable().default(null),
  /** Desde quando o padrão vale: o marco de quem o segue (nada antes é lido). */
  ativo_desde: z.string().datetime({ offset: true }),
  definido_em: z.string().datetime({ offset: true }),
});
export type PadraoDoLeitor = z.infer<typeof padraoSchema>;

/** O valor guardado em `platform_config` (JSON). Inválido ou ausente = sem padrão. */
export function lerValorDoPadrao(valor: string | null): PadraoDoLeitor | null {
  if (!valor) return null;
  try {
    const r = padraoSchema.safeParse(JSON.parse(valor));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * A escolha da organização. Sem escolha gravada (quem nunca mexeu, ou quem
 * mexeu antes de existir o padrão da instalação): ligado com modelo é escolha
 * própria — era o único jeito de ligar —, o resto segue o padrão.
 */
export function escolhaDaOrg(c: ConfigDoLeitor): EscolhaDoLeitor {
  if (c.escolha) return c.escolha;
  return c.ligado && c.modelo ? "propria" : "padrao";
}

export type ConfigEfetivaDoLeitor = ConfigDoLeitor & {
  /** De onde vem o que vale agora. */
  origem: EscolhaDoLeitor;
};

function maisTarde(datas: Array<string | null | undefined>): string | null {
  let maior: string | null = null;
  for (const d of datas) {
    if (!d || Number.isNaN(Date.parse(d))) continue;
    if (maior === null || Date.parse(d) > Date.parse(maior)) maior = d;
  }
  return maior === null ? null : new Date(maior).toISOString();
}

/**
 * O que vale AGORA nesta organização: a escolha dela, com o padrão da instalação
 * no lugar quando ela o segue. Quem segue o padrão está ligado desde o mais
 * tarde entre: o padrão passar a valer, a organização nascer e o admin ter
 * voltado ao padrão (sem carga inicial, §3). Sem padrão gravado, desligado.
 */
export function configEfetivaDoLeitor(
  c: ConfigDoLeitor,
  orgCriadaEm: string | null,
  padrao: PadraoDoLeitor | null,
): ConfigEfetivaDoLeitor {
  const origem = escolhaDaOrg(c);
  if (origem === "propria") return { ...c, origem };
  // Pelo Claude: desligado para o cron (zero chamada de modelo pelo CRM); o marco
  // fica, porque é dele que a seleção da porta Ficha parte (sem carga inicial).
  if (origem === "claude") return { ...c, origem, ligado: false, modelo: null, reserva: null };
  // Desligado guarda o último modelo próprio (o cartão o oferece de novo); sem padrão, não há modelo.
  if (origem === "desligado") return { ...c, origem, ligado: false, ligado_em: null };
  if (!padrao) return { ...c, origem, ligado: false, ligado_em: null, modelo: null, reserva: null };
  return {
    ...c,
    origem,
    ligado: true,
    ligado_em: maisTarde([padrao.ativo_desde, orgCriadaEm, c.escolha === "padrao" ? c.ligado_em : null]),
    modelo: padrao.modelo,
    reserva: padrao.reserva,
  };
}

/** O Leitor desta organização pode rodar agora? Devolve o marco e o modelo, ou por que não. */
export function leitorPodeRodar(
  c: ConfigDoLeitor,
): { pode: true; ligadoEm: Date; modelo: ModeloDoLeitor } | { pode: false; porque: "desligado" | "sem_modelo" } {
  if (!c.ligado || !c.ligado_em) return { pode: false, porque: "desligado" };
  if (!c.modelo) return { pode: false, porque: "sem_modelo" };
  return { pode: true, ligadoEm: new Date(c.ligado_em), modelo: c.modelo };
}

/**
 * PC-036: esta organização é lida pelo Claude? Devolve o marco (nada antes dele
 * é lido — sem carga inicial, como no Leitor do CRM) ou `null`.
 */
export function leitorPeloClaude(c: Pick<ConfigEfetivaDoLeitor, "origem" | "ligado_em">): { ligadoEm: Date } | null {
  if (c.origem !== "claude" || !c.ligado_em || Number.isNaN(Date.parse(c.ligado_em))) return null;
  return { ligadoEm: new Date(c.ligado_em) };
}
