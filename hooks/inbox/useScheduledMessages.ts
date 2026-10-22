"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { MensagemAgendada } from "@/lib/inbox/mensagens-agendadas";

const chave = (conversationId: string | null) => ["scheduled-messages", conversationId] as const;

/**
 * As mensagens agendadas de UMA conversa: listar, agendar e cancelar.
 *
 * A lista recarrega a cada minuto enquanto há alguma pendente — é o ritmo do
 * cron que as envia, e é o que faz o "Agendada para 9h" virar "Enviada" na
 * tela sem o atendente recarregar.
 */
export function useScheduledMessages(conversationId: string | null) {
  const qc = useQueryClient();

  const lista = useQuery({
    queryKey: chave(conversationId),
    enabled: !!conversationId,
    queryFn: () =>
      apiClient
        .get<{ data: MensagemAgendada[] }>(`/api/v1/conversations/${conversationId}/scheduled-messages`)
        .then((r) => r.data),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((m) => m.status === "scheduled" || m.status === "sending") ? 60_000 : false,
  });

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: chave(conversationId) });
  };

  const agendar = useMutation({
    mutationFn: (args: { body: string; send_at: string }) =>
      apiClient.post<{ data: MensagemAgendada }>(
        `/api/v1/conversations/${conversationId}/scheduled-messages`,
        args,
      ),
    onError: showApiError,
    onSuccess: invalidar,
  });

  const cancelar = useMutation({
    mutationFn: (id: string) => apiClient.delete<{ data: MensagemAgendada }>(`/api/v1/scheduled-messages/${id}`),
    onError: showApiError,
    onSuccess: invalidar,
  });

  return { lista, agendar, cancelar };
}
