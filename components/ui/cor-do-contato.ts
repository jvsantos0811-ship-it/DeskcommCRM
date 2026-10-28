import type { CSSProperties } from "react";

import { corDaTrilha, fundoDaTrilha } from "@/components/agenda/paleta";
import type { TrilhaDeCor } from "@/components/agenda/tipos";

/**
 * A cor das iniciais de um contato (PC-012, "visual vivo").
 *
 * Antes toda bolinha de iniciais era o mesmo cinza, e a lista de conversas e o
 * funil viravam uma parede igual. Aqui cada contato ganha uma das oito trilhas
 * de cor da Agenda (`--agenda-pessoa-1..8`), escolhida pelo `id` — ESTÁVEL: a
 * mesma pessoa tem a mesma cor na lista, no funil e no card, hoje e amanhã.
 *
 * A cor NUNCA é a única informação: ela vai atrás das iniciais, que continuam
 * lá. E não reaproveita a accent, que é da marca e mudaria com o revendedor.
 *
 * Contraste: o fundo é a trilha a 20% sobre a superfície e o texto é a trilha
 * misturada com `--color-text` (escuro no claro, claro no escuro), então as
 * iniciais seguem legíveis nos dois temas sem um hex por tema.
 */
export function trilhaDoContato(id: string | null | undefined): TrilhaDeCor {
  const chave = id ?? "";
  let h = 0;
  for (let i = 0; i < chave.length; i++) {
    h = (h * 31 + chave.charCodeAt(i)) >>> 0;
  }
  return ((h % 8) + 1) as TrilhaDeCor;
}

export function estiloDasIniciais(id: string | null | undefined): CSSProperties {
  const trilha = trilhaDoContato(id);
  return {
    backgroundColor: fundoDaTrilha(trilha, 20),
    color: `color-mix(in oklab, ${corDaTrilha(trilha)} 45%, var(--color-text))`,
  };
}
