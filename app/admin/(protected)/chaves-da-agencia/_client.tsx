"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import type { ChaveDaAgenciaNaTela } from "@/lib/mcp/agencia/chaves";
import type { PortaDaAgencia } from "@/lib/mcp/agencia/portas";

interface Estado {
  chaves: ChaveDaAgenciaNaTela[];
  organizacoes: { id: string; nome: string }[];
  portas: { porta: PortaDaAgencia; nome: string; caminho: string }[];
  ips_padrao: string[];
}

export function ChavesDaAgenciaClient() {
  const t = useT();
  const queryClient = useQueryClient();
  const consulta = useQuery({
    queryKey: ["admin", "chaves-da-agencia"],
    queryFn: () => apiClient.get<{ data: Estado }>("/api/v1/admin/chaves-da-agencia").then((r) => r.data),
  });
  const estado = consulta.data ?? null;
  const erroAoCarregar = consulta.isError;
  const [ocupado, setOcupado] = useState(false);
  const [porta, setPorta] = useState<PortaDaAgencia>("leitura");
  // Vazio = ainda não escolhido: vale o padrão que veio do servidor.
  const [organizacaoEscolhida, setOrganizacao] = useState("");
  const [ipsDigitados, setIps] = useState<string | null>(null);
  const organizacao = organizacaoEscolhida || estado?.organizacoes[0]?.id || "";
  const ips = ipsDigitados ?? estado?.ips_padrao.join(", ") ?? "";
  const carregar = () => queryClient.invalidateQueries({ queryKey: ["admin", "chaves-da-agencia"] });
  const [textoNovo, setTextoNovo] = useState<{ nome: string; texto: string } | null>(null);

  async function agir(acao: () => Promise<{ data: { chave: ChaveDaAgenciaNaTela; texto?: string } }>, sucesso: string) {
    setOcupado(true);
    try {
      const { data } = await acao();
      if (data.texto) setTextoNovo({ nome: data.chave.name, texto: data.texto });
      toast.success(sucesso);
      await carregar();
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  const criar = () =>
    agir(
      () =>
        apiClient.post("/api/v1/admin/chaves-da-agencia", {
          porta,
          organization_id: organizacao,
          ips: ips
            .split(/[\s,]+/)
            .map((i) => i.trim())
            .filter(Boolean),
        }),
      t("Chave criada."),
    );

  const caminhoDa = (p: PortaDaAgencia) => estado?.portas.find((x) => x.porta === p)?.caminho ?? "";
  const nomeDaOrg = (id: string) => estado?.organizacoes.find((o) => o.id === id)?.nome ?? id;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Chaves da agência")}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {t(
            "Uma chave da agência alcança todas as empresas desta instalação pelo MCP. A de Leitura lê tudo e não altera nada; a de Admin altera a configuração, não lê conversas e nunca envia mensagem. Cada chave só funciona vinda dos IPs da lista.",
          )}
        </p>
      </div>

      {textoNovo && (
        <Card className="space-y-3 border-amber-500/50 p-4" data-testid="chave-da-agencia-texto">
          <p className="text-sm font-medium">
            {t("Copie a chave agora — ela não será mostrada de novo.")} ({textoNovo.nome})
          </p>
          <code className="block break-all rounded-md bg-muted p-2 text-xs">{textoNovo.texto}</code>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                void copyToClipboard(textoNovo.texto);
                toast.success(t("Copiada."));
              }}
            >
              {t("Copiar")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setTextoNovo(null)}>
              {t("Já guardei")}
            </Button>
          </div>
        </Card>
      )}

      <Card className="space-y-4 p-4">
        <h2 className="text-base font-semibold">{t("Criar chave")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="porta">{t("Porta")}</Label>
            <select
              id="porta"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={porta}
              onChange={(e) => setPorta(e.target.value as PortaDaAgencia)}
            >
              <option value="leitura">{t("Leitura (Gestor Comercial)")}</option>
              <option value="admin">{t("Admin (Operador)")}</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="organizacao">{t("Guardar na empresa")}</Label>
            <select
              id="organizacao"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={organizacao}
              onChange={(e) => setOrganizacao(e.target.value)}
            >
              {estado?.organizacoes.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.nome}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="ips">{t("IPs permitidos")}</Label>
            <Input id="ips" value={ips} onChange={(e) => setIps(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              {t("O padrão é a faixa de saída da Anthropic, de onde o Claude chama o MCP.")}
            </p>
          </div>
        </div>
        <Button onClick={criar} disabled={ocupado || !organizacao || porta === "admin"}>
          {t("Criar chave")}
        </Button>
        {porta === "admin" && (
          <p className="text-xs text-muted-foreground">{t("A porta Admin chega na próxima versão.")}</p>
        )}
      </Card>

      {erroAoCarregar ? (
        <div className="rounded-lg border py-12 text-center text-sm text-muted-foreground">
          {t("Erro ao carregar as chaves. Tente recarregar.")}
        </div>
      ) : (
        <div className="space-y-3">
          {estado?.chaves.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("Nenhuma chave da agência ainda.")}</p>
          )}
          {estado?.chaves.map((c) => (
            <Card key={c.id} className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="chave-da-agencia">
              <div className="space-y-1 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  <Badge variant={c.revoked_at ? "secondary" : "default"}>
                    {c.revoked_at ? t("Revogada") : t("Ativa")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {c.prefix}… · {caminhoDa(c.porta)} · {nomeDaOrg(c.organization_id)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("IPs")}: {c.ips_permitidos.join(", ")} · {t("Último uso")}:{" "}
                  {c.last_used_at ? new Date(c.last_used_at).toLocaleString() : t("nunca")}
                </p>
              </div>
              {!c.revoked_at && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={ocupado}
                    onClick={() =>
                      agir(() => apiClient.post(`/api/v1/admin/chaves-da-agencia/${c.id}/trocar`, {}), t("Chave trocada."))
                    }
                  >
                    {t("Trocar")}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={ocupado}
                    onClick={() =>
                      agir(() => apiClient.post(`/api/v1/admin/chaves-da-agencia/${c.id}/revogar`, {}), t("Chave revogada."))
                    }
                  >
                    {t("Revogar agora")}
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
