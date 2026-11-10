"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";

import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useHorariosLivres } from "@/hooks/agenda/useHorariosLivres";
import { useMarcarAgendamento } from "@/hooks/agenda/useMarcarAgendamento";
import { usePessoasDaAgenda } from "@/hooks/agenda/usePessoasDaAgenda";
import {
  useCancelarAgendamento,
  useRegistrarDesfecho,
  useRemarcarAgendamento,
} from "@/hooks/agenda/useRemarcarAgendamento";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import {
  acoesDoCompromisso,
  hojeNoFuso,
  horariosParaOferecer,
  janelaDeHorarios,
  separarCompromissos,
  type AcaoNoCompromisso,
  type CompromissoListado,
} from "@/lib/agenda/compromissos-do-negocio";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { CalendarPlus } from "@/lib/ui/icons";
import { fusoUtilizavel } from "@/lib/tempo/fusos";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * AGENDAR PELO POP-UP DO NEGÓCIO (PC-027).
 *
 * ─── Um serviço só ───────────────────────────────────────────────────────────
 *
 * Nada aqui marca, remarca, confirma ou desmarca por conta própria: são os
 * MESMOS hooks e as MESMAS rotas da Agenda (`useMarcarAgendamento`,
 * `useRemarcarAgendamento`, `useRegistrarDesfecho`, `useCancelarAgendamento`,
 * `useHorariosLivres` → `/api/v1/agenda/…`). Logo valem as mesmas regras: só
 * horário livre do profissional (o mesmo cálculo do `crm_find_free_slots`), o
 * horário ocupado no meio do caminho recusado, o vínculo com o negócio e a linha
 * do tempo, o Google Agenda, a confirmação e o lembrete do tipo, a falta que
 * dispara o gatilho dos fluxos — e a etapa só muda se a organização já tiver
 * configurado isso para a agenda (nenhuma regra nova aqui).
 *
 * ─── Datas e horários ────────────────────────────────────────────────────────
 *
 * No fuso da organização (`organizations.timezone`), como a pergunta é "que
 * horas no escritório".
 */

interface TipoDeAgendamento {
  id: string;
  name: string;
  duration_minutes: number | null;
  default_owner_user_id: string | null;
  is_active: boolean;
}

function useTiposAtivos(ligado: boolean) {
  return useQuery({
    queryKey: ["agenda", "tipos", "ativos"],
    enabled: ligado,
    queryFn: async () => {
      const r = await apiClient.get<{ data: TipoDeAgendamento[] }>("/api/v1/agenda/tipos");
      return (r.data ?? []).filter((x) => x.is_active);
    },
    staleTime: 60_000,
  });
}

function useCompromissosDoContato(contactId: string | null, ligado: boolean) {
  return useQuery({
    queryKey: ["agenda", "agendamentos", "do-contato", contactId],
    enabled: ligado && !!contactId,
    queryFn: async () => {
      const r = await apiClient.get<{ data: CompromissoListado[] }>(
        `/api/v1/agenda/agendamentos?contact_id=${contactId}&limite=50`,
      );
      return r.data ?? [];
    },
  });
}

export function CompromissosDoNegocio({
  contactId,
  conversationId,
  podeAgendar,
  aberto,
}: {
  contactId: string | null;
  conversationId: string | null;
  podeAgendar: boolean;
  aberto: boolean;
}) {
  const t = useT();
  const tag = useTagDeIdioma();
  const org = useActiveOrg();
  const fuso = fusoUtilizavel(org?.timezone);
  const lista = useCompromissosDoContato(contactId, aberto);
  const desfecho = useRegistrarDesfecho();
  const cancelar = useCancelarAgendamento();
  const [marcando, setMarcando] = useState(false);
  const [remarcando, setRemarcando] = useState<CompromissoListado | null>(null);
  const [desmarcando, setDesmarcando] = useState<CompromissoListado | null>(null);
  const [motivo, setMotivo] = useState("");

  const agora = new Date();
  const { proximos, ultimo } = separarCompromissos(lista.data ?? [], agora);
  const quando = (iso: string) =>
    new Intl.DateTimeFormat(tag, {
      timeZone: fuso,
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso));
  const rotuloDaSituacao: Record<string, string> = {
    pending: t("Marcado"),
    confirmed: t("Confirmado"),
    completed: t("Compareceu"),
    no_show: t("Faltou"),
    cancelled: t("Desmarcado"),
  };
  const rotuloDaAcao: Record<AcaoNoCompromisso, string> = {
    confirmar: t("Confirmar"),
    compareceu: t("Compareceu"),
    faltou: t("Faltou"),
    remarcar: t("Remarcar"),
    desmarcar: t("Desmarcar"),
  };

  const agir = (c: CompromissoListado, a: AcaoNoCompromisso) => {
    if (a === "remarcar") return setRemarcando(c);
    if (a === "desmarcar") {
      setMotivo("");
      return setDesmarcando(c);
    }
    desfecho.mutate({
      id: c.id,
      revision: c.revision,
      status: a === "confirmar" ? "confirmed" : a === "compareceu" ? "completed" : "no_show",
    });
  };

  if (!contactId) return null;
  const linhas = [...proximos, ...(ultimo ? [ultimo] : [])];

  return (
    <section className="border-b border-border py-3" data-testid="compromissos-do-negocio">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium tracking-wide text-text-muted uppercase">
          {t("Compromissos")}
        </h3>
        {podeAgendar && <BotaoAgendar onClick={() => setMarcando(true)} />}
      </div>
      {lista.isLoading && <p className="text-xs text-text-muted">{t("Carregando…")}</p>}
      {!lista.isLoading && linhas.length === 0 && (
        <p className="text-xs text-text-muted">
          {t("Nenhum compromisso marcado com este contato.")}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {linhas.map((c) => {
          const acoes = podeAgendar ? acoesDoCompromisso(c, agora) : [];
          return (
            <li
              key={c.id}
              className="rounded-md border border-border px-2.5 py-2 text-xs"
              data-testid="compromisso-do-negocio"
              data-situacao={c.situacao}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-text">
                    {c.tipo?.nome ?? c.titulo}
                  </span>
                  <span className="block text-text-muted tabular-nums">{quando(c.iniciaEm)}</span>
                </span>
                <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px]">
                  {rotuloDaSituacao[c.situacao] ?? c.situacao}
                </span>
              </div>
              {acoes.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {acoes.map((a) => (
                    <Button
                      key={a}
                      size="sm"
                      variant={a === "desmarcar" ? "ghost" : "outline"}
                      className={cn(
                        "h-6 px-2 text-[11px]",
                        a === "desmarcar" && "text-destructive",
                      )}
                      disabled={desfecho.isPending || cancelar.isPending}
                      data-testid={`compromisso-${a}`}
                      onClick={() => agir(c, a)}
                    >
                      {rotuloDaAcao[a]}
                    </Button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {marcando && (
        <DialogoDeHorario
          modo="marcar"
          contactId={contactId}
          conversationId={conversationId}
          fuso={fuso}
          onFechar={() => setMarcando(false)}
        />
      )}
      {remarcando && (
        <DialogoDeHorario
          modo="remarcar"
          compromisso={remarcando}
          contactId={contactId}
          conversationId={conversationId}
          fuso={fuso}
          onFechar={() => setRemarcando(null)}
        />
      )}
      <AlertDialog open={!!desmarcando} onOpenChange={(a) => !a && setDesmarcando(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Desmarcar este compromisso?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Não dá para desfazer: o horário volta a ficar livre e os lembretes param. Diga o motivo — é o que a equipe lê depois.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder={t("Motivo (ex.: cliente pediu outro dia)")}
            data-testid="motivo-de-desmarcar"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Voltar")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={motivo.trim().length < 3}
              data-testid="confirmar-desmarcar"
              onClick={() => {
                if (!desmarcando) return;
                cancelar.mutate(
                  { id: desmarcando.id, revision: desmarcando.revision, reason: motivo.trim() },
                  { onSuccess: () => setDesmarcando(null) },
                );
              }}
            >
              {t("Desmarcar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** O botão "Agendar" — também usado no cabeçalho do pop-up. */
export function BotaoAgendar({ onClick, className }: { onClick: () => void; className?: string }) {
  const t = useT();
  return (
    <Button
      size="sm"
      variant="outline"
      className={cn("h-7 gap-1 px-2 text-xs", className)}
      onClick={onClick}
      data-testid="agendar-no-negocio"
    >
      <CalendarPlus size={14} aria-hidden />
      {t("Agendar")}
    </Button>
  );
}

/**
 * O formulário curto: tipo (com a duração), profissional, dia e só os horários
 * LIVRES daquele profissional; observação opcional. No remarcar, tipo e
 * profissional são os do compromisso e só o horário muda.
 */
export function DialogoDeHorario({
  modo,
  compromisso,
  contactId,
  conversationId,
  fuso,
  onFechar,
}: {
  modo: "marcar" | "remarcar";
  compromisso?: CompromissoListado;
  contactId: string;
  conversationId: string | null;
  fuso: string;
  onFechar: () => void;
}) {
  const t = useT();
  const tag = useTagDeIdioma();
  const tipos = useTiposAtivos(true);
  const pessoas = usePessoasDaAgenda();
  const marcar = useMarcarAgendamento();
  const remarcar = useRemarcarAgendamento();
  const [tipoId, setTipoId] = useState("");
  const [donoId, setDonoId] = useState(compromisso?.donoId ?? "");
  const [dia, setDia] = useState(() => hojeNoFuso(new Date(), fuso));
  const [escolhido, setEscolhido] = useState<string | null>(null);
  const [nota, setNota] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const listaDeTipos = tipos.data ?? [];
  // No remarcar o tipo é o do compromisso (pelo nome); no marcar, o primeiro.
  const tipo =
    listaDeTipos.find((x) => x.id === tipoId) ??
    (compromisso?.tipo ? listaDeTipos.find((x) => x.name === compromisso.tipo?.nome) : undefined) ??
    listaDeTipos[0] ??
    null;
  const dono = donoId || tipo?.default_owner_user_id || "";
  const janela = useMemo(() => janelaDeHorarios(dia, fuso), [dia, fuso]);
  const livres = useHorariosLivres(
    tipo
      ? { event_type_id: tipo.id, owner_user_id: dono || undefined, de: janela.de, ate: janela.ate }
      : null,
  );
  const { doDia, proximos } = horariosParaOferecer(livres.data?.slots ?? [], dia, fuso);
  const hora = (iso: string) =>
    new Intl.DateTimeFormat(tag, {
      timeZone: fuso,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso));
  const diaEHora = (iso: string) =>
    new Intl.DateTimeFormat(tag, {
      timeZone: fuso,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso));
  const enviando = marcar.isPending || remarcar.isPending;

  const aoRecusar = (err: unknown) => {
    // Pego por outra pessoa no meio do caminho: a lista é relida e a tela
    // mostra os próximos livres — nunca dois no mesmo horário.
    if (err instanceof ApiError && err.code === "agenda_horario_indisponivel") {
      setOcupado(true);
      setEscolhido(null);
      void livres.refetch();
    }
  };

  const salvar = () => {
    if (!tipo || !escolhido) return;
    setOcupado(false);
    if (modo === "remarcar" && compromisso) {
      remarcar.mutate(
        { id: compromisso.id, revision: compromisso.revision, starts_at: escolhido },
        { onSuccess: onFechar, onError: aoRecusar },
      );
      return;
    }
    marcar.mutate(
      {
        event_type_id: tipo.id,
        starts_at: escolhido,
        owner_user_id: dono || undefined,
        contact_id: contactId,
        conversation_id: conversationId ?? undefined,
        notes: nota.trim() || undefined,
      },
      { onSuccess: onFechar, onError: aoRecusar },
    );
  };

  const semTipo = tipos.isSuccess && listaDeTipos.length === 0;

  return (
    <Dialog open onOpenChange={(a) => !a && onFechar()}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        data-testid="dialogo-de-agendar"
      >
        <DialogHeader>
          <DialogTitle>
            {modo === "remarcar" ? t("Remarcar compromisso") : t("Agendar")}
          </DialogTitle>
          <DialogDescription>
            {t("Só aparecem os horários livres do profissional, no horário da organização.")}
          </DialogDescription>
        </DialogHeader>

        {semTipo ? (
          <div
            className="rounded-md border border-dashed border-border p-4 text-sm"
            data-testid="agendar-sem-tipo"
          >
            <p className="font-semibold">
              {t("Cadastre um tipo de agendamento em Configurações.")}
            </p>
            <p className="mt-1 text-text-muted">
              {t(
                "Sem tipo de agendamento (consulta, ligação, reunião…) não há duração nem horário para oferecer.",
              )}{" "}
              <Link
                href="/app/settings/tenant/agenda"
                className="font-semibold text-accent underline-offset-2 hover:underline"
              >
                {t("Abrir Configurações › Agenda")}
              </Link>
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {modo === "marcar" && (
              <div className="grid gap-1.5">
                <Label htmlFor="agendar-tipo">{t("Tipo de agendamento")}</Label>
                <select
                  id="agendar-tipo"
                  data-testid="agendar-tipo"
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={tipo?.id ?? ""}
                  onChange={(e) => {
                    setTipoId(e.target.value);
                    setDonoId("");
                    setEscolhido(null);
                  }}
                >
                  {listaDeTipos.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.duration_minutes ? `${x.name} · ${x.duration_minutes} min` : x.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {modo === "marcar" && (
              <div className="grid gap-1.5">
                <Label htmlFor="agendar-dono">{t("Profissional ou responsável")}</Label>
                <select
                  id="agendar-dono"
                  data-testid="agendar-dono"
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={dono}
                  onChange={(e) => {
                    setDonoId(e.target.value);
                    setEscolhido(null);
                  }}
                >
                  <option value="">{t("O responsável padrão do tipo")}</option>
                  {(pessoas.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nome}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="agendar-dia">{t("Dia")}</Label>
              <Input
                id="agendar-dia"
                type="date"
                value={dia}
                min={hojeNoFuso(new Date(), fuso)}
                onChange={(e) => {
                  if (e.target.value) setDia(e.target.value);
                  setEscolhido(null);
                }}
                data-testid="agendar-dia"
              />
            </div>
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">{t("Horário")}</span>
              {ocupado && (
                <p className="text-xs text-warning-fg" data-testid="agendar-horario-ocupado">
                  {t("Esse horário acabou de ser ocupado. Escolha um dos livres abaixo.")}
                </p>
              )}
              {livres.isLoading && (
                <p className="text-xs text-text-muted">{t("Procurando horários livres…")}</p>
              )}
              {livres.data && livres.data.publicou_horarios === false && (
                <p className="text-xs text-text-muted">
                  {t("A jornada de atendimento ainda não foi publicada")}
                </p>
              )}
              <div className="flex flex-wrap gap-1.5" data-testid="agendar-horarios">
                {doDia.map((s) => (
                  <button
                    key={s}
                    type="button"
                    data-testid="agendar-horario"
                    aria-pressed={escolhido === s}
                    onClick={() => setEscolhido(s)}
                    className={cn(
                      "h-8 rounded-md border px-2.5 text-xs tabular-nums",
                      escolhido === s
                        ? "border-accent bg-accent text-accent-foreground"
                        : "border-border hover:border-accent",
                    )}
                  >
                    {hora(s)}
                  </button>
                ))}
              </div>
              {livres.data && doDia.length === 0 && (
                <div className="grid gap-1.5">
                  <p className="text-xs text-text-muted">
                    {proximos.length > 0
                      ? t("Sem horário livre neste dia. Os próximos livres:")
                      : t("Sem horário livre nos próximos 7 dias.")}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {proximos.map((s) => (
                      <button
                        key={s}
                        type="button"
                        data-testid="agendar-proximo-horario"
                        aria-pressed={escolhido === s}
                        onClick={() => setEscolhido(s)}
                        className={cn(
                          "h-8 rounded-md border px-2.5 text-xs tabular-nums",
                          escolhido === s
                            ? "border-accent bg-accent text-accent-foreground"
                            : "border-border hover:border-accent",
                        )}
                      >
                        {diaEHora(s)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {modo === "marcar" && (
              <div className="grid gap-1.5">
                <Label htmlFor="agendar-nota">{t("Observação (opcional)")}</Label>
                <Textarea
                  id="agendar-nota"
                  value={nota}
                  onChange={(e) => setNota(e.target.value)}
                  maxLength={2000}
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onFechar}>
            {t("Cancelar")}
          </Button>
          {!semTipo && (
            <Button
              disabled={!escolhido || enviando}
              onClick={salvar}
              data-testid="confirmar-agendar"
            >
              {enviando ? t("Salvando…") : modo === "remarcar" ? t("Remarcar") : t("Agendar")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
