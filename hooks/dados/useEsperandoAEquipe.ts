"use client";
import { useQuery } from "@tanstack/react-query";

import type { RespostaEsperandoAEquipe } from "@/app/api/v1/dados/esperando-a-equipe/route";
import { apiClient } from "@/lib/api/client";

/**
 * O painel "Esperando a equipe" (PM-027 §6). Sem funil, a organização inteira
 * (aba Gestão de Dados); com funil, só os leads dele (o quadro com
 * `?esperando=equipe`). `null` desliga a consulta.
 */
export function useEsperandoAEquipe(pipelineId: string | null | undefined = undefined) {
  const desligado = pipelineId === null;
  const qs = pipelineId ? `?pipeline_id=${encodeURIComponent(pipelineId)}` : "";
  return useQuery({
    queryKey: ["dados", "esperando-a-equipe", pipelineId ?? "todos"],
    queryFn: () =>
      apiClient.get<{ data: RespostaEsperandoAEquipe }>(`/api/v1/dados/esperando-a-equipe${qs}`).then((r) => r.data),
    enabled: !desligado,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
