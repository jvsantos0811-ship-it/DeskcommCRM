"use client";

import { usePreferenciaDoNavegador } from "@/hooks/ui/usePreferenciaDoNavegador";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { formatDistanceToNowStrict } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { ArrowsClockwise, CaretDown, CaretUp, Scales, ShieldCheck } from "@/lib/ui/icons";
import { retentionCopy, type RetentionKind } from "@/lib/inbox/retention-copy";
import { useRetention } from "@/hooks/inbox/useRetention";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<RetentionKind, typeof ShieldCheck> = {
  protection: ShieldCheck,
  compliance: Scales,
  quality: ArrowsClockwise,
};

const KIND_CLASS: Record<RetentionKind, string> = {
  protection: "border-warning bg-warning-bg text-warning-fg",
  compliance: "border-destructive/40 bg-destructive/10 text-destructive",
  quality: "border-border bg-muted/40 text-muted-foreground",
};

/** Onde fica guardado qual alerta a pessoa já recolheu nesta conversa. */
const chaveDoRecolhido = (conversationId: string) => `inbox:conformidade-recolhida:${conversationId}`;

/**
 * Aviso de transparência do anti-ban (Operação Visível F2-i): quando a cadeia
 * before_send reteve a resposta do assistente nas últimas 24h, mostra o MOTIVO
 * traduzido em pt-br leigo acima do composer. Sem veto recente → não renderiza.
 *
 * FAIXA DE UMA LINHA, RECOLHÍVEL (PC-011). Aberta, é uma linha com o motivo
 * (o texto inteiro no `title`); recolhida, só o ícone e o título curto — ela
 * NUNCA some por completo. O que se guarda é QUAL alerta foi recolhido: quando
 * chega um alerta novo (outro `id`), a faixa reabre sozinha, porque um opt-out
 * novo não pode ficar escondido atrás de um gesto feito para o anterior.
 *
 * No modo foco a faixa recolhida sai da frente; a aberta (alerta novo) fica.
 */
export function RetentionNotice({
  conversationId,
  modoFoco = false,
}: {
  conversationId: string;
  modoFoco?: boolean;
}) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const { data } = useRetention(conversationId);
  const [recolhidoId, gravarRecolhido] = usePreferenciaDoNavegador(chaveDoRecolhido(conversationId));
  const latest = data?.retentions[0];
  if (!latest || !data) return null;

  const copy = retentionCopy(latest.vetoed_code, data.context, t);
  const Icon = KIND_ICON[copy.kind];
  const when = formatDistanceToNowStrict(new Date(latest.created_at), {
    addSuffix: true,
    locale: localeDaData,
  });
  const recolhida = recolhidoId === latest.id;
  if (recolhida && modoFoco) return null;

  const alternar = () => gravarRecolhido(recolhida ? null : latest.id);

  return (
    <div
      data-testid="retention-notice"
      data-recolhida={recolhida ? "true" : "false"}
      className={cn("flex items-center gap-2 border-t px-3 py-1 text-xs", KIND_CLASS[copy.kind])}
      title={`${copy.title} · ${when}\n${copy.description}`}
    >
      <Icon size={14} weight="duotone" className="shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 max-md:line-clamp-2 md:truncate">
        <span className="font-medium">{copy.title}</span>
        {!recolhida && (
          <>
            <span className="ml-1.5 opacity-70">{when}</span>
            <span className="ml-1.5 opacity-90">· {copy.description}</span>
          </>
        )}
      </p>
      <button
        type="button"
        onClick={alternar}
        aria-expanded={!recolhida}
        aria-label={recolhida ? t("Mostrar o aviso") : t("Recolher o aviso")}
        title={recolhida ? t("Mostrar o aviso") : t("Recolher o aviso")}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-80 hover:opacity-100"
      >
        {recolhida ? <CaretUp size={12} aria-hidden /> : <CaretDown size={12} aria-hidden />}
      </button>
    </div>
  );
}
