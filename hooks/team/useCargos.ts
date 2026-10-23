"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { Cargo, CargoInput } from "@/lib/team/cargos";

const CHAVE = ["team", "cargos"] as const;

export function useCargos(enabled = true) {
  const qc = useQueryClient();
  const invalidar = () => {
    void qc.invalidateQueries({ queryKey: CHAVE });
    void qc.invalidateQueries({ queryKey: ["team", "members"] });
  };

  const lista = useQuery({
    queryKey: CHAVE,
    enabled,
    queryFn: () => apiClient.get<{ data: Cargo[] }>("/api/v1/team/cargos").then((r) => r.data),
  });

  const salvar = useMutation({
    mutationFn: async (args: { id?: string; input: CargoInput }): Promise<void> => {
      if (args.id) await apiClient.patch(`/api/v1/team/cargos/${args.id}`, args.input);
      else await apiClient.post("/api/v1/team/cargos", args.input);
    },
    onError: showApiError,
    onSuccess: invalidar,
  });

  const apagar = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/v1/team/cargos/${id}`),
    onError: showApiError,
    onSuccess: invalidar,
  });

  const aplicar = useMutation({
    mutationFn: (args: { userId: string; cargoId: string | null }) =>
      apiClient.put(`/api/v1/team/${args.userId}/cargo`, { cargo_id: args.cargoId }),
    onError: showApiError,
    onSuccess: invalidar,
  });

  return { lista, salvar, apagar, aplicar };
}
