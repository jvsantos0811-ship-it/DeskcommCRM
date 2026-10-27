"use client";
/**
 * Os contratos de um negócio e as três ações sobre eles (fork, migration 9008):
 * anexar o PDF, enviar ao cliente e marcar o desfecho.
 *
 * Anexar e decidir sobem arquivo, então vão por `fetch` com `FormData` (o
 * `apiClient` só fala JSON) — levando o mesmo cabeçalho da organização da aba
 * que o `apiClient` põe em toda escrita. Enviar é JSON e vai pelo `apiClient`,
 * que já manda `Idempotency-Key`: o clique repetido não manda o contrato duas
 * vezes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { ApiError, type ApiErrorBody } from "@/lib/api/types";
import { HEADER_ORG_DA_ABA, orgDaAba } from "@/lib/auth/org-da-aba";
import type { ContratoDoNegocio } from "@/lib/contratos/tipos";
import type { DesfechoDoContrato } from "@/lib/contratos/vocabulario";

export function chaveDosContratos(leadId: string) {
  return ["contratos", "por-lead", leadId] as const;
}

async function enviarFormulario(url: string, form: FormData): Promise<ContratoDoNegocio> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const aba = orgDaAba();
  if (aba?.orgId) headers[HEADER_ORG_DA_ABA] = aba.orgId;
  const res = await fetch(url, { method: "POST", body: form, headers });
  const json = (await res.json().catch(() => ({}))) as Partial<ApiErrorBody> & { data?: ContratoDoNegocio };
  if (!res.ok || !json.data) {
    const e = json.error;
    throw new ApiError(res.status, e?.code ?? "request_failed", e?.details, e?.request_id ?? "", e?.message);
  }
  return json.data;
}

export function useContratosDoLead(leadId: string, enabled = true) {
  const qc = useQueryClient();
  const chave = chaveDosContratos(leadId);

  const lista = useQuery({
    queryKey: chave,
    queryFn: async () => apiClient.get<{ data: ContratoDoNegocio[] }>(`/api/v1/leads/${leadId}/contracts`),
    enabled,
    select: (res) => res.data,
  });

  const recarregar = () => qc.invalidateQueries({ queryKey: chave });

  const anexar = useMutation({
    mutationFn: async (args: { arquivo: File; titulo: string }) => {
      const form = new FormData();
      form.append("file", args.arquivo, args.arquivo.name);
      form.append("titulo", args.titulo);
      return enviarFormulario(`/api/v1/leads/${leadId}/contracts`, form);
    },
    onSuccess: recarregar,
    onError: (err) => showApiError(err),
  });

  const enviar = useMutation({
    mutationFn: async (args: { contratoId: string; mensagem: string }) =>
      (
        await apiClient.post<{ data: ContratoDoNegocio }>(
          `/api/v1/contracts/${args.contratoId}/send`,
          args.mensagem.trim() ? { mensagem: args.mensagem.trim() } : {},
          { timeoutMs: 60_000 },
        )
      ).data,
    onSettled: recarregar,
    onError: (err) => showApiError(err),
  });

  const decidir = useMutation({
    mutationFn: async (args: {
      contratoId: string;
      desfecho: DesfechoDoContrato;
      motivo: string;
      viaAssinada: File | null;
    }) => {
      const form = new FormData();
      form.append("desfecho", args.desfecho);
      if (args.motivo.trim()) form.append("motivo", args.motivo.trim());
      if (args.viaAssinada) form.append("file", args.viaAssinada, args.viaAssinada.name);
      return enviarFormulario(`/api/v1/contracts/${args.contratoId}/decide`, form);
    },
    onSettled: recarregar,
    onError: (err) => showApiError(err),
  });

  return { lista, anexar, enviar, decidir };
}
