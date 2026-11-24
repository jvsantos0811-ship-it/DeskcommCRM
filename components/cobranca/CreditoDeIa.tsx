"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { ExtratoDeCredito } from "@/lib/cobranca/credito-ia";
import { formatadorDeData } from "@/lib/cobranca/fuso";
import { linkDePagamentoSeguro } from "@/lib/cobranca/link";
import { abrirNoNavegador } from "@/lib/cobranca/navegar";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";

/**
 * PC-051 — "Crédito de IA extra" em Configurações › Plano e cobrança.
 *
 * O cliente nunca vê dólar nem o custo da IA: o uso do plano e o crédito
 * restante aparecem em PORCENTAGEM, e as compras pelo valor PAGO em reais. Só
 * aparece quando a compra é oferecida (plano que oferece, pacote ativo,
 * assinatura ativa e cadastro de pagamento) ou quando já há compra/cortesia
 * registrada: sem pacote, a tela fica como antes. Nada é cobrado sem o clique.
 */
export function CreditoDeIa({ extrato, fuso }: { extrato: ExtratoDeCredito; fuso: string | null }) {
  const t = useT();
  const idioma = useIdioma();
  const router = useRouter();
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [recado, setRecado] = useState<string | null>(null);
  const brl = new Intl.NumberFormat(idioma, { style: "currency", currency: "BRL" });
  const reais = (centavos: number) => brl.format(centavos / 100);
  const data = formatadorDeData(idioma, fuso, { dateStyle: "short" });
  const dia = (iso: string | null) => (iso === null ? "—" : data.format(new Date(iso)));

  if (extrato.motivoSemOferta !== null && extrato.historico.length === 0) return null;

  async function comprar(pacoteId: string) {
    setOcupado(pacoteId);
    setRecado(null);
    try {
      const { data: r } = await apiClient.post<{ data: { url: string } }>("/api/v1/cobranca/credito-ia/compra", { pacote_id: pacoteId });
      const url = linkDePagamentoSeguro(r.url);
      if (url === null) {
        setRecado(t("O serviço de pagamento devolveu um link inválido. Fale com o suporte."));
        return;
      }
      abrirNoNavegador(url);
    } catch (e) {
      if (e instanceof ApiError && e.code === "sem_cadastro_de_pagamento") {
        setRecado(t("A compra de crédito usa o cadastro de pagamento da assinatura, e esta empresa ainda não tem. Assine o plano pelo CRM ou fale com o suporte."));
      } else if (e instanceof ApiError && (e.code === "provedor_recusou" || e.status === 502 || e.status === 503)) {
        setRecado(t("O serviço de pagamento não respondeu. Nada foi cobrado; tente de novo em alguns minutos."));
      } else {
        showApiError(e);
      }
    } finally {
      setOcupado(null);
    }
  }

  async function jaPaguei() {
    setOcupado("reler");
    setRecado(null);
    try {
      await apiClient.post("/api/v1/cobranca/assinatura/sincronizar", {});
      setRecado(t("Pagamento conferido. Se o crédito ainda não apareceu, o boleto pode levar até 1 dia útil para compensar."));
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(null);
    }
  }

  const ROTULO_DO_STATUS: Record<string, string> = {
    pendente: t("Aguardando pagamento"),
    pago: t("Liberado"),
    cancelado: t("Cancelado"),
  };

  return (
    <Card className="max-w-xl space-y-4 p-6" data-testid="credito-de-ia">
      <header>
        <h2 className="text-sm font-semibold">{t("Crédito de IA extra")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Quando o uso de IA incluído no plano acaba, as conversas vão para a equipe. O crédito comprado libera a IA de novo na hora em que o pagamento é confirmado. O que sobrar vale até o fim do mês seguinte.")}
        </p>
      </header>

      {extrato.mes && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("Uso de IA incluído no plano, neste mês")}</dt>
          <dd className="text-right tabular-nums" data-testid="uso-do-plano">{extrato.mes.uso_do_plano_pct}%</dd>
          {extrato.mes.credito_restante_pct !== null && (
            <>
              <dt className="font-medium">{t("Crédito comprado que ainda resta")}</dt>
              <dd className="text-right font-medium tabular-nums" data-testid="saldo-de-credito">{extrato.mes.credito_restante_pct}%</dd>
            </>
          )}
        </dl>
      )}
      {extrato.mes && (
        <p className="text-xs text-muted-foreground">
          {t("O consumo é primeiro o incluído no plano, depois o crédito comprado mais antigo.")}
        </p>
      )}

      {extrato.pacotes.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t("Comprar crédito")}</h3>
          <ul className="space-y-2">
            {extrato.pacotes.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                <span className="text-sm">
                  {p.nome} · <span className="tabular-nums">{reais(p.preco_cents)}</span>
                </span>
                <Button size="sm" disabled={ocupado !== null} onClick={() => void comprar(p.id)}>
                  {ocupado === p.id ? t("Gerando link…") : t("Comprar")}
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("Pix, cartão ou boleto. Nada é cobrado automaticamente.")}</p>
        </div>
      )}

      {extrato.pendentes.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t("Aguardando pagamento")}</h3>
          <ul className="space-y-2">
            {extrato.pendentes.map((p) => {
              const link = linkDePagamentoSeguro(p.link);
              return (
                <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="tabular-nums">{reais(p.preco_cents)} · {dia(p.criado_em)}</span>
                  {link && (
                    <a className="underline" href={link} target="_blank" rel="noopener noreferrer">
                      {t("Abrir pagamento")}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
          <Button size="sm" variant="outline" disabled={ocupado !== null} onClick={() => void jaPaguei()}>
            {ocupado === "reler" ? t("Conferindo…") : t("Já paguei")}
          </Button>
        </div>
      )}

      {recado && <p className="text-sm" role="status">{recado}</p>}

      {extrato.historico.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t("Histórico de crédito")}</summary>
          <table className="mt-2 w-full text-left text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-1 font-normal">{t("Data")}</th>
                <th className="py-1 font-normal">{t("Origem")}</th>
                <th className="py-1 font-normal">{t("Situação")}</th>
                <th className="py-1 text-right font-normal">{t("Valor")}</th>
                <th className="py-1 text-right font-normal">{t("Vale até")}</th>
              </tr>
            </thead>
            <tbody>
              {extrato.historico.map((h) => (
                <tr key={h.id} className="border-t">
                  <td className="py-1">{dia(h.pago_em ?? h.criado_em)}</td>
                  <td className="py-1">{h.origem === "cortesia" ? t("Cortesia") : t("Compra")}</td>
                  <td className="py-1">{ROTULO_DO_STATUS[h.status] ?? h.status}</td>
                  <td className="py-1 text-right tabular-nums">{h.preco_cents === null ? "—" : reais(h.preco_cents)}</td>
                  <td className="py-1 text-right">{h.vence_em ? dia(new Date(new Date(h.vence_em).getTime() - 1).toISOString()) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Card>
  );
}
