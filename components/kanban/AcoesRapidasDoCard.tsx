"use client";
import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";

import { useT } from "@/hooks/i18n/useT";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useAssignableAgents } from "@/hooks/kanban/useAssignableAgents";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowRight, ChatCircle, Phone, UserCircle } from "@/lib/ui/icons";
import type { Lead } from "@/lib/types/leads";
import { cn } from "@/lib/utils";

/**
 * As ações rápidas do card do funil (PC-013): conversa, ligar, responsável e
 * mover de etapa. Quem as mostra e esconde é o card — elas aparecem com o mouse
 * em cima e somem quando ele sai; no toque ficam sempre à vista (ver
 * `KanbanCard.tsx`).
 *
 * ─── Nenhuma ação nova de verdade ──────────────────────────────────────────
 *
 * Cada botão é um atalho para algo que o card já fazia por outro caminho:
 *
 *   - conversa → o mesmo link da prévia (`/app/inbox?id=`);
 *   - ligar    → `tel:` com o telefone do contato, que antes ficava escrito na
 *                face do card. Não é a ligação por IA de `/app/calls` (aquela
 *                liga e conduz a conversa sozinha); é o discador do computador
 *                ou do celular de quem clicou;
 *   - responsável → a MESMA troca do menu "⋯" (`KanbanCardActions`), com a
 *                mesma permissão (`pipeline.move_card`) e a mesma mutação;
 *   - mover    → a mesma mutação do arrasto e do pop-up (`moverPeloPopup` do
 *                quadro), então os diálogos de campos obrigatórios e de
 *                retomada continuam valendo.
 *
 * ─── A barreira de clique ──────────────────────────────────────────────────
 *
 * O card inteiro abre o pop-up do negócio ao clique. Todo controle daqui para a
 * propagação (e o `pointerdown`, que o arrasto escuta), e os menus — que vão em
 * portal e propagam pela árvore React — ficam dentro de um `display: contents`
 * que intercepta o clique, como em `KanbanCardActions`.
 */

interface EtapaDoMenu {
  id: string;
  name: string;
}

interface Props {
  lead: Lead;
  pipelineId: string;
  etapas?: readonly EtapaDoMenu[];
  onMover?: (stageId: string) => void;
}

const BOTAO =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent";

function parar(e: MouseEvent) {
  e.stopPropagation();
}

/** `tel:` aceita só dígitos e o `+` inicial — o resto (espaço, traço) sai. */
export function hrefDeLigar(telefone: string | null | undefined): string | null {
  if (!telefone) return null;
  const limpo = telefone.trim().replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return limpo.replace(/\D/g, "").length >= 8 ? `tel:${limpo}` : null;
}

function Barreira({ children }: { children: ReactNode }) {
  return (
    <span className="contents" onClick={parar} onPointerDown={parar}>
      {children}
    </span>
  );
}

export function AcoesRapidasDoCard({ lead, pipelineId, etapas, onMover }: Props) {
  const t = useT();
  const canAssign = usePermission("pipeline.move_card");
  const ligar = hrefDeLigar(lead.contact_phone);
  const conversaId = lead.conversa?.id ?? null;
  const destinos = (etapas ?? []).filter((e) => e.id !== lead.stage_id);

  return (
    <>
      {conversaId && (
        <Link
          href={`/app/inbox?id=${conversaId}`}
          onClick={parar}
          onPointerDown={parar}
          aria-label={t("Abrir conversa")}
          title={t("Abrir conversa")}
          className={BOTAO}
        >
          <ChatCircle size={16} aria-hidden />
        </Link>
      )}
      {ligar && (
        <a
          href={ligar}
          onClick={parar}
          onPointerDown={parar}
          aria-label={`${t("Ligar")}: ${lead.contact_phone}`}
          title={`${t("Ligar")} · ${lead.contact_phone}`}
          className={BOTAO}
          data-testid="card-ligar"
        >
          <Phone size={16} aria-hidden />
        </a>
      )}
      {canAssign && <TrocarResponsavel lead={lead} pipelineId={pipelineId} />}
      {canAssign && onMover && destinos.length > 0 && (
        <Barreira>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("Mover de etapa")}
              title={t("Mover de etapa")}
              className={BOTAO}
              onClick={parar}
            >
              <ArrowRight size={16} aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={parar} className="max-h-[60dvh] overflow-y-auto">
              <DropdownMenuLabel className="text-xs text-text-muted">{t("Mover para")}</DropdownMenuLabel>
              {destinos.map((etapa) => (
                <DropdownMenuItem key={etapa.id} onSelect={() => onMover(etapa.id)}>
                  {etapa.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </Barreira>
      )}
    </>
  );
}

function TrocarResponsavel({ lead, pipelineId }: { lead: Lead; pipelineId: string }) {
  const t = useT();
  const editMutation = useEditLead(pipelineId);
  const { data: members } = useAssignableMembers(true);
  const { data: agents } = useAssignableAgents(true);
  const semDono = lead.owner_user_id === null && lead.owner_agent_id === null;

  return (
    <Barreira>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("Mudar responsável")}
          title={t("Mudar responsável")}
          className={BOTAO}
          onClick={parar}
        >
          <UserCircle size={16} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={parar} className="max-h-[60dvh] overflow-y-auto">
          <DropdownMenuLabel className="text-xs text-text-muted">{t("Responsável")}</DropdownMenuLabel>
          <DropdownMenuItem
            disabled={editMutation.isPending || semDono}
            onSelect={() =>
              editMutation.mutate({
                leadId: lead.id,
                patch: lead.owner_agent_id ? { owner_agent_id: null } : { owner_user_id: null },
              })
            }
          >
            {t("Sem responsável")}
          </DropdownMenuItem>
          {(members ?? []).length > 0 && <DropdownMenuSeparator />}
          {(members ?? []).map((m) => (
            <DropdownMenuItem
              key={m.user_id}
              disabled={editMutation.isPending || m.user_id === lead.owner_user_id}
              onSelect={() => editMutation.mutate({ leadId: lead.id, patch: { owner_user_id: m.user_id } })}
            >
              {m.full_name ?? t("Sem nome")}
            </DropdownMenuItem>
          ))}
          {(agents ?? []).length > 0 && <DropdownMenuSeparator />}
          {(agents ?? []).map((a) => (
            <DropdownMenuItem
              key={a.agent_id}
              disabled={editMutation.isPending || a.agent_id === lead.owner_agent_id}
              onSelect={() => editMutation.mutate({ leadId: lead.id, patch: { owner_agent_id: a.agent_id } })}
            >
              {a.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </Barreira>
  );
}

/** Classe da faixa que envolve as ações: no hover em quem tem mouse, sempre no toque. */
export const FAIXA_DAS_ACOES = cn(
  "flex items-center gap-0.5 bg-surface transition-opacity",
  "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100",
  "[@media(hover:hover)]:focus-within:opacity-100 [@media(hover:hover)]:has-[[data-state=open]]:opacity-100",
);
