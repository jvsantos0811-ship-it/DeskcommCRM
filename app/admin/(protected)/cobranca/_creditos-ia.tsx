"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";
import { cortesiaDeCreditoSchema, novoPacoteDeCreditoSchema } from "@/lib/schemas/cobranca-plano";

/** Um pacote de `cobranca_pacotes_credito_ia` como a tela o recebe (COLUNAS_DO_PACOTE). */
export interface PacoteDaTela {
  id: string;
  nome: string;
  preco_cents: number;
  ia_usd_cents: number;
  arquivado_em: string | null;
}

const centavos = (v: string) => Math.round(Number(v.replace(",", ".")) * 100);

/**
 * PC-051 — crédito de IA da instalação, na aba Planos: os pacotes que as
 * empresas compram quando o teto de IA do plano acaba (preço em reais, quanto
 * de IA libera em dólar) e a cortesia com motivo. Quem oferece a compra é cada
 * PLANO ("Vender crédito de IA"); sem pacote ativo, ninguém vê a compra.
 */
export function CreditosDeIaDaInstalacao({
  pacotes,
  empresas,
}: {
  pacotes: readonly PacoteDaTela[];
  empresas: ReadonlyArray<{ id: string; nome: string }>;
}) {
  const t = useT();
  const idioma = useIdioma();
  const router = useRouter();
  const brl = new Intl.NumberFormat(idioma, { style: "currency", currency: "BRL" });
  const usd = new Intl.NumberFormat(idioma, { style: "currency", currency: "USD" });
  const [nome, setNome] = useState("");
  const [preco, setPreco] = useState("");
  const [ia, setIa] = useState("");
  const [empresa, setEmpresa] = useState("");
  const [iaCortesia, setIaCortesia] = useState("");
  const [motivo, setMotivo] = useState("");
  const [salvando, setSalvando] = useState(false);

  async function criarPacote(e: FormEvent) {
    e.preventDefault();
    const corpo = { nome: nome.trim(), preco_cents: centavos(preco), ia_usd_cents: centavos(ia) };
    if (!novoPacoteDeCreditoSchema.safeParse(corpo).success) {
      toast.error(t("Confira o pacote: nome, preço a partir de R$ 5,00 e IA a partir de US$ 1,00."));
      return;
    }
    setSalvando(true);
    try {
      await apiClient.post("/api/v1/admin/cobranca/creditos-ia/pacotes", corpo);
      toast.success(t("Pacote salvo."));
      setNome("");
      setPreco("");
      setIa("");
      router.refresh();
    } catch (err) {
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  async function arquivar(p: PacoteDaTela) {
    try {
      await apiClient.patch(`/api/v1/admin/cobranca/creditos-ia/pacotes/${p.id}`, { arquivado: !p.arquivado_em });
      router.refresh();
    } catch (err) {
      showApiError(err);
    }
  }

  async function darCortesia(e: FormEvent) {
    e.preventDefault();
    const corpo = { organization_id: empresa, ia_usd_cents: centavos(iaCortesia), motivo: motivo.trim() };
    if (!cortesiaDeCreditoSchema.safeParse(corpo).success) {
      toast.error(t("Confira a cortesia: escolha a empresa, IA a partir de US$ 1,00 e um motivo."));
      return;
    }
    setSalvando(true);
    try {
      await apiClient.post("/api/v1/admin/cobranca/creditos-ia/cortesia", corpo);
      toast.success(t("Cortesia registrada. O crédito já vale."));
      setIaCortesia("");
      setMotivo("");
    } catch (err) {
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <section className="mt-8 space-y-4" aria-label={t("Crédito de IA")}>
      <header>
        <h3 className="text-sm font-semibold">{t("Crédito de IA")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("Quando o teto de IA do plano acaba, a empresa pode comprar um pacote em Plano e cobrança, se o plano dela vende crédito. O crédito entra só com o pagamento confirmado e vale até o fim do mês seguinte. A empresa vê tudo em reais.")}
        </p>
      </header>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_1fr]">
        <form onSubmit={criarPacote} className="space-y-3 rounded-lg border p-4" aria-label={t("Novo pacote de crédito")}>
          <h4 className="text-sm font-semibold">{t("Novo pacote de crédito")}</h4>
          <div className="space-y-1">
            <Label htmlFor="pacote-nome">{t("Nome do pacote")}</Label>
            <Input id="pacote-nome" maxLength={60} value={nome} onChange={(e) => setNome(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="pacote-preco">{t("Preço do pacote (R$)")}</Label>
              <Input id="pacote-preco" inputMode="decimal" value={preco} onChange={(e) => setPreco(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pacote-ia">{t("IA liberada pelo pacote (US$)")}</Label>
              <Input id="pacote-ia" inputMode="decimal" value={ia} onChange={(e) => setIa(e.target.value)} />
            </div>
          </div>
          <Button type="submit" disabled={salvando}>{t("Salvar pacote")}</Button>
        </form>

        <div className="space-y-2">
          {pacotes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Nenhum pacote ainda: sem pacote, o teto do plano bloqueia como sempre e ninguém vê a compra.")}</p>
          ) : (
            <ul className="space-y-2">
              {pacotes.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                  <span>
                    <span className="font-medium">{p.nome}</span>
                    {p.arquivado_em && <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs">{t("Arquivado")}</span>}
                    <span className="block text-muted-foreground">
                      {brl.format(p.preco_cents / 100)} · {t("IA")}: {usd.format(p.ia_usd_cents / 100)}
                    </span>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void arquivar(p)}>
                    {p.arquivado_em ? t("Desarquivar") : t("Arquivar")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <form onSubmit={darCortesia} className="max-w-xl space-y-3 rounded-lg border p-4" aria-label={t("Cortesia de crédito")}>
        <h4 className="text-sm font-semibold">{t("Cortesia de crédito")}</h4>
        <div className="space-y-1">
          <Label htmlFor="cortesia-empresa">{t("Empresa")}</Label>
          <select
            id="cortesia-empresa"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={empresa}
            onChange={(e) => setEmpresa(e.target.value)}
          >
            <option value="">{t("Escolha a empresa")}</option>
            {empresas.map((o) => (
              <option key={o.id} value={o.id}>{o.nome}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="cortesia-ia">{t("IA liberada na cortesia (US$)")}</Label>
            <Input id="cortesia-ia" inputMode="decimal" value={iaCortesia} onChange={(e) => setIaCortesia(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cortesia-motivo">{t("Motivo")}</Label>
            <Input id="cortesia-motivo" maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          </div>
        </div>
        <Button type="submit" variant="outline" disabled={salvando}>{t("Dar cortesia")}</Button>
      </form>
    </section>
  );
}
