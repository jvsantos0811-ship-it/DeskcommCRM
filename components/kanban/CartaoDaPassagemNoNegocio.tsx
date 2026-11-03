"use client";
import { useT } from "@/hooks/i18n/useT";
import { usePassagemEntreAgentes } from "@/hooks/leads/usePassagemEntreAgentes";

interface Props {
  contactId: string | null;
  aberto: boolean;
}

/**
 * PC-014: o cartão da passagem entre agentes, FIXO no card do negócio — logo
 * abaixo do contato, sempre o mais recente. É o mesmo texto que o agente de
 * destino lê ao chegar: quem passou, para quem, e o cartão no formato fixo (ou a
 * linha que a pessoa da equipe escreveu ao devolver para a IA). Sem passagem,
 * não aparece.
 */
export function CartaoDaPassagemNoNegocio({ contactId, aberto }: Props) {
  const t = useT();
  const { data } = usePassagemEntreAgentes(contactId, aberto);
  if (!data) return null;
  const quando = new Date(data.created_at);
  const hora = Number.isNaN(quando.getTime())
    ? ""
    : quando.toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const titulo =
    data.origem === "equipe"
      ? t("A equipe devolveu para a IA")
      : `${data.de ?? t("Outro agente")} → ${data.para ?? t("outro agente")}`;
  return (
    <section className="border-b border-border py-3" data-testid="cartao-da-passagem">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
        {t("Cartão da passagem")}
      </h3>
      <div className="rounded-md border border-border bg-surface-elevated p-2 text-sm">
        <p className="font-medium">{titulo}</p>
        {data.origem === "equipe" && data.para ? (
          <p className="text-xs text-text-muted">
            {t("Agente")}: {data.para}
          </p>
        ) : null}
        {hora ? <p className="text-xs text-text-muted">{hora}</p> : null}
        {data.cartao ? <p className="mt-2 whitespace-pre-line">{data.cartao}</p> : null}
      </div>
    </section>
  );
}
