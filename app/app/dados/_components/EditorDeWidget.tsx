"use client";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { usePipelines } from "@/hooks/webhooks/useWebhookSources";
import {
  agrupamentosDa,
  METRICAS,
  PERIODOS,
  SOBRE_A_METRICA,
  widgetSchema,
  type Agrupamento,
  type Metrica,
  type Visual,
  type Widget,
} from "@/lib/dados/widgets";

const TODOS = "";

function rotuloDoAgrupamento(a: Agrupamento, t: (s: string) => string): string {
  switch (a) {
    case "nenhum":
      return t("Total (um número)");
    case "dia":
      return t("Por dia");
    case "semana":
      return t("Por semana");
    case "mes":
      return t("Por mês");
    case "etapa":
      return t("Por etapa");
    case "funil":
      return t("Por funil");
    case "dono":
      return t("Por responsável");
    case "origem":
      return t("Por origem");
    case "motivo":
      return t("Por motivo de perda");
  }
}

function rotuloDoVisual(v: Visual, t: (s: string) => string): string {
  switch (v) {
    case "numero":
      return t("Número");
    case "linha":
      return t("Linha");
    case "barras":
      return t("Barras");
    case "pizza":
      return t("Pizza");
  }
}

function rotuloDaMetrica(m: Metrica, t: (s: string) => string): string {
  switch (m) {
    case "leads_criados":
      return t("Negócios criados");
    case "negocios_ganhos":
      return t("Negócios ganhos");
    case "valor_ganho":
      return t("Valor ganho");
    case "negocios_perdidos":
      return t("Negócios perdidos");
    case "valor_perdido":
      return t("Valor perdido");
    case "taxa_de_conversao":
      return t("Taxa de conversão");
    case "ticket_medio":
      return t("Ticket médio");
    case "negocios_abertos":
      return t("Negócios em aberto");
    case "valor_em_aberto":
      return t("Valor em aberto");
    case "conversas_iniciadas":
      return t("Conversas iniciadas");
  }
}

export { rotuloDaMetrica };

/**
 * O formulário de um gráfico. Cada escolha restringe a seguinte: a métrica diz
 * como dá para agrupar (conversa não tem motivo de perda), e o agrupamento diz
 * o visual ("total" é um número; o resto é gráfico).
 */
export function EditorDeWidget({
  inicial,
  onSalvar,
  onCancelar,
}: {
  inicial: Widget | null;
  onSalvar: (w: Widget) => void;
  onCancelar: () => void;
}) {
  const t = useT();
  const pipelines = usePipelines();
  const membros = useAssignableMembers(true);
  const [metrica, setMetrica] = useState<Metrica>(inicial?.metrica ?? "negocios_ganhos");
  const [agrupar, setAgrupar] = useState<Agrupamento>(inicial?.agrupar_por ?? "nenhum");
  const [visual, setVisual] = useState<Visual>(inicial?.visual ?? "numero");
  const [periodo, setPeriodo] = useState<number>(inicial?.periodo_dias ?? 30);
  const [funil, setFunil] = useState<string>(inicial?.pipeline_id ?? TODOS);
  const [dono, setDono] = useState<string>(inicial?.owner_user_id ?? TODOS);
  const tipo = SOBRE_A_METRICA[metrica].tipo;
  const [titulo, setTitulo] = useState(inicial?.titulo ?? "");
  const [meta, setMeta] = useState<string>(
    inicial?.meta != null ? String(tipo === "dinheiro" ? inicial.meta / 100 : inicial.meta) : "",
  );

  const agrupamentos = agrupamentosDa(metrica);
  const visuais: Visual[] = agrupar === "nenhum" ? ["numero"] : ["linha", "barras", "pizza"];

  const trocarMetrica = (m: Metrica) => {
    setMetrica(m);
    if (!agrupamentosDa(m).includes(agrupar)) {
      setAgrupar("nenhum");
      setVisual("numero");
    }
  };
  const trocarAgrupamento = (a: Agrupamento) => {
    setAgrupar(a);
    if (a === "nenhum") setVisual("numero");
    else if (visual === "numero") setVisual(a === "dia" || a === "semana" || a === "mes" ? "linha" : "barras");
  };

  const metaNumero = meta.trim() === "" ? null : Number(meta.replace(",", "."));
  const candidato: Widget = {
    id: inicial?.id ?? `w${Date.now().toString(36)}`,
    titulo: titulo.trim() || rotuloDaMetrica(metrica, t),
    metrica,
    agrupar_por: agrupar,
    visual,
    periodo_dias: periodo,
    pipeline_id: funil || null,
    owner_user_id: dono || null,
    meta: metaNumero == null || Number.isNaN(metaNumero) ? null : tipo === "dinheiro" ? Math.round(metaNumero * 100) : metaNumero,
  };
  const valido = widgetSchema.safeParse(candidato).success && !(metaNumero != null && Number.isNaN(metaNumero));
  const campo = "h-9 rounded-md border border-border bg-background px-2 text-sm text-text";

  return (
    <Dialog open onOpenChange={(open) => !open && onCancelar()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{inicial ? t("Editar gráfico") : t("Novo gráfico")}</DialogTitle>
          <DialogDescription>{t("Escolha o que medir, como agrupar e, se quiser, uma meta.")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            {t("Título")}
            <input
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              maxLength={80}
              placeholder={rotuloDaMetrica(metrica, t)}
              className={campo}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("O que medir")}
            <select value={metrica} onChange={(e) => trocarMetrica(e.target.value as Metrica)} className={campo}>
              {METRICAS.map((m) => (
                <option key={m} value={m}>
                  {rotuloDaMetrica(m, t)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("Agrupar")}
            <select value={agrupar} onChange={(e) => trocarAgrupamento(e.target.value as Agrupamento)} className={campo}>
              {agrupamentos.map((a) => (
                <option key={a} value={a}>
                  {rotuloDoAgrupamento(a, t)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("Visual")}
            <select value={visual} onChange={(e) => setVisual(e.target.value as Visual)} className={campo}>
              {visuais.map((v) => (
                <option key={v} value={v}>
                  {rotuloDoVisual(v, t)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("Período")}
            <select value={periodo} onChange={(e) => setPeriodo(Number(e.target.value))} className={campo}>
              {PERIODOS.map((p) => (
                <option key={p} value={p}>
                  {t("Últimos {n} dias").replace("{n}", String(p))}
                </option>
              ))}
            </select>
          </label>
          {metrica !== "conversas_iniciadas" && (
            <label className="flex flex-col gap-1 text-sm">
              {t("Funil")}
              <select value={funil} onChange={(e) => setFunil(e.target.value)} className={campo}>
                <option value={TODOS}>{t("Todos")}</option>
                {(pipelines.data?.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm">
            {t("Responsável")}
            <select value={dono} onChange={(e) => setDono(e.target.value)} className={campo}>
              <option value={TODOS}>{t("Todos")}</option>
              {(membros.data ?? []).map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.full_name ?? m.user_id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            {tipo === "dinheiro"
              ? t("Meta em reais (opcional)")
              : tipo === "percentual"
                ? t("Meta em % (opcional)")
                : t("Meta (opcional)")}
            <input
              value={meta}
              onChange={(e) => setMeta(e.target.value)}
              inputMode="decimal"
              placeholder={tipo === "dinheiro" ? "50000" : tipo === "percentual" ? "25" : "40"}
              className={campo}
            />
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancelar}>
            {t("Cancelar")}
          </Button>
          <Button disabled={!valido} onClick={() => onSalvar(candidato)}>
            {t("Salvar gráfico")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
