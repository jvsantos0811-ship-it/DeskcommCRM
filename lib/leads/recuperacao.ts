/**
 * Recuperação de negócios perdidos — as contas da tela, sem I/O.
 *
 * A tela e a rota olham a MESMA lista: os negócios com `status = 'lost'`
 * encerrados dentro do período. O que aqui se calcula é o resumo que orienta a
 * recuperação: quantos, quanto dinheiro ficou na mesa e por QUÊ — o motivo mais
 * comum é por onde começar a recuperar.
 */

export const PERIODOS_EM_DIAS = [30, 90, 180, 365] as const;
export type PeriodoEmDias = (typeof PERIODOS_EM_DIAS)[number];
export const PERIODO_PADRAO: PeriodoEmDias = 90;
export const LIMITE_DA_LISTA = 500;

export interface NegocioPerdido {
  id: string;
  title: string;
  value_cents: number | null;
  currency: string | null;
  lost_reason: string | null;
  closed_at: string;
  pipeline_id: string;
  pipeline_nome: string | null;
  owner_user_id: string | null;
  contact_id: string | null;
  contato_nome: string | null;
  conversa_id: string | null;
  /** Já existe um negócio novo retomado a partir deste (`retomado_de_lead_id`). */
  retomado: boolean;
}

export interface MotivoResumo {
  motivo: string;
  quantidade: number;
  valor_cents: number;
}

export interface ResumoDaRecuperacao {
  quantidade: number;
  /** Soma por moeda: somar BRL com USD seria um número que não existe. */
  valor_por_moeda: Record<string, number>;
  motivos: MotivoResumo[];
  ainda_nao_retomados: number;
}

export const SEM_MOTIVO = "Sem motivo informado";

export function resumir(negocios: NegocioPerdido[]): ResumoDaRecuperacao {
  const valor: Record<string, number> = {};
  const porMotivo = new Map<string, MotivoResumo>();
  let naoRetomados = 0;
  for (const n of negocios) {
    const moeda = n.currency ?? "BRL";
    valor[moeda] = (valor[moeda] ?? 0) + (n.value_cents ?? 0);
    const motivo = n.lost_reason?.trim() || SEM_MOTIVO;
    const atual = porMotivo.get(motivo) ?? { motivo, quantidade: 0, valor_cents: 0 };
    atual.quantidade += 1;
    atual.valor_cents += n.value_cents ?? 0;
    porMotivo.set(motivo, atual);
    if (!n.retomado) naoRetomados += 1;
  }
  const motivos = [...porMotivo.values()].sort(
    (a, b) => b.quantidade - a.quantidade || b.valor_cents - a.valor_cents || a.motivo.localeCompare(b.motivo),
  );
  return { quantidade: negocios.length, valor_por_moeda: valor, motivos, ainda_nao_retomados: naoRetomados };
}

export function periodoValido(valor: string | null): PeriodoEmDias {
  const n = Number(valor);
  return (PERIODOS_EM_DIAS as readonly number[]).includes(n) ? (n as PeriodoEmDias) : PERIODO_PADRAO;
}

/** Dias inteiros desde o encerramento — "perdido há 12 dias". */
export function diasDesde(iso: string, agora: Date = new Date()): number {
  return Math.max(0, Math.floor((agora.getTime() - new Date(iso).getTime()) / 86_400_000));
}
