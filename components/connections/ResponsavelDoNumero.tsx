"use client";

import { useId } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { apiClient } from "@/lib/api/client";

/**
 * O RESPONSÁVEL DO NÚMERO (PC-029). Quando alguém da equipe responde o cliente
 * pelo celular deste número, a IA para e a conversa fica com esta pessoa. Sem
 * ninguém escolhido, a conversa fica sem dono, marcada "Equipe (celular)".
 */
export function ResponsavelDoNumero({ channelId }: { channelId: string }) {
  const t = useT();
  const idDoCampo = useId();
  const qc = useQueryClient();
  const chave = ["channel-responsavel", channelId] as const;
  const atual = useQuery({
    queryKey: chave,
    queryFn: () =>
      apiClient.get<{ data: { responsavel_user_id: string | null } }>(
        `/api/v1/channel-sessions/${channelId}/responsavel`,
      ),
  });
  const membros = useAssignableMembers(true);
  // Resposta fora do formato (rede, sessão vencida) não derruba a tela de Conexões.
  const pessoas = Array.isArray(membros.data) ? membros.data : [];
  const gravar = useMutation({
    mutationFn: (responsavel_user_id: string | null) =>
      apiClient.patch(`/api/v1/channel-sessions/${channelId}/responsavel`, { responsavel_user_id }),
    onSuccess: () => {
      toast.success(t("Responsável do número atualizado."));
      void qc.invalidateQueries({ queryKey: chave });
    },
    onError: showApiError,
  });
  const valor = atual.data?.data?.responsavel_user_id ?? "";

  return (
    <div className="flex flex-col items-start gap-1" data-testid="responsavel-do-numero">
      <Label htmlFor={idDoCampo} className="text-xs">
        {t("Quem fica com a conversa quando alguém responde pelo celular")}
      </Label>
      <select
        id={idDoCampo}
        className="h-8 w-full max-w-xs rounded-md border border-input bg-background px-2 text-xs"
        value={valor}
        disabled={atual.isLoading || gravar.isPending}
        onChange={(e) => gravar.mutate(e.target.value || null)}
        data-testid="responsavel-do-numero-select"
      >
        <option value="">{t("Ninguém (a conversa fica sem dono)")}</option>
        {pessoas.map((m) => (
          <option key={m.user_id} value={m.user_id}>
            {m.full_name ?? t("Atendente")}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        {t('A IA para nessa conversa e só volta quando alguém clicar em "Devolver para a IA".')}
      </p>
    </div>
  );
}
