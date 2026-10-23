"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { Painel, PainelInput, Resultado, Widget } from "@/lib/dados/widgets";

const CHAVE = ["dados", "paineis"] as const;

export function usePaineis() {
  const qc = useQueryClient();
  const lista = useQuery({
    queryKey: CHAVE,
    queryFn: () => apiClient.get<{ data: Painel[] }>("/api/v1/dados/paineis").then((r) => r.data),
  });
  const invalidar = () => void qc.invalidateQueries({ queryKey: CHAVE });

  const criar = useMutation({
    mutationFn: (input: PainelInput) =>
      apiClient.post<{ data: Painel }>("/api/v1/dados/paineis", input).then((r) => r.data),
    onError: showApiError,
    onSuccess: invalidar,
  });
  const salvar = useMutation({
    mutationFn: (args: { id: string; input: PainelInput }) =>
      apiClient.patch<{ data: Painel }>(`/api/v1/dados/paineis/${args.id}`, args.input).then((r) => r.data),
    onError: showApiError,
    onSuccess: invalidar,
  });
  const apagar = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/v1/dados/paineis/${id}`),
    onError: showApiError,
    onSuccess: invalidar,
  });
  return { lista, criar, salvar, apagar };
}

export function useResultado(w: Widget) {
  const params = new URLSearchParams({
    metrica: w.metrica,
    agrupar_por: w.agrupar_por,
    periodo_dias: String(w.periodo_dias),
  });
  if (w.pipeline_id) params.set("pipeline_id", w.pipeline_id);
  if (w.owner_user_id) params.set("owner_user_id", w.owner_user_id);
  return useQuery({
    queryKey: ["dados", "resultado", params.toString()],
    queryFn: () =>
      apiClient
        .get<{ data: Resultado & { truncado: boolean } }>(`/api/v1/dados/consultar?${params.toString()}`)
        .then((r) => r.data),
    staleTime: 60_000,
  });
}
