/**
 * Dados — o construtor de painéis (migration 9004). Forma dos widgets e o
 * cálculo das séries, sem I/O.
 *
 * Um painel é uma lista de widgets. Cada widget escolhe UMA métrica de um
 * catálogo FECHADO (nada de SQL livre: o usuário escolhe o que medir, o
 * servidor decide como medir, sempre pelo client de RLS de quem pergunta), um
 * jeito de agrupar, um visual, filtros e, se quiser, uma meta.
 */
import { z } from "zod";

export const METRICAS = [
  "leads_criados",
  "negocios_ganhos",
  "valor_ganho",
  "negocios_perdidos",
  "valor_perdido",
  "taxa_de_conversao",
  "ticket_medio",
  "negocios_abertos",
  "valor_em_aberto",
  "conversas_iniciadas",
] as const;
export type Metrica = (typeof METRICAS)[number];

export const AGRUPAMENTOS = ["nenhum", "dia", "semana", "mes", "etapa", "funil", "dono", "origem", "motivo"] as const;
export type Agrupamento = (typeof AGRUPAMENTOS)[number];

export const VISUAIS = ["numero", "linha", "barras", "pizza"] as const;
export type Visual = (typeof VISUAIS)[number];

export const PERIODOS = [7, 30, 90, 180, 365] as const;

/** Rótulo de cada métrica e se ela é dinheiro, contagem ou percentual. */
export const SOBRE_A_METRICA: Record<Metrica, { rotulo: string; tipo: "contagem" | "dinheiro" | "percentual" }> = {
  leads_criados: { rotulo: "Negócios criados", tipo: "contagem" },
  negocios_ganhos: { rotulo: "Negócios ganhos", tipo: "contagem" },
  valor_ganho: { rotulo: "Valor ganho", tipo: "dinheiro" },
  negocios_perdidos: { rotulo: "Negócios perdidos", tipo: "contagem" },
  valor_perdido: { rotulo: "Valor perdido", tipo: "dinheiro" },
  taxa_de_conversao: { rotulo: "Taxa de conversão", tipo: "percentual" },
  ticket_medio: { rotulo: "Ticket médio", tipo: "dinheiro" },
  negocios_abertos: { rotulo: "Negócios em aberto", tipo: "contagem" },
  valor_em_aberto: { rotulo: "Valor em aberto", tipo: "dinheiro" },
  conversas_iniciadas: { rotulo: "Conversas iniciadas", tipo: "contagem" },
};

/** Agrupamentos que cada métrica aceita: conversa não tem etapa nem motivo de perda. */
export function agrupamentosDa(metrica: Metrica): readonly Agrupamento[] {
  if (metrica === "conversas_iniciadas") return ["nenhum", "dia", "semana", "mes", "dono"];
  if (metrica === "negocios_abertos" || metrica === "valor_em_aberto") {
    return ["nenhum", "etapa", "funil", "dono", "origem"];
  }
  if (metrica === "negocios_perdidos" || metrica === "valor_perdido") return AGRUPAMENTOS;
  return AGRUPAMENTOS.filter((a) => a !== "motivo");
}

export const widgetSchema = z
  .object({
    id: z.string().min(1).max(40),
    titulo: z.string().trim().min(1).max(80),
    metrica: z.enum(METRICAS),
    agrupar_por: z.enum(AGRUPAMENTOS),
    visual: z.enum(VISUAIS),
    periodo_dias: z
      .number()
      .int()
      .refine((v) => (PERIODOS as readonly number[]).includes(v), { message: "periodo_invalido" }),
    pipeline_id: z.string().uuid().nullable().optional(),
    owner_user_id: z.string().uuid().nullable().optional(),
    /** Meta no mesmo tipo da métrica: centavos, contagem ou percentual (0–100). */
    meta: z.number().nonnegative().max(1e13).nullable().optional(),
  })
  .strict()
  .refine((w) => agrupamentosDa(w.metrica).includes(w.agrupar_por), { message: "agrupamento_invalido" })
  .refine((w) => (w.visual === "numero") === (w.agrupar_por === "nenhum"), { message: "visual_invalido" });
export type Widget = z.infer<typeof widgetSchema>;

export const MAX_WIDGETS = 24;

export const painelSchema = z
  .object({
    nome: z.string().trim().min(1).max(80),
    descricao: z.string().trim().max(300).nullable().optional(),
    widgets: z.array(widgetSchema).max(MAX_WIDGETS),
  })
  .strict()
  .refine((p) => new Set(p.widgets.map((w) => w.id)).size === p.widgets.length, { message: "widget_repetido" });
export type PainelInput = z.infer<typeof painelSchema>;

export const COLUNAS_DO_PAINEL = "id, organization_id, nome, descricao, widgets, created_at, updated_at";

export interface Painel extends PainelInput {
  id: string;
  organization_id: string;
  created_at: string;
  updated_at: string;
}

// ─── O cálculo ──────────────────────────────────────────────────────────────

/** O que o servidor lê de `crm_leads` (já filtrado pela RLS e pelos filtros). */
export interface LinhaDeNegocio {
  status: "open" | "won" | "lost";
  value_cents: number | null;
  created_at: string;
  closed_at: string | null;
  stage: string | null;
  funil: string | null;
  dono: string | null;
  origem: string | null;
  motivo: string | null;
}

export interface LinhaDeConversa {
  created_at: string;
  dono: string | null;
}

export interface Ponto {
  rotulo: string;
  valor: number;
}

export interface Resultado {
  total: number;
  serie: Ponto[];
  tipo: "contagem" | "dinheiro" | "percentual";
}

const SEM = "—";

function chaveDeTempo(iso: string, agrupar: "dia" | "semana" | "mes", fuso: string): string {
  const d = new Date(iso);
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const dia = `${partes.year}-${partes.month}-${partes.day}`;
  if (agrupar === "dia") return dia;
  if (agrupar === "mes") return `${partes.year}-${partes.month}`;
  // Semana começando na segunda-feira, no fuso da organização.
  const local = new Date(`${dia}T00:00:00Z`);
  const dow = (local.getUTCDay() + 6) % 7;
  local.setUTCDate(local.getUTCDate() - dow);
  return local.toISOString().slice(0, 10);
}

/** Qual data decide em que dia o negócio "conta" para a métrica. */
function dataDaMetrica(m: Metrica, n: LinhaDeNegocio): string | null {
  if (m === "leads_criados") return n.created_at;
  return n.closed_at;
}

function pertence(m: Metrica, n: LinhaDeNegocio): boolean {
  switch (m) {
    case "leads_criados":
      return true;
    case "negocios_ganhos":
    case "valor_ganho":
    case "ticket_medio":
      return n.status === "won";
    case "negocios_perdidos":
    case "valor_perdido":
      return n.status === "lost";
    case "taxa_de_conversao":
      return n.status === "won" || n.status === "lost";
    case "negocios_abertos":
    case "valor_em_aberto":
      return n.status === "open";
    default:
      return false;
  }
}

function chaveDoGrupo(a: Agrupamento, m: Metrica, n: LinhaDeNegocio, fuso: string): string {
  switch (a) {
    case "dia":
    case "semana":
    case "mes": {
      const quando = dataDaMetrica(m, n);
      return quando ? chaveDeTempo(quando, a, fuso) : SEM;
    }
    case "etapa":
      return n.stage ?? SEM;
    case "funil":
      return n.funil ?? SEM;
    case "dono":
      return n.dono ?? SEM;
    case "origem":
      return n.origem ?? SEM;
    case "motivo":
      return n.motivo?.trim() || SEM;
    default:
      return "total";
  }
}

/** O valor de um grupo de negócios, para a métrica. */
function reduzir(m: Metrica, grupo: LinhaDeNegocio[]): number {
  const soma = (xs: LinhaDeNegocio[]) => xs.reduce((s, n) => s + (n.value_cents ?? 0), 0);
  switch (m) {
    case "valor_ganho":
    case "valor_perdido":
    case "valor_em_aberto":
      return soma(grupo);
    case "ticket_medio":
      return grupo.length ? Math.round(soma(grupo) / grupo.length) : 0;
    case "taxa_de_conversao": {
      const ganhos = grupo.filter((n) => n.status === "won").length;
      return grupo.length ? Math.round((ganhos / grupo.length) * 1000) / 10 : 0;
    }
    default:
      return grupo.length;
  }
}

function ordenar(a: Agrupamento, pontos: Ponto[]): Ponto[] {
  if (a === "dia" || a === "semana" || a === "mes") return pontos.sort((x, y) => x.rotulo.localeCompare(y.rotulo));
  return pontos.sort((x, y) => y.valor - x.valor || x.rotulo.localeCompare(y.rotulo));
}

export function calcularNegocios(w: Pick<Widget, "metrica" | "agrupar_por">, linhas: LinhaDeNegocio[], fuso: string): Resultado {
  const tipo = SOBRE_A_METRICA[w.metrica].tipo;
  const dentro = linhas.filter((n) => pertence(w.metrica, n));
  const total = reduzir(w.metrica, dentro);
  if (w.agrupar_por === "nenhum") return { total, serie: [], tipo };
  const grupos = new Map<string, LinhaDeNegocio[]>();
  for (const n of dentro) {
    const k = chaveDoGrupo(w.agrupar_por, w.metrica, n, fuso);
    grupos.set(k, [...(grupos.get(k) ?? []), n]);
  }
  const serie = ordenar(
    w.agrupar_por,
    [...grupos.entries()].map(([rotulo, g]) => ({ rotulo, valor: reduzir(w.metrica, g) })),
  );
  return { total, serie, tipo };
}

export function calcularConversas(w: Pick<Widget, "agrupar_por">, linhas: LinhaDeConversa[], fuso: string): Resultado {
  const total = linhas.length;
  if (w.agrupar_por === "nenhum") return { total, serie: [], tipo: "contagem" };
  const grupos = new Map<string, number>();
  for (const c of linhas) {
    const k =
      w.agrupar_por === "dono"
        ? (c.dono ?? SEM)
        : chaveDeTempo(c.created_at, w.agrupar_por as "dia" | "semana" | "mes", fuso);
    grupos.set(k, (grupos.get(k) ?? 0) + 1);
  }
  return {
    total,
    serie: ordenar(w.agrupar_por, [...grupos.entries()].map(([rotulo, valor]) => ({ rotulo, valor }))),
    tipo: "contagem",
  };
}

/** Painel modelo para quem abre Dados pela primeira vez. */
export function painelModelo(): PainelInput {
  return {
    nome: "Painel comercial",
    descricao: "Um ponto de partida: edite, remova ou acrescente gráficos.",
    widgets: [
      { id: "w1", titulo: "Negócios ganhos", metrica: "negocios_ganhos", agrupar_por: "nenhum", visual: "numero", periodo_dias: 30, meta: null },
      { id: "w2", titulo: "Valor ganho", metrica: "valor_ganho", agrupar_por: "nenhum", visual: "numero", periodo_dias: 30, meta: null },
      { id: "w3", titulo: "Taxa de conversão", metrica: "taxa_de_conversao", agrupar_por: "nenhum", visual: "numero", periodo_dias: 30, meta: null },
      { id: "w4", titulo: "Negócios criados por dia", metrica: "leads_criados", agrupar_por: "dia", visual: "linha", periodo_dias: 30, meta: null },
      { id: "w5", titulo: "Em aberto por etapa", metrica: "negocios_abertos", agrupar_por: "etapa", visual: "barras", periodo_dias: 30, meta: null },
      { id: "w6", titulo: "Motivos de perda", metrica: "negocios_perdidos", agrupar_por: "motivo", visual: "pizza", periodo_dias: 90, meta: null },
    ],
  };
}
