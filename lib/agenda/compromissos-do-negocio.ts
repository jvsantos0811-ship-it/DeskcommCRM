/**
 * OS COMPROMISSOS NO POP-UP DO NEGÓCIO (PC-027) — as regras puras da tela.
 *
 * O pop-up do negócio não tem agenda própria: ele chama o MESMO serviço da
 * Agenda (`/api/v1/agenda/agendamentos` e `/horarios-livres`, pelos mesmos
 * hooks) e só decide o que mostrar e que ação oferecer em cada compromisso. As
 * regras ficam aqui para serem medidas sem tela.
 */
import { instanteDe, partesNoFuso } from "@/lib/agenda/fuso";

export type SituacaoNoNegocio = "pending" | "confirmed" | "completed" | "no_show" | "cancelled";

export interface CompromissoListado {
  id: string;
  revision?: number;
  titulo: string;
  iniciaEm: string;
  terminaEm: string;
  situacao: string;
  donoId: string | null;
  tipo?: { slug: string; nome: string } | null;
  origem?: string;
}

/** Próximos (do mais perto ao mais longe) e o último que já passou. */
export function separarCompromissos(
  lista: readonly CompromissoListado[],
  agora: Date,
): { proximos: CompromissoListado[]; ultimo: CompromissoListado | null } {
  const nossos = lista.filter((c) => c.origem !== "google_sync");
  const t = agora.getTime();
  const proximos = nossos
    .filter((c) => Date.parse(c.terminaEm) > t && c.situacao !== "cancelled")
    .sort((a, b) => a.iniciaEm.localeCompare(b.iniciaEm));
  const passados = nossos
    .filter((c) => !proximos.includes(c))
    .sort((a, b) => b.iniciaEm.localeCompare(a.iniciaEm));
  return { proximos, ultimo: passados[0] ?? null };
}

export type AcaoNoCompromisso = "confirmar" | "compareceu" | "faltou" | "remarcar" | "desmarcar";

/**
 * As ações de cada compromisso — as MESMAS regras da Agenda: confirmar só o
 * marcado; comparecimento e falta só depois que começou; remarcar e desmarcar
 * só o que ainda não aconteceu e não foi desmarcado.
 */
export function acoesDoCompromisso(c: CompromissoListado, agora: Date): AcaoNoCompromisso[] {
  const s = c.situacao as SituacaoNoNegocio;
  if (s === "cancelled" || s === "completed" || s === "no_show") return [];
  const comecou = Date.parse(c.iniciaEm) <= agora.getTime();
  const acoes: AcaoNoCompromisso[] = [];
  if (s === "pending" && !comecou) acoes.push("confirmar");
  if (comecou) acoes.push("compareceu", "faltou");
  if (!comecou) acoes.push("remarcar", "desmarcar");
  return acoes;
}

/** `AAAA-MM-DD` de hoje no fuso. */
export function hojeNoFuso(agora: Date, fuso: string): string {
  const p = partesNoFuso(agora, fuso);
  return `${p.ano}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

/** A janela de busca de horários: do começo do dia escolhido até `dias` depois, no fuso. */
export function janelaDeHorarios(dia: string, fuso: string, dias = 7): { de: string; ate: string } {
  const [ano, mes, d] = dia.split("-").map(Number) as [number, number, number];
  // O dia final pelo calendário (sem fuso), para o dia 35 virar o 4 do mês seguinte.
  const depois = new Date(Date.UTC(ano, mes - 1, d + dias));
  const inicio = instanteDe({ ano, mes, dia: d }, fuso);
  const fim = instanteDe(
    { ano: depois.getUTCFullYear(), mes: depois.getUTCMonth() + 1, dia: depois.getUTCDate() },
    fuso,
  );
  return { de: inicio.toISOString(), ate: fim.toISOString() };
}

/** Os horários do dia escolhido; sem nenhum, os próximos livres da janela (até `max`). */
export function horariosParaOferecer(
  slots: ReadonlyArray<{ inicio: string; fim: string }>,
  dia: string,
  fuso: string,
  max = 8,
): { doDia: string[]; proximos: string[] } {
  const doDia: string[] = [];
  const proximos: string[] = [];
  for (const s of slots) {
    if (hojeNoFuso(new Date(s.inicio), fuso) === dia) doDia.push(s.inicio);
    else if (proximos.length < max) proximos.push(s.inicio);
  }
  return { doDia, proximos: doDia.length > 0 ? [] : proximos };
}
