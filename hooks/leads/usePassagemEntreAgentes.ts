"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface PassagemEntreAgentes {
  id: string;
  origem: "ferramenta" | "roteador" | "equipe";
  de: string | null;
  para: string | null;
  cartao: string | null;
  motivo: string | null;
  created_at: string;
}

/** PC-014: o cartão da passagem mais recente entre agentes, para o card do negócio. */
export function usePassagemEntreAgentes(contactId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["passagem-entre-agentes", contactId],
    enabled: enabled && contactId !== null,
    staleTime: 30_000,
    queryFn: async () => {
      const r = await apiClient.get<{ data: PassagemEntreAgentes | null }>(
        `/api/v1/contacts/${contactId}/passagem-entre-agentes`,
        { semDesvioDeSuspensao: true },
      );
      return r.data;
    },
  });
}
