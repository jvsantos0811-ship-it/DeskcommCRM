import { instanteDe } from "@/lib/agenda/fuso";

/**
 * Um período de DIAS INTEIROS no fuso da organização, como instantes.
 *
 * "De 01/11 até 07/11" quer dizer de 01/11 00:00 até 07/11 23:59:59 NO RELÓGIO
 * DO ESCRITÓRIO — não em UTC, nem no fuso do servidor. Em São Paulo isso é de
 * 01/11 03:00Z até 08/11 03:00Z (exclusivo). A conta de "meia-noite local" é a
 * da Agenda (`instanteDe`), que já trata a virada de horário de verão.
 *
 * Usado pela planilha do funil (PC-024) e pelo seletor de datas do painel de
 * Dados (PC-025): o mesmo dia tem de cair do mesmo lado nas duas telas.
 */

const DIA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` válido no calendário (31/02 não passa). */
export function diaValido(dia: string | null | undefined): dia is string {
  const m = DIA.exec(dia ?? "");
  if (!m) return false;
  const [ano, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const data = new Date(Date.UTC(ano, mes - 1, d));
  return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === d;
}

function partes(dia: string): { ano: number; mes: number; dia: number } {
  const m = DIA.exec(dia)!;
  return { ano: Number(m[1]), mes: Number(m[2]), dia: Number(m[3]) };
}

/** 00:00 daquele dia no fuso. */
export function inicioDoDiaNoFuso(dia: string, fuso: string): Date {
  return instanteDe(partes(dia), fuso);
}

/** O dia seguinte, em `YYYY-MM-DD` (calendário puro, sem fuso). */
export function diaSeguinte(dia: string): string {
  const p = partes(dia);
  const d = new Date(Date.UTC(p.ano, p.mes - 1, p.dia + 1));
  return d.toISOString().slice(0, 10);
}

/**
 * `[inicio, fimExclusivo)` de `de` até `ate`, inclusive os dois dias.
 * Lado ausente fica aberto (`null`).
 */
export function periodoNoFuso(
  de: string | null | undefined,
  ate: string | null | undefined,
  fuso: string,
): { inicio: Date | null; fimExclusivo: Date | null } {
  return {
    inicio: diaValido(de) ? inicioDoDiaNoFuso(de, fuso) : null,
    fimExclusivo: diaValido(ate) ? inicioDoDiaNoFuso(diaSeguinte(ate), fuso) : null,
  };
}
