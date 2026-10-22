"use client";
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
import type { MensagemDaEquipe, SalaResumo } from "@/lib/team-chat/salas";

export const CHAVE_SALAS = ["team-chat", "rooms"] as const;
export const chaveDaSala = (room: string | null) => ["team-chat", "messages", room] as const;

/**
 * As salas do chat interno, com a contagem de não lidas — a mesma consulta
 * serve o sino do topo e a tela do chat.
 *
 * Fica ao vivo por UM canal de Realtime por organização, em
 * `team_chat_messages`: a RLS da tabela já restringe a conversa a dois aos
 * dois participantes, então o socket de terceiro nunca recebe a linha. O
 * `refetchInterval` de 60s é a rede de segurança para o canal que morreu sem
 * avisar — silêncio e "ninguém escreveu" têm a mesma cara.
 */
export function useSalasDoChat(enabled = true) {
  const { activeOrg } = useAuth();
  const qc = useQueryClient();
  const orgId = activeOrg?.orgId ?? null;

  const consulta = useQuery({
    queryKey: [...CHAVE_SALAS, orgId],
    enabled: enabled && !!orgId,
    queryFn: () =>
      apiClient
        .get<{ data: { salas: SalaResumo[]; total_nao_lidas: number } }>("/api/v1/team-chat/rooms")
        .then((r) => r.data),
    refetchInterval: 60_000,
    staleTime: 15_000,
  });

  const onChange = useCallback(
    (payload: unknown) => {
      const nova = (payload as { new?: MensagemDaEquipe } | null)?.new;
      qc.invalidateQueries({ queryKey: CHAVE_SALAS });
      if (nova?.room) qc.invalidateQueries({ queryKey: chaveDaSala(nova.room) });
    },
    [qc],
  );

  useRealtimeChannel({
    name: orgId ? `team-chat-${orgId}` : "team-chat-disabled",
    postgresChanges: orgId
      ? { event: "INSERT", schema: "public", table: "team_chat_messages", filter: `organization_id=eq.${orgId}` }
      : undefined,
    onChange,
    enabled: enabled && !!orgId,
  });

  return consulta;
}

/** As mensagens de uma sala, enviar e marcar como lida. */
export function useSalaDoChat(room: string | null) {
  const qc = useQueryClient();

  const mensagens = useQuery({
    queryKey: chaveDaSala(room),
    enabled: !!room,
    queryFn: () =>
      apiClient
        .get<{ data: MensagemDaEquipe[]; meta?: { has_more?: boolean } }>(
          `/api/v1/team-chat/messages?room=${encodeURIComponent(room ?? "")}`,
        )
        .then((r) => r.data),
  });

  const enviar = useMutation({
    mutationFn: (body: string) =>
      apiClient.post<{ data: MensagemDaEquipe }>("/api/v1/team-chat/messages", { room, body }),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chaveDaSala(room) });
      qc.invalidateQueries({ queryKey: CHAVE_SALAS });
    },
  });

  const marcarLida = useMutation({
    mutationFn: (sala: string) => apiClient.post("/api/v1/team-chat/read", { room: sala }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE_SALAS }),
  });

  return { mensagens, enviar, marcarLida };
}
