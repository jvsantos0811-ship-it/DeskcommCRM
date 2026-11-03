"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { PainelDePassagens } from "@/lib/ai/passagens/painel";

export interface RespostaDoPainelDePassagens extends PainelDePassagens {
  tem_roteador: boolean;
  periodo_dias: number;
}

/** PC-014: o painel de passagens entre agentes (Central). */
export function usePainelDePassagens(dias: 1 | 7 | 30) {
  return useQuery({
    queryKey: ["painel-de-passagens", dias],
    staleTime: 60_000,
    queryFn: async () => {
      const r = await apiClient.get<{ data: RespostaDoPainelDePassagens }>(`/api/v1/ai/passagens?dias=${dias}`, {
        semDesvioDeSuspensao: true,
      });
      return r.data;
    },
  });
}
