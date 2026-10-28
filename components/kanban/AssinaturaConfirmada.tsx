"use client";
/**
 * "Assinatura confirmada" — o ganho por assinatura (PC-003, item 3 (b)).
 *
 * Só para quem tem papel GERENTE (a rota recusa os demais). Registra a data em
 * que o contrato foi assinado; o servidor leva o negócio para a etapa de ganho,
 * põe a tag `contrato-assinado` e guarda quem registrou
 * (`POST /api/v1/leads/:id/assinatura-confirmada`). A IA nunca marca ganho:
 * este botão e o aviso do serviço de assinatura são as duas portas.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { useT } from "@/hooks/i18n/useT";
import { chaveDoQuadro } from "@/hooks/kanban/useBoard";

interface Props {
  leadId: string;
  pipelineId: string;
  status: string;
  tags: readonly string[];
  podeConfirmar: boolean;
}

function hojeLocal(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function AssinaturaConfirmada({ leadId, pipelineId, status, tags, podeConfirmar }: Props) {
  const t = useT();
  const qc = useQueryClient();
  const [abrindo, setAbrindo] = useState(false);
  const [data, setData] = useState(hojeLocal);
  const [enviando, setEnviando] = useState(false);
  const assinado = tags.includes("contrato-assinado");

  if (assinado) {
    return (
      <p className="py-2 text-xs text-text-muted" data-testid="assinatura-confirmada-feita">
        {t("Contrato assinado — ganho registrado.")}
      </p>
    );
  }
  if (!podeConfirmar || status !== "open") return null;

  async function confirmar() {
    setEnviando(true);
    try {
      await apiClient.post(`/api/v1/leads/${leadId}/assinatura-confirmada`, { data_assinatura: data });
      toast.success(t("Assinatura confirmada: o negócio foi para a etapa de ganho."));
      setAbrindo(false);
      void qc.invalidateQueries({ queryKey: chaveDoQuadro(pipelineId) });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Não consegui registrar a assinatura."));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="space-y-2 py-2" data-testid="assinatura-confirmada">
      {!abrindo ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="assinatura-confirmada-abrir"
          onClick={() => setAbrindo(true)}
        >
          {t("Assinatura confirmada")}
        </Button>
      ) : (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-xs text-text-muted">
            {t("Registre só com o contrato assinado. O negócio vai para a etapa de ganho e recebe a tag contrato-assinado.")}
          </p>
          <div className="space-y-1">
            <Label htmlFor={`data-assinatura-${leadId}`}>{t("Data da assinatura")}</Label>
            <Input
              id={`data-assinatura-${leadId}`}
              type="date"
              data-testid="assinatura-confirmada-data"
              value={data}
              max={hojeLocal()}
              onChange={(e) => setData(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="assinatura-confirmada-salvar"
              disabled={enviando || !data}
              onClick={confirmar}
            >
              {enviando ? t("Salvando…") : t("Confirmar assinatura")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAbrindo(false)}>
              {t("Cancelar")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
