"use client";
/**
 * A lista de "Valor por tipo de lead" (v3, seção 1.1): criar um tipo, mudar o
 * valor médio, marcar "confirmado pelo cliente" e desativar. A escrita vai por
 * `/api/v1/tipos-de-lead` (manager+); quem não edita vê a mesma lista, travada.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { formatCents } from "@/lib/money";
import { precoParaCentavos } from "@/lib/schemas/produtos";
import type { TipoDeLeadNaTela } from "@/lib/schemas/tipos-de-lead";

/** 150000 → "1500,00": o formato que `precoParaCentavos` lê de volta. */
function centavosParaTexto(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

interface Props {
  inicial: TipoDeLeadNaTela[];
  podeEditar: boolean;
}

export function TiposDeLeadClient({ inicial, podeEditar }: Props) {
  const t = useT();
  const router = useRouter();
  const [tipos, setTipos] = useState(inicial);
  const [nome, setNome] = useState("");
  const [categoria, setCategoria] = useState("");
  const [valor, setValor] = useState("");
  const [confirmado, setConfirmado] = useState(false);
  const [isPending, startTransition] = useTransition();

  function mensagemDoErro(e: unknown): string {
    if (e instanceof ApiError && e.code === "conflict") return t("Já existe um tipo de lead com esse nome.");
    if (e instanceof ApiError && e.status === 403) return t("Só gerente ou administrador muda os tipos de lead.");
    return t("Não consegui salvar.");
  }

  function criar(e: React.FormEvent) {
    e.preventDefault();
    const preco_cents = precoParaCentavos(valor);
    if (preco_cents === null) {
      toast.error(t("Valor inválido. Escreva assim: 1.500,00"));
      return;
    }
    startTransition(async () => {
      try {
        const r = await apiClient.post<{ data: TipoDeLeadNaTela }>("/api/v1/tipos-de-lead", {
          nome: nome.trim(),
          ...(categoria.trim() ? { categoria: categoria.trim() } : {}),
          preco_cents,
          valor_confirmado: confirmado,
        });
        setTipos((atual) => [...atual, r.data].sort((a, b) => a.nome.localeCompare(b.nome)));
        setNome("");
        setCategoria("");
        setValor("");
        setConfirmado(false);
        toast.success(t("Tipo de lead criado."));
        router.refresh();
      } catch (err) {
        toast.error(mensagemDoErro(err));
      }
    });
  }

  function atualizar(id: string, patch: Partial<TipoDeLeadNaTela>) {
    startTransition(async () => {
      try {
        const r = await apiClient.patch<{ data: TipoDeLeadNaTela }>(`/api/v1/tipos-de-lead/${id}`, patch);
        setTipos((atual) => atual.map((x) => (x.id === id ? r.data : x)));
        toast.success(t("Tipo de lead salvo."));
      } catch (err) {
        toast.error(mensagemDoErro(err));
      }
    });
  }

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      {podeEditar ? (
        <Card className="p-4">
          <form onSubmit={criar} className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_auto_auto] md:items-end" data-testid="novo-tipo-de-lead">
            <div className="space-y-1">
              <Label htmlFor="tipo-de-lead-nome" className="block text-xs">
                {t("Tipo de lead")}
              </Label>
              <Input
                id="tipo-de-lead-nome"
                value={nome}
                maxLength={120}
                placeholder={t("Ex.: Auxílio-acidente")}
                onChange={(e) => setNome(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tipo-de-lead-categoria" className="block text-xs">
                {t("Categoria")}
              </Label>
              <Input
                id="tipo-de-lead-categoria"
                value={categoria}
                maxLength={80}
                onChange={(e) => setCategoria(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tipo-de-lead-valor" className="block text-xs">
                {t("Valor médio")}
              </Label>
              <Input
                id="tipo-de-lead-valor"
                value={valor}
                inputMode="decimal"
                placeholder="1.500,00"
                onChange={(e) => setValor(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={confirmado} onChange={(e) => setConfirmado(e.target.checked)} />
              {t("Confirmado pelo cliente")}
            </label>
            <Button type="submit" disabled={isPending || nome.trim().length < 2 || valor.trim() === ""}>
              {t("Adicionar")}
            </Button>
          </form>
        </Card>
      ) : (
        <p className="text-xs text-muted-foreground">{t("Só gerente ou administrador muda os tipos de lead.")}</p>
      )}

      <Card className="p-0">
        {tipos.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {t("Nenhum tipo de lead ainda. Cadastre o primeiro acima.")}
          </p>
        ) : (
          <table className="w-full text-left text-sm" data-testid="tipos-de-lead-lista">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t("Tipo de lead")}</th>
                <th className="px-4 py-2 font-medium">{t("Valor médio")}</th>
                <th className="px-4 py-2 font-medium">{t("Confirmado pelo cliente")}</th>
                <th className="px-4 py-2 font-medium">{t("Ativo")}</th>
              </tr>
            </thead>
            <tbody>
              {tipos.map((tipo) => (
                <LinhaDoTipo
                  key={`${tipo.id}-${tipo.preco_cents}`}
                  tipo={tipo}
                  podeEditar={podeEditar}
                  ocupado={isPending}
                  aoMudar={(patch) => atualizar(tipo.id, patch)}
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function LinhaDoTipo({
  tipo,
  podeEditar,
  ocupado,
  aoMudar,
}: {
  tipo: TipoDeLeadNaTela;
  podeEditar: boolean;
  ocupado: boolean;
  aoMudar: (patch: Partial<TipoDeLeadNaTela>) => void;
}) {
  const t = useT();
  const [texto, setTexto] = useState(centavosParaTexto(tipo.preco_cents));
  const sujo = precoParaCentavos(texto) !== tipo.preco_cents;

  function salvarValor() {
    const preco_cents = precoParaCentavos(texto);
    if (preco_cents === null) {
      toast.error(t("Valor inválido. Escreva assim: 1.500,00"));
      return;
    }
    aoMudar({ preco_cents });
  }

  return (
    <tr className="border-t border-border" data-testid="tipo-de-lead-linha" data-nome={tipo.nome}>
      <td className="px-4 py-2">
        <span className="font-medium">{tipo.nome}</span>
        {tipo.categoria ? <span className="block text-xs text-muted-foreground">{tipo.categoria}</span> : null}
      </td>
      <td className="px-4 py-2">
        {podeEditar ? (
          <div className="flex items-center gap-2">
            <Input
              aria-label={`${t("Valor médio")} — ${tipo.nome}`}
              data-testid="tipo-de-lead-valor"
              className="h-8 w-32"
              value={texto}
              inputMode="decimal"
              onChange={(e) => setTexto(e.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!sujo || ocupado}
              data-testid="tipo-de-lead-salvar-valor"
              onClick={salvarValor}
            >
              {t("Salvar")}
            </Button>
          </div>
        ) : (
          <span className="tabular-nums" data-testid="tipo-de-lead-valor-texto">
            {formatCents(tipo.preco_cents, tipo.moeda)}
          </span>
        )}
      </td>
      <td className="px-4 py-2">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            data-testid="tipo-de-lead-confirmado"
            checked={tipo.valor_confirmado}
            disabled={!podeEditar || ocupado}
            onChange={(e) => aoMudar({ valor_confirmado: e.target.checked })}
          />
          {tipo.valor_confirmado ? t("Sim") : t("Não")}
        </label>
      </td>
      <td className="px-4 py-2">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={tipo.ativo}
            disabled={!podeEditar || ocupado}
            aria-label={`${t("Ativo")} — ${tipo.nome}`}
            onChange={(e) => aoMudar({ ativo: e.target.checked })}
          />
        </label>
      </td>
    </tr>
  );
}
