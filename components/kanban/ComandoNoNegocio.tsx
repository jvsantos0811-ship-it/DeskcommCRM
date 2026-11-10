"use client";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useResumeAiAttendance } from "@/hooks/inbox/useResumeAiAttendance";
import { useAgentesParaDevolver } from "@/hooks/inbox/useAgentesParaDevolver";
import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { comandoDaConversa } from "@/lib/inbox/comando-da-conversa";
import { roleAtLeast } from "@/lib/auth/types";
import { Button } from "@/components/ui/button";
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
import { DevolverParaAgenteDialog } from "@/components/inbox/DevolverParaAgenteDialog";

/**
 * ASSUMIR A CONVERSA SEM SAIR DO FUNIL (PC-024, item 1).
 *
 * ─── Por que existe ──────────────────────────────────────────────────────────
 *
 * A equipe trabalha pelo quadro. Para assumir, ela saía do pop-up do negócio,
 * ia ao Inbox, achava a conversa e voltava — e cada ida e volta esfria o lead
 * que está em "Análise humana" ou "Aguardando assinatura".
 *
 * ─── Mesmo serviço do Inbox, nenhum caminho paralelo ────────────────────────
 *
 * "Assumir" é a MESMA rota do cabeçalho do Inbox (`useClaimConversation` →
 * `POST /conversations/{id}/claim` → `fn_conversation_assign`): a conversa passa
 * para quem clicou, a IA cala (silêncio `infinity`), os follow-ups seguem a
 * política de passagem de cada fluxo na hora do envio, a linha do tempo ganha
 * "Assumiu a conversa" e a auditoria registra. "Devolver ao automático" é a
 * MESMA rota e o MESMO diálogo do Inbox (PC-014: com roteador, escolher o agente
 * e escrever o que foi feito). Quem manda é a MESMA regra (`comandoDaConversa`).
 *
 * ─── Conversa com outra pessoa ───────────────────────────────────────────────
 *
 * Mostra com quem está. Tirar de alguém é gesto de gerente, com confirmação
 * ("A conversa está com X. Assumir?"); a rota recebe o dono atual como
 * `expected_assignee` (trava otimista: se ele mudou no meio, 409 e nada muda).
 * Para atendente o botão fica à vista, desabilitado, com o motivo.
 */
export function ComandoNoNegocio({ conversa }: { conversa: ConversationWithContact }) {
  const t = useT();
  const { user, activeOrg } = useAuth();
  const claim = useClaimConversation();
  const retomar = useResumeAiAttendance();
  const automaticoDaOrg = useAutomaticoAtivo();
  const [confirmarTomada, setConfirmarTomada] = useState(false);
  const [devolverAberto, setDevolverAberto] = useState(false);

  const { comando, travaVigente } = comandoDaConversa({
    status: conversa.status,
    assigned_to_user_id: conversa.assigned_to_user_id,
    assigned_to_user_name: conversa.assigned_to_user_name ?? null,
    assignee_kind: conversa.assignee_kind ?? null,
    bot_silenced_until: conversa.bot_silenced_until ?? null,
    last_handoff_reason: conversa.last_handoff_reason ?? null,
    force_human: conversa.contacts?.force_human ?? null,
    is_blocked: conversa.contacts?.is_blocked ?? null,
    is_group: conversa.is_group ?? false,
    automaticoDaOrg: automaticoDaOrg.data,
  });
  // A volta aparece pela MESMA condição do Inbox: há trava vigente a desfazer.
  const agentes = useAgentesParaDevolver(conversa.id, travaVigente);

  // Escrita na conversa é `agent`+ (a rota cobra); suporte somente leitura não age.
  if (user.support?.access_mode === "support_readonly") return null;
  const souAdminDaPlataforma = user.is_platform_admin && !user.support;
  if (!souAdminDaPlataforma && !roleAtLeast(activeOrg?.role, "agent")) return null;
  const souGerente = souAdminDaPlataforma || roleAtLeast(activeOrg?.role, "manager");

  const dono = conversa.assigned_to_user_id ?? null;
  const comigo = dono !== null && dono === user.id;
  const comOutraPessoa = dono !== null && !comigo;
  const nomeDoDono =
    comando.quem === "humano" && comando.nome ? comando.nome : t("outra pessoa");

  const assumir = (esperado: string | null) =>
    claim.mutate({ conversation_id: conversa.id, expected_assignee: esperado });

  const devolver = () =>
    agentes.data?.tem_roteador
      ? setDevolverAberto(true)
      : retomar.mutate({ conversation_id: conversa.id });

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="comando-no-negocio">
      {comigo && (
        <span
          className="rounded-full border border-success-fg/40 bg-success-bg px-2 py-0.5 text-[11px] font-medium text-success-fg"
          data-testid="com-voce-no-negocio"
        >
          {t("Com você")}
        </span>
      )}
      {comOutraPessoa && (
        <span
          className="max-w-[12rem] truncate rounded-full border border-border px-2 py-0.5 text-[11px] text-text-muted"
          title={`${t("A conversa está com")} ${nomeDoDono}`}
          data-testid="conversa-com-outra-pessoa"
        >
          {t("Com")} {nomeDoDono}
        </span>
      )}
      {!comigo && (
        <Button
          size="sm"
          variant="default"
          className="h-7 px-2.5 text-xs"
          data-testid="assumir-no-negocio"
          disabled={claim.isPending || (comOutraPessoa && !souGerente)}
          title={
            comOutraPessoa && !souGerente
              ? t("Só um gerente pode assumir a conversa que está com outra pessoa.")
              : t("Você passa a responder esta conversa e o atendimento automático para aqui.")
          }
          onClick={() => (comOutraPessoa ? setConfirmarTomada(true) : assumir(null))}
        >
          {claim.isPending ? t("Assumindo...") : t("Assumir conversa")}
        </Button>
      )}
      {comigo && travaVigente && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-xs"
          data-testid="devolver-no-negocio"
          // PC-014: espera a lista do roteador antes de decidir o que o clique faz.
          disabled={retomar.isPending || agentes.isLoading}
          title={t("Devolve esta conversa ao atendimento automático.")}
          onClick={devolver}
        >
          {retomar.isPending ? t("Devolvendo...") : t("Devolver para a IA")}
        </Button>
      )}

      <AlertDialog open={confirmarTomada} onOpenChange={setConfirmarTomada}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("A conversa está com")} {nomeDoDono}. {t("Assumir?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("Você passa a responder esta conversa e o atendimento automático para aqui.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction data-testid="confirmar-assumir-no-negocio" onClick={() => assumir(dono)}>
              {t("Assumir conversa")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {agentes.data?.tem_roteador && (
        <DevolverParaAgenteDialog
          open={devolverAberto}
          onOpenChange={setDevolverAberto}
          agentes={agentes.data.agentes}
          enviando={retomar.isPending}
          onConfirmar={(escolha) =>
            retomar.mutate(
              { conversation_id: conversa.id, ...escolha },
              { onSuccess: () => setDevolverAberto(false) },
            )
          }
        />
      )}
    </div>
  );
}
