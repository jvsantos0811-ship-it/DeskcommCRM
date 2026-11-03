"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface AgenteParaDevolver {
  id: string;
  nome: string;
  intencao: string | null;
}

interface Resposta {
  data: { tem_roteador: boolean; agentes: AgenteParaDevolver[] };
}

/**
 * PC-014: os agentes do roteador do número desta conversa. Com roteador, o
 * "Devolver" abre o diálogo para escolher o agente e escrever o que foi feito.
 * Leitura ambiente (o botão está à vista): não desvia a página se a organização
 * estiver suspensa.
 */
export function useAgentesParaDevolver(conversationId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["agentes-para-devolver", conversationId],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await apiClient.get<Resposta>(
        `/api/v1/conversations/${conversationId}/agentes-para-devolver`,
        { semDesvioDeSuspensao: true },
      );
      return r.data;
    },
  });
}
