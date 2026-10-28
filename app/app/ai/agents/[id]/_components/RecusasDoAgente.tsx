"use client";
/**
 * RECUSAS E BLOQUEIOS do agente (PC-002b e PC-003) — a segunda metade da aba
 * Execuções. A tabela de execuções mostra que o modelo foi chamado; esta mostra
 * o que o SISTEMA barrou: a mensagem inteira vetada por uma trava (e a frase
 * segura que saiu no lugar), a etapa recusada por campo vazio, o ganho
 * recusado. Fonte: `recusas_da_ia` (migration 9010), pela rota
 * `GET /api/v1/ai/agents/:id/recusas`.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

interface Recusa {
  id: string;
  tipo: "envio_bloqueado" | "etapa_recusada" | "ganho_recusado" | "assinatura_recusada";
  ferramenta: string | null;
  trava: string | null;
  codigo: string | null;
  etapa_pedida: string | null;
  campos_faltantes: Array<{ chave: string; rotulo: string }> | null;
  motivo: string | null;
  created_at: string;
}

export const recusasDoAgenteKey = (agentId: string) => ["ai", "agents", agentId, "recusas"] as const;

export function RecusasDoAgente({ agentId, active }: { agentId: string; active: boolean }) {
  const t = useT();
  const q = useQuery({
    queryKey: recusasDoAgenteKey(agentId),
    enabled: active,
    queryFn: async () =>
      (await apiClient.get<{ data: Recusa[] }>(`/api/v1/ai/agents/${agentId}/recusas?limit=50`)).data,
  });

  function rotuloDoTipo(tipo: Recusa["tipo"]): string {
    if (tipo === "envio_bloqueado") return t("Mensagem barrada");
    if (tipo === "etapa_recusada") return t("Etapa recusada");
    if (tipo === "ganho_recusado") return t("Ganho recusado");
    return t("Assinatura recusada");
  }

  return (
    <section className="mt-6 space-y-2" data-testid="recusas-do-agente">
      <div>
        <h3 className="text-sm font-semibold">{t("Recusas e bloqueios")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "O que o sistema barrou: mensagens vetadas por uma trava (o cliente recebeu a frase segura), etapas recusadas por campo vazio e ganhos recusados.",
          )}
        </p>
      </div>
      {q.isLoading ? (
        <p className="text-xs text-muted-foreground">{t("Carregando…")}</p>
      ) : q.isError ? (
        <p className="text-xs text-destructive">{t("Não consegui carregar as recusas.")}</p>
      ) : !q.data || q.data.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="recusas-vazio">
          {t("Nenhuma recusa ou bloqueio registrado.")}
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60 text-xs">
          {q.data.map((r) => (
            <li key={r.id} className="space-y-1 p-2" data-testid="recusa-linha">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{rotuloDoTipo(r.tipo)}</span>
                {r.trava ? <span className="font-mono text-muted-foreground">{r.trava}</span> : null}
                {r.ferramenta ? (
                  <span className="font-mono text-muted-foreground">{r.ferramenta}</span>
                ) : null}
                <span className="ml-auto text-muted-foreground">
                  {new Date(r.created_at).toLocaleString()}
                </span>
              </div>
              {r.motivo ? <p>{r.motivo}</p> : null}
              {r.campos_faltantes && r.campos_faltantes.length > 0 ? (
                <p className="text-muted-foreground">
                  {t("Campos que faltaram:")} {r.campos_faltantes.map((c) => c.rotulo).join(", ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
