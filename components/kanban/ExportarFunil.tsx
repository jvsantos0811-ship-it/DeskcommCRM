"use client";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { orgDaAba, HEADER_ORG_DA_ABA } from "@/lib/auth/org-da-aba";
import { campoSensivel, type CampoDoFunil, type FormatoDaPlanilha } from "@/lib/funil/exportar";
import { marcadoresDoFiltro, type LeadFilters } from "@/lib/kanban/filters";
import { DownloadSimple } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * EXPORTAR A PLANILHA DO FUNIL (PC-024, item 4).
 *
 * O botão mora no topo do quadro, só para gerente ou dono (a rota cobra o
 * mesmo). Exporta os cards que o quadro mostra AGORA — com a busca, etiqueta,
 * responsável e demais filtros ligados — e, por cima, a etapa e o período de
 * criação escolhidos aqui. A geração roda depois que o diálogo fecha: a pessoa
 * continua no quadro e o aviso diz quando o arquivo ficou pronto.
 *
 * Campo sensível (saúde, documento ou marcado em Configurações › Funis) nasce
 * DESMARCADO e com o aviso ao lado: só sai quem for marcado de propósito.
 */
export function ExportarFunil({
  pipelineId,
  etapas,
  campos,
  idsVisiveis,
  filtros,
}: {
  pipelineId: string;
  etapas: Array<{ id: string; name: string }>;
  campos: CampoDoFunil[];
  idsVisiveis: string[];
  filtros: LeadFilters;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [formato, setFormato] = useState<FormatoDaPlanilha>("xlsx");
  const [etapaId, setEtapaId] = useState("");
  const [de, setDe] = useState("");
  const [ate, setAte] = useState("");
  const camposValidos = useMemo(() => campos.filter((c) => c && typeof c.key === "string"), [campos]);
  const [escolhidos, setEscolhidos] = useState<Set<string>>(
    () => new Set(camposValidos.filter((c) => !campoSensivel(c)).map((c) => c.key)),
  );
  const [gerando, setGerando] = useState(false);

  const nenhum = idsVisiveis.length === 0;

  function alternar(chave: string, marcado: boolean) {
    setEscolhidos((atual) => {
      const novo = new Set(atual);
      if (marcado) novo.add(chave);
      else novo.delete(chave);
      return novo;
    });
  }

  async function exportar() {
    setAberto(false);
    setGerando(true);
    const aviso = toast.loading(t("Gerando a planilha… pode continuar usando o funil."));
    try {
      const escolhidosAgora = camposValidos.filter((c) => escolhidos.has(c.key));
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const aba = orgDaAba();
      if (aba?.orgId) headers[HEADER_ORG_DA_ABA] = aba.orgId;
      const res = await fetch(`/api/v1/pipelines/${pipelineId}/export`, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify({
          formato,
          lead_ids: idsVisiveis,
          etapa_id: etapaId || null,
          criado_de: de || null,
          criado_ate: ate || null,
          campos: escolhidosAgora.map((c) => c.key),
          sensiveis_marcados: escolhidosAgora.filter((c) => campoSensivel(c)).map((c) => c.key),
          filtros: {
            busca: Boolean(filtros.search?.trim()),
            etiquetas: marcadoresDoFiltro(filtros.tag).length,
            responsavel: Boolean(filtros.owner && filtros.owner !== "any"),
            situacao: filtros.status && filtros.status !== "all" ? filtros.status : null,
            outros: [
              filtros.nivel ? "nivel" : null,
              filtros.temperatura ? "temperatura" : null,
              filtros.servico ? "interesse" : null,
              filtros.situacao ? "situacao_da_qualidade" : null,
              filtros.lostReason || filtros.lostCategory ? "motivo_de_perda" : null,
              filtros.overdueOnly ? "atrasados" : null,
              filtros.esperando ? "esperando_a_equipe" : null,
              filtros.recorte ? "recorte_do_painel" : null,
            ].filter((x): x is string => x !== null),
          },
        }),
      });
      if (!res.ok) {
        const corpo = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(corpo?.error?.message ?? t("Não foi possível gerar a planilha agora."));
      }
      const linhas = Number(res.headers.get("X-Export-Linhas") ?? "0");
      const disposicao = res.headers.get("Content-Disposition") ?? "";
      const nome = /filename="([^"]+)"/.exec(disposicao)?.[1] ?? `funil.${formato}`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = nome;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success(`${t("Planilha pronta")}: ${linhas} ${linhas === 1 ? t("card") : t("cards")}`, { id: aviso });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Não foi possível gerar a planilha agora."), {
        id: aviso,
      });
    } finally {
      setGerando(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        className="shrink-0"
        disabled={gerando}
        data-testid="exportar-funil"
        title={t("Baixa a lista dos cards deste funil, com os filtros de agora, em planilha.")}
        onClick={() => setAberto(true)}
      >
        <DownloadSimple size={16} className="mr-2" aria-hidden />
        {gerando ? t("Gerando…") : t("Exportar")}
      </Button>
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("Exportar o funil em planilha")}</DialogTitle>
            <DialogDescription>
              {nenhum
                ? t("Nenhum card no quadro com os filtros de agora.")
                : `${idsVisiveis.length} ${idsVisiveis.length === 1 ? t("card no quadro com os filtros de agora.") : t("cards no quadro com os filtros de agora.")}`}{" "}
              {t("Conversas, notas, anexos e a descrição dos cards nunca saem na planilha.")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-sm font-medium">{t("Formato")}</legend>
              {(
                [
                  ["xlsx", t("Planilha do Excel (.xlsx)")],
                  ["csv", t("CSV (abre no Excel e no Google Planilhas)")],
                ] as const
              ).map(([valor, rotulo]) => (
                <label key={valor} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="formato-do-export"
                    value={valor}
                    checked={formato === valor}
                    onChange={() => setFormato(valor)}
                    data-testid={`formato-${valor}`}
                  />
                  {rotulo}
                </label>
              ))}
            </fieldset>

            <div className="grid gap-1.5">
              <Label htmlFor="etapa-do-export">{t("Etapa")}</Label>
              <select
                id="etapa-do-export"
                data-testid="etapa-do-export"
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={etapaId}
                onChange={(e) => setEtapaId(e.target.value)}
              >
                <option value="">{t("Todas as etapas")}</option>
                {etapas.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="export-criado-de">{t("Criados de")}</Label>
                <Input id="export-criado-de" type="date" value={de} onChange={(e) => setDe(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="export-criado-ate">{t("até")}</Label>
                <Input id="export-criado-ate" type="date" value={ate} onChange={(e) => setAte(e.target.value)} />
              </div>
            </div>

            {camposValidos.length > 0 && (
              <fieldset className="grid gap-1.5">
                <legend className="mb-1 text-sm font-medium">{t("Campos personalizados")}</legend>
                {camposValidos.map((c) => {
                  const sensivel = campoSensivel(c);
                  return (
                    <label key={c.key} className="flex cursor-pointer items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={escolhidos.has(c.key)}
                        onChange={(e) => alternar(c.key, e.target.checked)}
                        data-testid={`campo-do-export-${c.key}`}
                      />
                      <span>
                        {c.label || c.key}
                        {sensivel && (
                          <span className="ml-1.5 rounded-sm bg-warning-bg px-1 py-0.5 text-[11px] font-medium text-warning-fg">
                            {t("dado sensível")}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  {t("Dados sensíveis (saúde, documentos) ficam fora, a não ser que você os marque. Cada exportação fica registrada na auditoria.")}
                </p>
              </fieldset>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAberto(false)}>
              {t("Cancelar")}
            </Button>
            <Button disabled={nenhum} onClick={() => void exportar()} data-testid="confirmar-exportar-funil">
              {t("Exportar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
