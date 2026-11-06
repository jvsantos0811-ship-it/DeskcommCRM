"use client";

import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { RetratoDoFunilDoNumero } from "@/lib/channels/funil-do-numero";

/**
 * O FUNIL DE CADA NÚMERO (migration 9025) — a mesma porta em todo tipo de
 * conexão, ao lado do acesso da IA: o número abre card no funil? Em qual funil
 * e etapa? O resumo no cartão diz ONDE os cards nascem hoje, perguntado ao
 * servidor (a mesma função do nascimento do card), e avisa quando o funil
 * escolhido foi arquivado.
 */

/** Valores-sentinela do seletor: o Radix não aceita item com valor vazio. */
const FUNIL_PADRAO = "padrao";
const PRIMEIRA_ETAPA = "primeira";

function chave(channelId: string) {
  return ["channel-funil", channelId] as const;
}

export function FunilDoNumero({ channelId }: { channelId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: chave(channelId),
    queryFn: () => apiClient.get<{ data: RetratoDoFunilDoNumero }>(`/api/v1/channel-sessions/${channelId}/funil`),
    refetchOnWindowFocus: !open,
  });
  const r = query.data?.data;

  return (
    <div className="flex flex-col items-start gap-2" data-testid="funil-do-numero">
      {r && (
        <Badge variant={r.abre_card ? "neutral" : "warning"} data-testid="funil-do-numero-resumo">
          {r.abre_card ? t("Abre card no funil") : t("Não abre card no funil")}
        </Badge>
      )}
      {r && <ResumoDoDestino retrato={r} />}
      {query.isError && (
        <p role="alert" className="text-xs text-destructive">
          {t("Não foi possível ler o funil deste número.")}
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
          void query.refetch();
        }}
      >
        {t("Configurar funil")}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col gap-6 overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{t("Funil deste número")}</SheetTitle>
            <SheetDescription>
              {t("Escolha se as conversas novas que chegam por este número viram card no funil, e em qual funil.")}
            </SheetDescription>
          </SheetHeader>
          {query.isFetching && !r ? (
            <p role="status">{t("Carregando…")}</p>
          ) : query.isError ? (
            <div className="flex flex-col gap-3" role="alert">
              <p>{t("Não foi possível ler o funil deste número.")}</p>
              <Button variant="outline" onClick={() => void query.refetch()}>
                {t("Tentar novamente")}
              </Button>
            </div>
          ) : open && r ? (
            <FormularioDoFunil
              key={`${r.abre_card}-${r.funil_id ?? ""}-${r.etapa_id ?? ""}`}
              channelId={channelId}
              inicial={r}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** "Os cards nascem em Funil › Etapa", e o aviso quando o escolhido não vale mais. */
function ResumoDoDestino({ retrato }: { retrato: RetratoDoFunilDoNumero }) {
  const t = useT();
  if (!retrato.abre_card) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("As conversas deste número chegam no Inbox, sem criar card.")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {retrato.destino ? (
        <p className="text-xs text-muted-foreground" data-testid="funil-do-numero-destino">
          {t("Os cards nascem em")}{" "}
          <strong className="font-medium text-foreground">
            {retrato.destino.funil_nome} › {retrato.destino.etapa_nome}
          </strong>
          {retrato.funil_id === null ? ` (${t("funil padrão da empresa")})` : null}
        </p>
      ) : null}
      {retrato.aviso ? (
        <p role="alert" className="text-xs text-warning-fg" data-testid="funil-do-numero-aviso">
          {textoDoAviso(retrato.aviso, t)}
        </p>
      ) : null}
    </div>
  );
}

function textoDoAviso(aviso: NonNullable<RetratoDoFunilDoNumero["aviso"]>, t: ReturnType<typeof useT>): string {
  switch (aviso) {
    case "funil_arquivado":
      return t("O funil escolhido foi arquivado. Os cards deste número estão nascendo no funil padrão da empresa — escolha outro funil.");
    case "funil_sem_etapa":
      return t("O funil escolhido não tem etapa aberta. Os cards deste número estão nascendo no funil padrão da empresa.");
    case "etapa_indisponivel":
      return t("A etapa escolhida não está mais disponível. Os cards estão nascendo na primeira etapa do funil.");
    case "sem_funil_padrao":
      return t("A empresa não tem funil padrão com etapa aberta. Sem ele, nenhum card nasce — confira em Configurações › Funis.");
  }
}

function FormularioDoFunil({
  channelId,
  inicial,
  onClose,
}: {
  channelId: string;
  inicial: RetratoDoFunilDoNumero;
  onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const qc = useQueryClient();
  const [abreCard, setAbreCard] = useState(inicial.abre_card);
  const [funil, setFunil] = useState<string>(inicial.funil_id ?? FUNIL_PADRAO);
  const [etapa, setEtapa] = useState<string>(inicial.etapa_id ?? PRIMEIRA_ETAPA);
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const funilPadrao = inicial.funis.find((f) => f.padrao);
  const funilEscolhido = funil === FUNIL_PADRAO ? null : (inicial.funis.find((f) => f.id === funil) ?? null);
  const etapasDoEscolhido = funilEscolhido?.etapas ?? [];
  // O funil guardado pode ter sido arquivado: ele não está na lista, e o
  // seletor mostraria vazio. Volta para o padrão, e o aviso explica.
  const funilGuardadoSumiu = funil !== FUNIL_PADRAO && !funilEscolhido;

  async function salvar() {
    setBusy(true);
    setErro(null);
    const funilId = funil === FUNIL_PADRAO || funilGuardadoSumiu ? null : funil;
    const etapaId = funilId && etapa !== PRIMEIRA_ETAPA && etapasDoEscolhido.some((e) => e.id === etapa) ? etapa : null;
    try {
      const salvo = await apiClient.patch<{ data: RetratoDoFunilDoNumero }>(`/api/v1/channel-sessions/${channelId}/funil`, {
        abre_card: abreCard,
        funil_id: funilId,
        etapa_id: etapaId,
      });
      qc.setQueryData(chave(channelId), salvo);
      toast.success(t("Funil do número atualizado."));
      onClose();
    } catch {
      setErro(t("Não foi possível confirmar o salvamento. Reabra este painel para conferir o funil do número."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <Switch
            id={`${id}-abre`}
            checked={abreCard}
            disabled={busy}
            onCheckedChange={(v) => {
              setAbreCard(v);
              setErro(null);
            }}
          />
          <Label htmlFor={`${id}-abre`} className="cursor-pointer">
            {t("Abrir card no funil")}
          </Label>
          <span className="text-sm text-muted-foreground">{abreCard ? t("Sim") : t("Não")}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {abreCard
            ? t("Cada pessoa nova que escrever para este número vira um card no funil escolhido abaixo.")
            : t("As conversas deste número continuam chegando no Inbox, com contato e mensagens, mas não criam card no funil. Use para números que não são de venda.")}
        </p>
      </div>

      {abreCard && (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-funil`}>{t("Em qual funil")}</Label>
            <Select
              value={funilGuardadoSumiu ? FUNIL_PADRAO : funil}
              disabled={busy}
              onValueChange={(v) => {
                setFunil(v);
                setEtapa(PRIMEIRA_ETAPA);
                setErro(null);
              }}
            >
              <SelectTrigger id={`${id}-funil`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FUNIL_PADRAO}>
                  {funilPadrao
                    ? `${t("Funil padrão da empresa")} (${funilPadrao.nome})`
                    : t("Funil padrão da empresa")}
                </SelectItem>
                {inicial.funis.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {funil === FUNIL_PADRAO || funilGuardadoSumiu
                ? t("Acompanha o funil padrão: se a empresa trocar o funil padrão, os cards deste número passam a nascer no novo.")
                : t("Fica neste funil mesmo que a empresa troque o funil padrão.")}
            </p>
          </div>

          {funilEscolhido && !funilGuardadoSumiu && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-etapa`}>{t("Em qual etapa")}</Label>
              <Select
                value={etapasDoEscolhido.some((e) => e.id === etapa) ? etapa : PRIMEIRA_ETAPA}
                disabled={busy}
                onValueChange={(v) => {
                  setEtapa(v);
                  setErro(null);
                }}
              >
                <SelectTrigger id={`${id}-etapa`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PRIMEIRA_ETAPA}>
                    {etapasDoEscolhido[0]
                      ? `${t("Primeira etapa")} (${etapasDoEscolhido[0].nome})`
                      : t("Primeira etapa")}
                  </SelectItem>
                  {etapasDoEscolhido.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {etapasDoEscolhido.length === 0 && (
                <p role="alert" className="text-sm text-warning-fg">
                  {t("Este funil não tem etapa aberta. Enquanto não tiver, os cards nascem no funil padrão da empresa.")}
                </p>
              )}
            </div>
          )}

          {inicial.aviso && <p className="text-sm text-warning-fg">{textoDoAviso(inicial.aviso, t)}</p>}
        </>
      )}

      <p className="text-sm text-muted-foreground">
        {t("Vale para quem escreve pela primeira vez, ou volta depois de o negócio anterior fechar. Cards que já existem não mudam de lugar. Campanha com funil próprio e cliente que volta continuam com as regras deles.")}
      </p>

      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void salvar()}>
          {busy ? t("Salvando…") : t("Salvar funil do número")}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {t("Cancelar")}
        </Button>
      </div>
    </div>
  );
}
