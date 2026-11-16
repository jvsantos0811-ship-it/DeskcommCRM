"use client";
import { useEffect, useState } from "react";

import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { TemplatesParceiroClient } from "./TemplatesParceiroClient";

/**
 * Os modelos do parceiro, de UM número de cada vez.
 *
 * Com um número só (ou sem acesso à lista de números), é exatamente a tela de
 * antes: `<TemplatesParceiroClient />` na rota padrão, que resolve o número
 * principal. Com dois, aparece a escolha do número, e a rota recebe
 * `?channel_session_id=` — cada número tem a sua lista, porque o espelho grava
 * de qual conexão veio cada modelo (migration 0144).
 */
interface NumeroResumo {
  channel_session_id: string;
  display_name: string | null;
  phone_number: string | null;
}

export function ModelosDoParceiroPorNumero() {
  const t = useT();
  const [numeros, setNumeros] = useState<NumeroResumo[]>([]);
  const [escolhido, setEscolhido] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    void apiClient
      .get<{ data: { numbers?: NumeroResumo[] } }>("/api/v1/channels/partner")
      .then((r) => {
        if (vivo) setNumeros(Array.isArray(r.data.numbers) ? r.data.numbers : []);
      })
      // Sem a lista (papel sem acesso, falha de rede), a tela de sempre segue servindo.
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, []);

  const principal = numeros[0];
  if (numeros.length < 2 || !principal) return <TemplatesParceiroClient />;

  const atual = escolhido ?? principal.channel_session_id;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="modelos-do-parceiro-numero">{t("Número")}</Label>
        <select
          id="modelos-do-parceiro-numero"
          className="h-8 w-full max-w-xs rounded-md border border-input bg-background px-2 text-xs"
          value={atual}
          onChange={(e) => setEscolhido(e.target.value)}
          data-testid="modelos-do-parceiro-numero"
        >
          {numeros.map((n) => (
            <option key={n.channel_session_id} value={n.channel_session_id}>
              {[n.display_name, n.phone_number].filter(Boolean).join(" · ") || n.channel_session_id}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {t("Cada número tem os seus modelos. Escolha de qual número quer ver, sincronizar ou criar.")}
        </p>
      </div>
      {/* A chave pelo número: trocar de número começa a tela do zero, sem
          levar um rascunho de modelo de um número para o outro. */}
      <TemplatesParceiroClient
        key={atual}
        rota={`/api/v1/channels/partner/templates?channel_session_id=${encodeURIComponent(atual)}`}
      />
    </div>
  );
}
