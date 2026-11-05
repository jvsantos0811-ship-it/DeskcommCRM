"use client";
import { useState, type CSSProperties, type MouseEvent } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  NOTA_MAXIMA,
  NOTA_MINIMA_DO_NIVEL,
  PESOS_DA_NOTA,
  type Nivel,
  type Parcela,
  type QualidadeDoLead,
} from "@/lib/dados/qualidade";

/**
 * As cores do nível (prévia aprovada pelo João, 05/11): A verde, B azul, C roxo,
 * D cinza. O selo leva o próprio fundo, então lê igual no tema claro, no escuro
 * e no cabeçalho marinho do pop-up do negócio — sem um hex por tema. A cor nunca
 * é a única informação: a letra do nível está sempre escrita.
 */
const COR_DO_NIVEL: Record<Nivel | "ganho" | "perdido", { fundo: string; texto: string; borda: string }> = {
  A: { fundo: "#e3f3ea", texto: "#1f5c3d", borda: "#1f7a4d" },
  B: { fundo: "#e5eef8", texto: "#1d4f86", borda: "#2563a6" },
  C: { fundo: "#f0ebfb", texto: "#5534a8", borda: "#6b4fc4" },
  D: { fundo: "#eceff3", texto: "#3f4b59", borda: "#7a8696" },
  ganho: { fundo: "#e3f3ea", texto: "#1f5c3d", borda: "#1f7a4d" },
  perdido: { fundo: "#eceff3", texto: "#3f4b59", borda: "#7a8696" },
};

export function estiloDoNivel(chave: Nivel | "ganho" | "perdido", comBorda = false): CSSProperties {
  const c = COR_DO_NIVEL[chave];
  return { backgroundColor: c.fundo, color: c.texto, ...(comBorda ? { borderColor: c.borda } : {}) };
}

function chaveDaCor(q: QualidadeDoLead): Nivel | "ganho" | "perdido" {
  if (q.nivel) return q.nivel;
  return q.estado === "ganho" ? "ganho" : "perdido";
}

const fator = String(PESOS_DA_NOTA.fatorDaChance).replace(".", ",");

/** O texto de cada parcela do "por que". Literais em `t()`; os números vêm dos pesos. */
function rotuloDaParcela(p: Parcela, rotuloDoInteresse: string, t: (s: string) => string): string {
  switch (p.chave) {
    case "chance":
      return `${t("Chance de fechar")} ${String(p.chance ?? 0).replace(".", ",")}% × ${fator}${
        p.origemDaChance === "ia" ? ` · ${t("pela IA")}` : ` · ${t("pela etapa")}`
      }`;
    case "etapa":
      return t("Etapa com chance de {n}% ou mais").replace("{n}", String(PESOS_DA_NOTA.chanceMinimaDaEtapa));
    case "interesse":
      return `${rotuloDoInteresse} ${t("identificado")}`;
    case "respondeu":
      return t("Respondeu à IA");
    case "respondeu_engajado":
      return t("Respondeu {n} vezes ou mais").replace("{n}", String(PESOS_DA_NOTA.respostasDeEngajado));
    case "janela_curta":
      return t("Respondeu nas últimas {n} h").replace("{n}", String(PESOS_DA_NOTA.janelaCurtaHoras));
    case "janela_longa":
      return t("Respondeu nas últimas {n} h").replace("{n}", String(PESOS_DA_NOTA.janelaLongaHoras));
    case "ia_quente":
      return t("A IA marcou como quente");
    case "ia_morno":
      return t("A IA marcou como morno");
    case "nunca_respondeu":
      return t("Nunca respondeu e entrou há mais de {n} h").replace(
        "{n}",
        String(PESOS_DA_NOTA.nuncaRespondeuDepoisDeHoras),
      );
    case "sem_responder":
      return t("Mais de {n} dias sem responder").replace("{n}", String(PESOS_DA_NOTA.semResponderDias));
    case "limite":
      return t("Ajuste ao limite de 0 a 100");
    case "ganho":
      return t("Negócio ganho: a nota é 100");
    case "perdido":
      return t("Negócio perdido: a nota é 0");
    case "duplicado":
      return t("Contato já desqualificado em outro card: a nota é 0");
  }
}

function rotuloDoNivel(nivel: Nivel, t: (s: string) => string): string {
  const entre = (a: number, b: number) => t("{a} a {b}").replace("{a}", String(a)).replace("{b}", String(b));
  const faixa =
    nivel === "A"
      ? t("{n} ou mais").replace("{n}", String(NOTA_MINIMA_DO_NIVEL.A))
      : nivel === "B"
        ? entre(NOTA_MINIMA_DO_NIVEL.B, NOTA_MINIMA_DO_NIVEL.A - 1)
        : nivel === "C"
          ? entre(NOTA_MINIMA_DO_NIVEL.C, NOTA_MINIMA_DO_NIVEL.B - 1)
          : t("abaixo de {n}").replace("{n}", String(NOTA_MINIMA_DO_NIVEL.C));
  const acao =
    nivel === "A"
      ? t("Fechar agora")
      : nivel === "B"
        ? t("Empurrar")
        : nivel === "C"
          ? t("Reaquecer")
          : t("Nutrir no automático");
  return `${t("Nível")} ${nivel} (${faixa}): ${acao}.`;
}

interface SeloDaNotaProps {
  qualidade: QualidadeDoLead;
  /** O nome do lead, para o título do "por que". */
  nome: string;
  /** `rotuloDoInteresse(vocabulary)` do funil — null = "Interesse". */
  rotuloDoInteresse?: string | null;
  className?: string;
}

/**
 * O SELO "A · 86" (v3 §2): nível e nota, com o "por que" a um gesto.
 *
 * Mesmo comportamento do medidor do score (`ScoreSlot`): o mouse em cima abre,
 * o clique (ou Enter/Espaço no teclado) abre e fecha. Só hover sumiria com o
 * porquê no toque e no teclado. O clique não chega ao card: abrir o porquê não
 * é abrir o negócio.
 */
export function SeloDaNota({ qualidade: q, nome, rotuloDoInteresse, className }: SeloDaNotaProps) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const interesse = rotuloDoInteresse ?? t("Interesse");
  const pare = (e: MouseEvent) => e.stopPropagation();
  const rotulo = q.nivel
    ? `${q.nivel} · ${q.nota}`
    : `${q.estado === "ganho" ? t("Ganho") : t("Perdido")} · ${q.nota}`;
  const ariaLabel = (
    q.nivel
      ? t("Nota de qualidade {nota}, nível {nivel}. Ver o porquê.").replace("{nivel}", q.nivel)
      : t("Nota de qualidade {nota}. Ver o porquê.")
  ).replace("{nota}", String(q.nota));
  const titulo = t("Por que {nome} tem nota {nota}").replace("{nome}", nome).replace("{nota}", String(q.nota));
  const total = t("{nota} de {max}").replace("{nota}", String(q.nota)).replace("{max}", String(NOTA_MAXIMA));
  const cor = chaveDaCor(q);

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="selo-da-nota"
          data-nivel={q.nivel ?? q.estado}
          data-nota={q.nota}
          aria-label={ariaLabel}
          onClick={(e) => {
            pare(e);
            // O mouse já abriu no hover: o clique dele MANTÉM aberto (alternar
            // fecharia o porquê no gesto de quem quer lê-lo). Teclado (Enter ou
            // Espaço, `detail === 0`) alterna. `preventDefault` para o gatilho do
            // Radix não alternar de novo por cima.
            e.preventDefault();
            const peloTeclado = e.detail === 0;
            setAberto((v) => (peloTeclado ? !v : true));
          }}
          onMouseEnter={() => setAberto(true)}
          onMouseLeave={() => setAberto(false)}
          className={cn(
            "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-md px-1.5 text-[11px] font-bold leading-none tabular-nums",
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
            className,
          )}
          style={estiloDoNivel(cor)}
        >
          {rotulo}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 text-xs"
        onClick={pare}
        data-testid="porque-da-nota"
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-semibold text-text">{titulo}</p>
          {q.nivel && (
            <span className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold" style={estiloDoNivel(q.nivel)}>
              {q.nivel}
            </span>
          )}
        </div>
        <ul className="mt-3 space-y-1.5">
          {q.parcelas.map((p) => (
            <li key={p.chave} className="flex items-baseline justify-between gap-3" data-chave={p.chave}>
              <span className="min-w-0 text-text-muted">{rotuloDaParcela(p, interesse, t)}</span>
              {q.estado === "aberto" && (
                <span
                  className={cn(
                    "shrink-0 font-bold tabular-nums",
                    p.pontos >= 0 ? "text-success-fg" : "text-error-fg",
                  )}
                >
                  {p.pontos >= 0 ? "+" : "−"}
                  {Math.abs(p.pontos)}
                </span>
              )}
            </li>
          ))}
          {q.parcelas.length === 0 && <li className="text-text-muted">{t("Nenhum sinal ainda.")}</li>}
        </ul>
        <p className="mt-3 flex justify-between border-t border-border pt-2 text-sm font-semibold text-text">
          <span>{t("Nota")}</span>
          <span className="tabular-nums">{total}</span>
        </p>
        {q.nivel && <p className="mt-2 text-text-muted">{rotuloDoNivel(q.nivel, t)}</p>}
      </PopoverContent>
    </Popover>
  );
}
