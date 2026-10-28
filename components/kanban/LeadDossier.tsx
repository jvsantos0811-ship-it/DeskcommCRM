"use client";

import { useState, type ReactNode } from "react";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useLeadTimeline } from "@/hooks/leads/useLeadTimeline";
import type { Lead } from "@/lib/types/leads";
import { ChatDoNegocio } from "./ChatDoNegocio";
import { ContratosDoNegocio } from "./ContratosDoNegocio";
import { AssinaturaConfirmada } from "./AssinaturaConfirmada";
import { ContatoDoNegocio } from "./ContatoDoNegocio";
import { ConversaNoDossie } from "./ConversaNoDossie";
import { EtapasDoNegocio, type EtapaDoNegocio } from "./EtapasDoNegocio";
import { LeadFieldsForm } from "./LeadFieldsForm";
import { ScoreSlot } from "./ScoreSlot";
import { LeadTimeline } from "./LeadTimeline";
import { PropostasDoNegocio } from "./PropostasDoNegocio";
import { TarefasDoNegocio } from "./TarefasDoNegocio";
import { OwnerBadge, ownerInitials } from "./OwnerBadge";
import { estiloDasIniciais } from "@/components/ui/cor-do-contato";
import { resolveLeadOwner } from "@/lib/kanban/owner";
import { formatValorDoNegocio, MOEDA_PADRAO } from "@/lib/money";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { BotaoModoFoco } from "@/components/inbox/BotaoModoFoco";
import { useModoFoco } from "@/hooks/inbox/useModoFoco";
import { useLateraisDoDossie } from "@/hooks/leads/useLateraisDoDossie";
import { CaretDoubleLeft, CaretDoubleRight } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  lead: Lead;
  pipelineId: string;
  fieldDefs?: CustomFieldDef[];
  stageName: string;
  ownerNames?: Map<string, string | null>;
  /**
   * As etapas do funil, na ordem, para a régua do topo. Opcional: quem abre o
   * dossiê sem poder mover (o calendário) não passa, e a régua não aparece.
   */
  etapas?: EtapaDoNegocio[];
  /** Move o negócio pela MESMA mutação do arrasto do quadro. */
  onMoverParaEtapa?: (stageId: string) => void;
  movendo?: boolean;
}

function formatValor(cents: number | null, currency: string | null): string {
  // Mesma régua e mesmo locale do card e do total da coluna (`formatValorDoNegocio`).
  if (cents === null) return "—";
  return formatValorDoNegocio(cents, currency ?? MOEDA_PADRAO, { semCentavos: true });
}

/**
 * O pop-up do negócio: tudo o que se faz com um lead, sem sair do funil.
 *
 * Três colunas — os DADOS à esquerda (contato e campos), a CONVERSA no meio
 * (o mesmo chat do Inbox, com envio, notas e templates) e o que ACONTECE à
 * direita (tarefas, linha do tempo e propostas, à vista). Por cima, a régua de
 * etapas: clicar numa etapa move o negócio pela mesma mutação do arrasto, com
 * os mesmos diálogos de campos obrigatórios e de retomada.
 *
 * A ordem das decisões do dossiê anterior continua valendo dentro das colunas:
 * tarefas antes do histórico (quem abre para agir procura o próximo passo) e
 * SALVAR NÃO FECHA (quem edita vê a atividade que gerou entrar no histórico).
 *
 * Em tela estreita as colunas empilham: conversa primeiro, porque é o que se
 * abre o card para fazer, e o resto rola abaixo.
 */
export function LeadDossier({
  open,
  onOpenChange,
  lead,
  pipelineId,
  fieldDefs = [],
  stageName,
  ownerNames,
  etapas,
  onMoverParaEtapa,
  movendo = false,
}: Props) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const timeline = useLeadTimeline(open ? lead.id : null, lead.contact_id);
  const owner = resolveLeadOwner(lead, ownerNames);
  const score = lead.score ?? null;
  const user = useUser();
  const activeOrg = useActiveOrg();
  const podeCriarProposta =
    user.is_platform_admin || (activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager) || false;
  // Tarefas são `agent`+, a mesma régua da tela de Tarefas e da rota — e o
  // suporte temporário só lê, como lá (`requireSupportWrite`).
  const podeEditarTarefas =
    (user.is_platform_admin && !user.support) ||
    (activeOrg ? ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent : false);
  // Mover etapa é a mesma régua do arrasto: quem arrasta no quadro move aqui.
  const podeMover = !!onMoverParaEtapa && podeEditarTarefas;

  // PC-011: colunas laterais recolhíveis (estado por usuário), abas no
  // celular e modo foco. Nada disso muda o que cada coluna faz.
  const laterais = useLateraisDoDossie(user.id);
  const { modoFoco, alternarFoco, sairDoFoco } = useModoFoco(open);
  const [abaNoCelular, setAbaNoCelular] = useState<AbaDoDossie>("conversa");
  const aba: AbaDoDossie = modoFoco ? "conversa" : abaNoCelular;
  const dadosRecolhidos = modoFoco || laterais.dadosRecolhidos;
  const detalhesRecolhidos = modoFoco || laterais.detalhesRecolhidos;
  const abasDoDossie: Array<{ id: AbaDoDossie; rotulo: string }> = [
    { id: "conversa", rotulo: t("Conversa") },
    { id: "dados", rotulo: t("Contato") },
    { id: "detalhes", rotulo: t("Tarefas") },
  ];
  const tituloDaProbabilidade = score?.at
    ? `${t("Probabilidade recalculada automaticamente")} · ${new Date(score.at).toLocaleString(tagDoIdioma)}`
    : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // PC-011: a janela ocupa quase a tela toda (margem de 0,5rem), em vez de
        // parar em 1280×860 — no notebook de 1366×768 cada pixel a mais vai para
        // a conversa. Escolhido no lugar de um botão "tela cheia": é só tamanho,
        // sem estado novo, e a conversa já ganha a largura sem um clique a mais.
        className="flex h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[1800px] flex-col gap-0 overflow-hidden p-0"
        data-popup-do-negocio
        data-modo-foco={modoFoco ? "true" : "false"}
        // O Esc do modo foco sai do foco, e NÃO fecha o card.
        onEscapeKeyDown={(evento) => {
          if (modoFoco) {
            evento.preventDefault();
            sairDoFoco();
          }
        }}
        // Observável pelo mesmo motivo do board: "a assinatura morreu" e "nada
        // aconteceu" têm a mesma aparência, que é silêncio.
        data-realtime-status={timeline.realtimeStatus.toLowerCase()}
        data-refetch-divergencias={timeline.seguranca.divergencias}
      >
        {/* ── topo: UMA linha — nome, etapa atual, responsável, valor, score ── */}
        {/* Marinho (PC-012): o cabeçalho do negócio é a faixa escura do card,
            a mesma da barra lateral — `data-theme="dark"` traz os papéis de
            texto e `lateral-marinho` (globals.css) as superfícies. */}
        <div
          className="lateral-marinho flex min-h-11 items-center gap-x-3 gap-y-1 border-b border-border bg-surface py-1.5 pr-12 pl-4 text-text"
          data-testid="cabecalho-do-negocio"
          data-theme="dark"
        >
          <span
            aria-hidden
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
            style={estiloDasIniciais(lead.contact_id ?? lead.id)}
          >
            {ownerInitials(lead.title)}
          </span>
          <DialogTitle className="min-w-[5rem] shrink truncate text-base leading-6" title={lead.title}>
            {lead.title}
          </DialogTitle>
          <span
            className="min-w-0 max-w-[12rem] shrink-0 truncate rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-text"
            title={`${t("Etapa atual")}: ${stageName}`}
            data-testid="etapa-atual-do-negocio"
          >
            {stageName}
          </span>
          <div className="min-w-0 shrink-0 text-xs">
            <OwnerBadge
              compacto
              ownerKind={owner.kind}
              ownerName={owner.name}
              agentVersion={owner.agentVersion}
            />
          </div>
          <span className="hidden shrink-0 text-xs font-medium tabular-nums text-text sm:inline">
            {formatValor(lead.value_cents, lead.currency)}
          </span>
          {score && (
            <div className="hidden min-w-0 shrink text-xs md:block" title={tituloDaProbabilidade}>
              <ScoreSlot
                probability={score.probability}
                band={score.band}
                reason={score.reason}
                factors={score.factors.slice(0, 3)}
              />
            </div>
          )}
          <span className="flex-1" />
          {lead.conversa && (
            <BotaoModoFoco ligado={modoFoco} onAlternar={alternarFoco} className="shrink-0" />
          )}
        </div>
        {etapas && etapas.length > 0 && !modoFoco && (
          <div className="border-b border-border px-4 py-1.5">
            <EtapasDoNegocio
              etapas={etapas}
              etapaAtualId={lead.stage_id}
              podeMover={podeMover}
              movendo={movendo}
              onMover={(id) => onMoverParaEtapa?.(id)}
            />
          </div>
        )}

        {/* ── no celular: uma coluna por vez, por abas ── */}
        {!modoFoco && (
          <div role="tablist" aria-label={t("Partes do negócio")} className="flex border-b border-border lg:hidden">
            {abasDoDossie.map((a) => (
              <button
                key={a.id}
                type="button"
                role="tab"
                aria-selected={aba === a.id}
                onClick={() => setAbaNoCelular(a.id)}
                className={cn(
                  "h-9 flex-1 border-b-2 text-xs font-medium",
                  aba === a.id ? "border-primary text-text" : "border-transparent text-text-muted",
                )}
              >
                {a.rotulo}
              </button>
            ))}
          </div>
        )}

        {/* ── corpo: três colunas no desktop; abas no celular ── */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
          {/* conversa — primeiro no DOM para vir primeiro no celular */}
          <section
            className={cn(
              "min-h-0 flex-1 flex-col lg:order-2 lg:flex lg:border-x lg:border-border",
              aba === "conversa" ? "flex" : "hidden",
            )}
            aria-label={t("Conversa")}
          >
            {lead.conversa ? (
              <ChatDoNegocio conversationId={lead.conversa.id} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <p className="text-sm text-text-muted">
                  {t("Este negócio ainda não tem conversa.")}
                </p>
                <div className="w-full max-w-xs">
                  <ConversaNoDossie
                    conversa={lead.conversa}
                    contactId={lead.contact_id}
                    phone={lead.contact_phone}
                  />
                </div>
              </div>
            )}
          </section>

          {/* dados — contato e campos */}
          <ColunaLateral
            lado="esquerda"
            rotulo={t("Contato e dados")}
            recolhida={dadosRecolhidos}
            podeAlternar={!modoFoco}
            onAlternar={laterais.alternarDados}
            visivelNoCelular={aba === "dados"}
            className="lg:order-1 lg:w-64 xl:w-72"
            testid="coluna-dados-do-negocio"
          >
            <div className="px-4">
              <section className="border-b border-border py-3">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                  {t("Contato")}
                </h3>
                <ContatoDoNegocio contactId={lead.contact_id} pipelineId={pipelineId} leadId={lead.id} />
              </section>
              <section className="py-3">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                  {t("Dados do negócio")}
                </h3>
                <LeadFieldsForm lead={lead} pipelineId={pipelineId} fieldDefs={fieldDefs} />
              </section>
            </div>
          </ColunaLateral>

          {/* o que acontece — tarefas, linha do tempo, propostas, tudo à vista */}
          <ColunaLateral
            lado="direita"
            rotulo={t("Tarefas e linha do tempo")}
            recolhida={detalhesRecolhidos}
            podeAlternar={!modoFoco}
            onAlternar={laterais.alternarDetalhes}
            visivelNoCelular={aba === "detalhes"}
            className="lg:order-3 lg:w-72 xl:w-80"
            ariaLabel={t("Detalhes do negócio")}
            testid="coluna-detalhes-do-negocio"
          >
            <div className="flex min-h-full flex-col px-4">
              {/* As tarefas ANTES da linha do tempo: a timeline conta o que já
                  aconteceu, a tarefa é o que ainda falta fazer — e quem abre o card
                  para agir procura o próximo passo primeiro. */}
              <TarefasDoNegocio
                leadId={lead.id}
                contactId={lead.contact_id}
                podeEditar={podeEditarTarefas}
                aberto={open}
              />
              {/* Contrato esperando assinatura também é próximo passo: logo depois
                  das tarefas, e não debaixo da linha do tempo inteira. Mesma régua
                  de quem pode agir (`agent`+, "qualquer atendente"). */}
              <ContratosDoNegocio leadId={lead.id} podeEditar={podeEditarTarefas} aberto={open} />
              {/* PC-003: o ganho por assinatura — só gerente (a rota confere). */}
              <AssinaturaConfirmada
                leadId={lead.id}
                pipelineId={pipelineId}
                status={lead.status}
                tags={lead.tags ?? []}
                podeConfirmar={podeCriarProposta && !user.support}
              />
              {/* A linha do tempo fica À VISTA, sem aba: é ela que responde "de onde
                  veio este card?" (entrou no funil, primeira mensagem, troca de
                  funil). */}
              <section className="flex-1 py-3">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                  {t("Linha do tempo")}
                </h3>
                <LeadTimeline
                  itens={timeline.itens}
                  chegouAoVivo={timeline.chegouAoVivo}
                  isLoading={timeline.isLoading}
                  isError={timeline.isError}
                />
              </section>
              <PropostasDoNegocio
                leadId={lead.id}
                pipelineId={pipelineId}
                podeCriar={podeCriarProposta}
              />
            </div>
          </ColunaLateral>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type AbaDoDossie = "conversa" | "dados" | "detalhes";

/**
 * Uma coluna lateral do card (PC-011). No desktop ela recolhe numa faixa fina
 * com o botão de abrir, e a conversa fica com a largura; o conteúdo continua
 * MONTADO quando recolhida, para nenhum campo em edição perder o que se
 * digitou. No celular ela é uma aba.
 */
function ColunaLateral({
  lado,
  rotulo,
  recolhida,
  podeAlternar,
  onAlternar,
  visivelNoCelular,
  className,
  ariaLabel,
  testid,
  children,
}: {
  lado: "esquerda" | "direita";
  rotulo: string;
  recolhida: boolean;
  podeAlternar: boolean;
  onAlternar: () => void;
  visivelNoCelular: boolean;
  className?: string;
  ariaLabel?: string;
  testid: string;
  children: ReactNode;
}) {
  const t = useT();
  const IconeAbrir = lado === "esquerda" ? CaretDoubleRight : CaretDoubleLeft;
  const IconeFechar = lado === "esquerda" ? CaretDoubleLeft : CaretDoubleRight;
  return (
    <aside
      aria-label={ariaLabel ?? rotulo}
      data-testid={testid}
      data-recolhida={recolhida ? "true" : "false"}
      className={cn(
        "min-h-0 flex-1 flex-col overflow-y-auto lg:flex lg:flex-none lg:shrink-0",
        visivelNoCelular ? "flex" : "hidden",
        recolhida ? "lg:w-9 lg:overflow-hidden" : className,
      )}
    >
      {podeAlternar && (
        <div
          className={cn(
            "hidden shrink-0 items-center lg:flex",
            recolhida ? "h-full flex-col gap-2 pt-1.5" : "h-8 px-1 pt-1",
            !recolhida && lado === "esquerda" && "justify-end",
            !recolhida && lado === "direita" && "justify-start",
          )}
        >
          <button
            type="button"
            onClick={onAlternar}
            aria-expanded={!recolhida}
            aria-label={recolhida ? `${t("Mostrar")}: ${rotulo}` : `${t("Recolher")}: ${rotulo}`}
            title={recolhida ? `${t("Mostrar")}: ${rotulo}` : `${t("Recolher")}: ${rotulo}`}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text"
          >
            {recolhida ? <IconeAbrir size={14} aria-hidden /> : <IconeFechar size={14} aria-hidden />}
          </button>
          {recolhida && (
            <span className="text-[11px] font-medium text-text-muted [writing-mode:vertical-rl]" aria-hidden>
              {rotulo}
            </span>
          )}
        </div>
      )}
      <div className={cn("min-h-0", recolhida && "lg:hidden")}>{children}</div>
    </aside>
  );
}
