/**
 * PC-021, item 6: as mídias não entendidas da organização, contadas por dia no
 * fuso dela. Pura: recebe as linhas já lidas (tipo e hora) e devolve a tabela,
 * do dia mais recente para o mais antigo.
 */
export interface MidiasNaoEntendidasPorDia {
  dia: string;
  audios: number;
  outras: number;
}

export function contarPorDia(
  linhas: ReadonlyArray<{ type: string; created_at: string }>,
  fuso: string,
): MidiasNaoEntendidasPorDia[] {
  const fmt = (iso: string): string => {
    try {
      return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: fuso }).format(new Date(iso));
    } catch {
      return iso.slice(0, 10);
    }
  };
  const chave = (iso: string): string => {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: fuso }).format(new Date(iso));
    } catch {
      return iso.slice(0, 10);
    }
  };
  const porDia = new Map<string, MidiasNaoEntendidasPorDia>();
  for (const l of linhas) {
    const k = chave(l.created_at);
    const atual = porDia.get(k) ?? { dia: fmt(l.created_at), audios: 0, outras: 0 };
    if (l.type === "audio") atual.audios += 1;
    else atual.outras += 1;
    porDia.set(k, atual);
  }
  return [...porDia.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([, v]) => v);
}
