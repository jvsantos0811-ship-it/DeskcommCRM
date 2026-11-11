/**
 * O PERÍODO DO PAINEL DE DADOS (PC-025, item 2) — puro, sem banco.
 *
 * ─── O que a pessoa escolhe ──────────────────────────────────────────────────
 *
 * "Tudo" (o padrão: o painel como sempre foi), os atalhos — hoje, 7 dias, 30
 * dias, mês atual, mês passado — ou "Personalizado", com "de" e "até".
 *
 * ─── Datas inclusivas, no fuso da organização ────────────────────────────────
 *
 * "De 01/11 até 07/11" é de 01/11 00:00 até 07/11 23:59:59 NO RELÓGIO DO
 * ESCRITÓRIO. Os atalhos são calculados a partir do "hoje" da organização, não
 * do servidor (que roda em UTC) nem do navegador de quem olha.
 *
 * ─── No endereço da página ───────────────────────────────────────────────────
 *
 * `?periodo=7d` (atalho, relativo: o link de amanhã mostra os 7 dias de
 * amanhã) ou `?periodo=personalizado&de=2026-11-01&ate=2026-11-07` (fixo: o
 * link copiado abre exatamente o mesmo recorte). Sem `periodo` = "Tudo".
 */
import { diaValido } from "@/lib/datas/periodo-no-fuso";
import { somarDias } from "@/lib/dados/retrato";

export const ATALHOS_DO_PERIODO = [
  "hoje",
  "7d",
  "30d",
  "mes",
  "mes_passado",
  "personalizado",
] as const;
export type AtalhoDoPeriodo = (typeof ATALHOS_DO_PERIODO)[number];

/** O que veio do endereço (ou da tela), ainda sem conta. */
export interface PeriodoPedido {
  atalho: AtalhoDoPeriodo;
  de?: string | null;
  ate?: string | null;
}

/** O período resolvido: dias `AAAA-MM-DD` no fuso da organização, os dois inclusivos. */
export interface PeriodoResolvido {
  atalho: AtalhoDoPeriodo;
  de: string;
  ate: string;
}

/** Teto de dias de um período personalizado (um ano e pouco). */
export const DIAS_NO_MAXIMO = 400;

/** Lê o período do endereço. Nulo = "Tudo" (ou um pedido que não faz sentido). */
export function periodoDosParametros(p: {
  get(nome: string): string | null;
}): PeriodoPedido | null {
  const atalho = p.get("periodo");
  if (!atalho || !(ATALHOS_DO_PERIODO as readonly string[]).includes(atalho)) return null;
  if (atalho === "personalizado") {
    const de = p.get("de");
    const ate = p.get("ate");
    if (!diaValido(de) || !diaValido(ate)) return null;
    return { atalho, de, ate };
  }
  return { atalho: atalho as AtalhoDoPeriodo };
}

/** O período como parâmetros do endereço (o inverso de `periodoDosParametros`). */
export function parametrosDoPeriodo(p: PeriodoPedido | null): Record<string, string> {
  if (!p) return {};
  if (p.atalho === "personalizado")
    return p.de && p.ate ? { periodo: p.atalho, de: p.de, ate: p.ate } : {};
  return { periodo: p.atalho };
}

function primeiroDoMes(dia: string): string {
  return `${dia.slice(0, 8)}01`;
}

/** Resolve o pedido em dias, a partir do "hoje" da organização. Nulo = "Tudo". */
export function resolverPeriodo(
  pedido: PeriodoPedido | null,
  hoje: string,
): PeriodoResolvido | null {
  if (!pedido) return null;
  switch (pedido.atalho) {
    case "hoje":
      return { atalho: "hoje", de: hoje, ate: hoje };
    case "7d":
      return { atalho: "7d", de: somarDias(hoje, -6), ate: hoje };
    case "30d":
      return { atalho: "30d", de: somarDias(hoje, -29), ate: hoje };
    case "mes":
      return { atalho: "mes", de: primeiroDoMes(hoje), ate: hoje };
    case "mes_passado": {
      const ultimo = somarDias(primeiroDoMes(hoje), -1);
      return { atalho: "mes_passado", de: primeiroDoMes(ultimo), ate: ultimo };
    }
    case "personalizado": {
      if (!diaValido(pedido.de) || !diaValido(pedido.ate)) return null;
      // "de" depois de "até": a pessoa inverteu — vale o recorte entre os dois.
      let de = pedido.de;
      let ate = pedido.ate;
      if (de > ate) [de, ate] = [ate, de];
      // Período sem fim prático vira o último ano e pouco até "até".
      if (somarDias(de, DIAS_NO_MAXIMO) < ate) de = somarDias(ate, -DIAS_NO_MAXIMO);
      return { atalho: "personalizado", de, ate };
    }
  }
}

/** O dia `AAAA-MM-DD` está dentro do período (inclusivo)? */
export function diaNoPeriodo(dia: string, p: PeriodoResolvido): boolean {
  return dia >= p.de && dia <= p.ate;
}

/** Todos os dias do período, em ordem (para o gráfico por dia). */
export function diasDoPeriodo(p: PeriodoResolvido): string[] {
  const dias: string[] = [];
  for (let d = p.de; d <= p.ate && dias.length <= DIAS_NO_MAXIMO; d = somarDias(d, 1)) dias.push(d);
  return dias;
}

/** "01/11 a 07/11/2026" (ou "01/12/2025 a 07/01/2026" quando atravessa o ano). */
export function rotuloDoPeriodo(p: PeriodoResolvido, t: (s: string) => string = (s) => s): string {
  const curto = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const longo = (d: string) => `${curto(d)}/${d.slice(0, 4)}`;
  if (p.de === p.ate) return longo(p.de);
  const de = p.de.slice(0, 4) === p.ate.slice(0, 4) ? curto(p.de) : longo(p.de);
  return t("{de} a {ate}").replace("{de}", de).replace("{ate}", longo(p.ate));
}
