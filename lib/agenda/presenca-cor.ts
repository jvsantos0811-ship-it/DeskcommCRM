/**
 * PC-052 parte 2 — o mapa PURO da presença do lead para o Google (sem rede,
 * sem banco). Mora separado de `presenca.ts` porque `lib/agenda/google/evento.ts`
 * o usa, e `presenca.ts` importa o sync — importar de lá faria um ciclo.
 * O porquê de cada regra está no cabeçalho de `lib/agenda/presenca.ts`.
 */
export const PRESENCAS = ["aguardando", "confirmada", "nao_vai"] as const;
export type Presenca = (typeof PRESENCAS)[number];

/** Ids de cor de evento do Google Agenda (`colors.get`, paleta de evento). */
export const COR_DA_PRESENCA: Record<Presenca, string> = {
  aguardando: "5", // Banana (amarelo)
  confirmada: "10", // Basil (verde)
  nao_vai: "11", // Tomato (vermelho)
};

export function ehPresenca(v: unknown): v is Presenca {
  return typeof v === "string" && (PRESENCAS as readonly string[]).includes(v);
}

/** Quem não vai libera o horário — a mesma régua do motor, do índice e do lembrete. */
export function presencaLiberaOHorario(v: unknown): boolean {
  return v === "nao_vai";
}

/** A aparência do evento no Google para a presença; `null` = não mexer (tipo sem presença). */
export function aparenciaDaPresenca(
  v: unknown,
): { colorId: string; transparency: "opaque" | "transparent" } | null {
  if (!ehPresenca(v)) return null;
  return {
    colorId: COR_DA_PRESENCA[v],
    transparency: presencaLiberaOHorario(v) ? "transparent" : "opaque",
  };
}
