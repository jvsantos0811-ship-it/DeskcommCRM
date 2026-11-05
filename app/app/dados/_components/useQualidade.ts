"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { RespostaDaQualidade } from "@/lib/dados/resposta";

const CHAVE = ["dados", "qualidade"] as const;

/** O que as abas de Dados mostram: o retrato do dia (ou a conta ao vivo de "só os seus"). */
export function useQualidade() {
  return useQuery({
    queryKey: CHAVE,
    queryFn: () => apiClient.get<{ data: RespostaDaQualidade }>("/api/v1/dados/qualidade").then((r) => r.data),
    // O retrato muda uma vez por dia (ou no "Atualizar agora"): sem refetch a cada foco.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export interface RespostaDoAtualizar {
  dia: string;
  gerado_em: string;
  proximo_atualizar_em: string | null;
  leads: number;
}

/** "Atualizar agora" (gerente e administrador): refaz o retrato e relê a tela. */
export function useAtualizarAgora() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient.post<{ data: RespostaDoAtualizar }>("/api/v1/dados/qualidade/atualizar", {}).then((r) => r.data),
    onSettled: () => void qc.invalidateQueries({ queryKey: CHAVE }),
  });
}
