"use client";
import { useT } from "@/hooks/i18n/useT";

/**
 * As etiquetas do negócio, à vista no card do funil (PC-013).
 *
 * ─── Por que voltaram para a face do card ──────────────────────────────────
 *
 * O card escondia as etiquetas num `title` (só no hover do card inteiro), para
 * o card não crescer com dado. Para escritório de advocacia a etiqueta É a
 * triagem — "auxílio-acidente", "INSS negado", "parou-no-meio" — e ler o funil
 * sem elas obrigava a abrir negócio por negócio. O orçamento de altura continua
 * de pé: é UMA linha, de altura fixa, com no máximo duas etiquetas e um "+N"
 * para o resto (o nome inteiro do resto fica no `title` do "+N").
 *
 * Sem etiqueta, a linha não existe — não há "sem etiquetas" cinza ocupando
 * espaço em metade dos cards para não dizer nada.
 *
 * ─── A cor ─────────────────────────────────────────────────────────────────
 *
 * Etiqueta é texto livre (`crm_leads.tags text[]`), sem cor cadastrada. O
 * pontinho de cor sai do próprio nome, sempre o mesmo para o mesmo nome — o
 * olho reconhece "INSS negado" pela cor sem ler, em qualquer card. A cor está
 * só no ponto: o texto é sempre o da etiqueta, então ninguém depende de cor
 * para entender.
 */

export const MAXIMO_DE_ETIQUETAS_A_VISTA = 2;

const CORES_DOS_PONTOS = [
  "#2f7d6d",
  "#b0452b",
  "#1e5aa8",
  "#6a3fc2",
  "#b07a2b",
  "#8c1d2c",
  "#145a6b",
  "#41673f",
] as const;

/** A cor do ponto de uma etiqueta: estável pelo nome, sem estado nenhum. */
export function corDaEtiqueta(nome: string): string {
  let h = 0;
  for (const ch of nome.toLowerCase()) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return CORES_DOS_PONTOS[h % CORES_DOS_PONTOS.length]!;
}

export function EtiquetasNoCard({ tags }: { tags: readonly string[] }) {
  const t = useT();
  const unicas = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  if (unicas.length === 0) return null;
  const aVista = unicas.slice(0, MAXIMO_DE_ETIQUETAS_A_VISTA);
  const resto = unicas.slice(MAXIMO_DE_ETIQUETAS_A_VISTA);

  return (
    <ul
      aria-label={t("Etiquetas")}
      data-testid="etiquetas-no-card"
      className="mt-1.5 flex h-[22px] items-center gap-1 overflow-hidden"
    >
      {aVista.map((tag) => (
        <li
          key={tag}
          title={tag}
          className="inline-flex h-[22px] min-w-0 max-w-[7.5rem] shrink items-center gap-1.5 rounded-full border border-border bg-bg px-2 text-[11px] text-text"
        >
          <span
            aria-hidden
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: corDaEtiqueta(tag) }}
          />
          <span className="truncate">{tag}</span>
        </li>
      ))}
      {resto.length > 0 && (
        <li
          title={resto.join(", ")}
          aria-label={`${t("Mais")} ${resto.length}: ${resto.join(", ")}`}
          className="inline-flex h-[22px] shrink-0 items-center rounded-full border border-dashed border-border-strong px-1.5 text-[11px] font-medium text-text-muted"
        >
          +{resto.length}
        </li>
      )}
    </ul>
  );
}
