"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export type StatusDoRegistro =
  | "sem_resposta"
  | "respondida"
  | "recusada"
  | "concedida"
  | "negada"
  | "pendente"
  | "cumprida"
  | "vencida";

export interface ItemDoRegistroDaConversa {
  id: string;
  tipo: "pergunta" | "licenca" | "promessa";
  tema: string;
  status: StatusDoRegistro;
  resposta: string | null;
  prazo: string | null;
  vezes: number;
  quando: string;
}

/** PC-019: o registro da conversa do contato, para o bloco "Conversa até aqui" do card. */
export function useRegistroDaConversa(contactId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["registro-da-conversa", contactId],
    enabled: enabled && contactId !== null,
    staleTime: 30_000,
    queryFn: async () => {
      const r = await apiClient.get<{ data: { itens: ItemDoRegistroDaConversa[] } }>(
        `/api/v1/contacts/${contactId}/registro-da-conversa`,
        { semDesvioDeSuspensao: true },
      );
      return r.data.itens;
    },
  });
}
