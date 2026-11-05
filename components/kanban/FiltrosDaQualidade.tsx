"use client";
import Link from "next/link";
import { useMemo, type CSSProperties, type ReactNode } from "react";

import { useT } from "@/hooks/i18n/useT";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NIVEIS, SITUACOES, TEMPERATURAS, type Nivel, type Situacao, type Temperatura } from "@/lib/dados/qualidade";
import type { LeadFilters } from "@/lib/kanban/filters";
import type { Lead } from "@/lib/types/leads";
import { cn } from "@/lib/utils";
import { estiloDoNivel } from "./SeloDaNota";

interface Props {
  filters: LeadFilters;
  onChange: (next: LeadFilters) => void;
  leads: Lead[];
  /** `rotuloDoInteresse(vocabulary)` do funil — Benefício, Procedimento, Serviço; null = "Interesse". */
  rotuloDoInteresse?: string | null;
}

type Chave = "nivel" | "temperatura" | "servico" | "situacao";

/**
 * OS CHIPS DA QUALIDADE NO TOPO DO QUADRO (v3 §3): "Nível: A ×", "+ Temperatura",
 * "+ Benefício", "+ Situação". Cada chip é um parâmetro da URL (`?nivel=`,
 * `?temp=`, `?servico=`, `?situacao=`), então o link que o painel de Dados abre
 * chega com o chip ligado, e o F5 não o perde.
 *
 * Chip desligado é tracejado, com "+"; ligado mostra o valor e um "×" para tirar
 * — dois botões lado a lado, nunca botão dentro de botão. As opções do interesse
 * são as que ESTÃO no quadro (como as etiquetas): oferecer um tipo que nenhum
 * card tem seria um filtro que nunca acha nada.
 */
export function FiltrosDaQualidade({ filters, onChange, leads, rotuloDoInteresse }: Props) {
  const t = useT();
  const interesse = rotuloDoInteresse ?? t("Interesse");

  const interesses = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads) if (l.qualidade?.interesse) set.add(l.qualidade.interesse);
    return [...set].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [leads]);

  const rotuloDoNivel = (n: Nivel) =>
    `${n} · ${n === "A" ? t("Fechar agora") : n === "B" ? t("Empurrar") : n === "C" ? t("Reaquecer") : t("Nutrir no automático")}`;
  const rotuloDaTemperatura = (v: Temperatura) => (v === "quente" ? t("Quente") : v === "morno" ? t("Morno") : t("Frio"));
  const rotuloDaSituacao = (v: Situacao) =>
    v === "esperando_fechamento"
      ? t("Esperando fechamento")
      : v === "parado"
        ? t("Parado além do prazo da etapa")
        : t("Nunca recebeu resposta");

  const tirar = (chave: Chave) => onChange({ ...filters, [chave]: undefined });

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="filtros-da-qualidade">
      <span className="text-xs text-text-muted">{t("Qualidade do lead:")}</span>
      <Chip
        chave="nivel"
        titulo={t("Nível")}
        valor={filters.nivel ? filters.nivel : null}
        estiloLigado={filters.nivel ? estiloDoNivel(filters.nivel, true) : undefined}
        tirarRotulo={`${t("Tirar filtro")}: ${t("Nível")}`}
        onTirar={() => tirar("nivel")}
      >
        {NIVEIS.map((n) => (
          <DropdownMenuItem key={n} data-testid={`filtro-qualidade-opcao-nivel-${n}`} onClick={() => onChange({ ...filters, nivel: n })}>
            <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: estiloDoNivel(n).color }} aria-hidden />
            {rotuloDoNivel(n)}
          </DropdownMenuItem>
        ))}
      </Chip>
      <Chip
        chave="temperatura"
        titulo={t("Temperatura")}
        valor={filters.temperatura ? rotuloDaTemperatura(filters.temperatura) : null}
        tirarRotulo={`${t("Tirar filtro")}: ${t("Temperatura")}`}
        onTirar={() => tirar("temperatura")}
      >
        {TEMPERATURAS.map((v) => (
          <DropdownMenuItem key={v} data-testid={`filtro-qualidade-opcao-temperatura-${v}`} onClick={() => onChange({ ...filters, temperatura: v })}>
            {rotuloDaTemperatura(v)}
          </DropdownMenuItem>
        ))}
      </Chip>
      <Chip
        chave="servico"
        titulo={interesse}
        valor={filters.servico ?? null}
        tirarRotulo={`${t("Tirar filtro")}: ${interesse}`}
        onTirar={() => tirar("servico")}
      >
        {interesses.length === 0 ? (
          <DropdownMenuItem disabled>{t("Nenhum card com interesse identificado.")}</DropdownMenuItem>
        ) : (
          interesses.map((v) => (
            <DropdownMenuItem key={v} onClick={() => onChange({ ...filters, servico: v })}>
              {v}
            </DropdownMenuItem>
          ))
        )}
      </Chip>
      <Chip
        chave="situacao"
        titulo={t("Situação")}
        valor={filters.situacao ? rotuloDaSituacao(filters.situacao) : null}
        tirarRotulo={`${t("Tirar filtro")}: ${t("Situação")}`}
        onTirar={() => tirar("situacao")}
      >
        {SITUACOES.map((v) => (
          <DropdownMenuItem key={v} data-testid={`filtro-qualidade-opcao-situacao-${v}`} onClick={() => onChange({ ...filters, situacao: v })}>
            {rotuloDaSituacao(v)}
          </DropdownMenuItem>
        ))}
      </Chip>
      {filters.recorte === "painel" && (
        // v3 §8: o link do painel de Dados chega com o recorte dele, para o
        // quadro mostrar a mesma quantidade. Tirar o recorte mostra todo card.
        <span
          data-testid="filtro-qualidade-recorte"
          data-ligado="sim"
          title={t("Só os leads que o painel de Dados conta: sem a base importada, o cadastro manual e os cards de teste.")}
          className="inline-flex h-8 items-center rounded-full border border-accent bg-accent/10 pl-3 text-xs font-semibold text-text"
        >
          {t("Mesmo recorte do painel de Dados")}
          <button
            type="button"
            data-testid="filtro-qualidade-recorte-tirar"
            aria-label={`${t("Tirar filtro")}: ${t("Mesmo recorte do painel de Dados")}`}
            onClick={() => onChange({ ...filters, recorte: undefined })}
            className="ml-1 mr-1 flex h-6 w-6 items-center justify-center rounded-full text-base leading-none hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span aria-hidden>×</span>
          </button>
        </span>
      )}
      {filters.recorte === "painel" && (
        <Link
          href="/app/dados"
          data-testid="voltar-para-dados"
          className="text-xs font-semibold text-accent underline-offset-2 hover:underline"
        >
          {t("Voltar para Dados")}
        </Link>
      )}
    </div>
  );
}

function Chip({
  chave,
  titulo,
  valor,
  estiloLigado,
  tirarRotulo,
  onTirar,
  children,
}: {
  chave: Chave;
  titulo: string;
  valor: string | null;
  estiloLigado?: CSSProperties;
  tirarRotulo: string;
  onTirar: () => void;
  children: ReactNode;
}) {
  const ligado = valor !== null;
  return (
    <span
      data-testid={`filtro-qualidade-${chave}`}
      data-ligado={ligado ? "sim" : "nao"}
      className={cn(
        "inline-flex h-8 items-center rounded-full border text-xs font-semibold",
        ligado ? "border-accent bg-accent/10 text-text" : "border-dashed border-border-strong bg-surface text-text-muted",
      )}
      style={ligado ? estiloLigado : undefined}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid={`filtro-qualidade-${chave}-abrir`}
            className={cn(
              "h-full rounded-full px-3 hover:text-text focus-visible:outline-2 focus-visible:outline-accent",
              ligado && "pr-1",
            )}
          >
            {ligado ? `${titulo}: ${valor}` : `+ ${titulo}`}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">{children}</DropdownMenuContent>
      </DropdownMenu>
      {ligado && (
        <button
          type="button"
          data-testid={`filtro-qualidade-${chave}-tirar`}
          aria-label={tirarRotulo}
          onClick={onTirar}
          className="mr-1 flex h-6 w-6 items-center justify-center rounded-full text-base leading-none hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span aria-hidden>×</span>
        </button>
      )}
    </span>
  );
}
