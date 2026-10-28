"use client";

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
import { OwnerBadge } from "./OwnerBadge";
import { resolveLeadOwner } from "@/lib/kanban/owner";
import { formatValorDoNegocio, MOEDA_PADRAO } from "@/lib/money";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[1280px] flex-col gap-0 overflow-hidden p-0 lg:h-[min(860px,calc(100dvh-4rem))]"
        data-popup-do-negocio
        // Observável pelo mesmo motivo do board: "a assinatura morreu" e "nada
        // aconteceu" têm a mesma aparência, que é silêncio.
        data-realtime-status={timeline.realtimeStatus.toLowerCase()}
        data-refetch-divergencias={timeline.seguranca.divergencias}
      >
        {/* ── topo: título, valor, dono, score ── */}
        <div className="flex flex-col gap-2 border-b border-border px-5 pt-4 pb-3 pr-14">
          <DialogTitle className="text-base leading-6">{lead.title}</DialogTitle>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            <span className="font-medium tabular-nums text-text">
              {formatValor(lead.value_cents, lead.currency)}
            </span>
            <span className="text-text-muted">{stageName}</span>
            <OwnerBadge
              ownerKind={owner.kind}
              ownerName={owner.name}
              agentVersion={owner.agentVersion}
            />
            {score && (
              <ScoreSlot
                probability={score.probability}
                band={score.band}
                reason={score.reason}
                factors={score.factors.slice(0, 3)}
              />
            )}
            {score?.at && (
              <span className="text-[11px] text-text-muted">
                {t("Probabilidade recalculada automaticamente")} ·{" "}
                {new Date(score.at).toLocaleString(tagDoIdioma)}
              </span>
            )}
          </div>
          {etapas && etapas.length > 0 && (
            <EtapasDoNegocio
              etapas={etapas}
              etapaAtualId={lead.stage_id}
              podeMover={podeMover}
              movendo={movendo}
              onMover={(id) => onMoverParaEtapa?.(id)}
            />
          )}
        </div>

        {/* ── corpo: três colunas no desktop, empilhadas no celular ── */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          {/* conversa — primeiro no DOM para vir primeiro no celular */}
          <section
            className="flex h-[70dvh] min-h-0 flex-col border-b border-border lg:order-2 lg:h-auto lg:flex-1 lg:border-b-0 lg:border-x"
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
          <aside className="flex flex-col gap-0 px-5 lg:order-1 lg:w-80 lg:shrink-0 lg:overflow-y-auto">
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
          </aside>

          {/* o que acontece — tarefas, linha do tempo, propostas, tudo à vista */}
          <aside
            className="flex min-h-0 flex-col px-4 lg:order-3 lg:w-96 lg:shrink-0 lg:overflow-y-auto"
            aria-label={t("Detalhes do negócio")}
          >
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
                funil). Escondida numa aba, o pop-up abriria mudo justamente para
                quem desconfia de um card que apareceu sozinho. */}
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
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
