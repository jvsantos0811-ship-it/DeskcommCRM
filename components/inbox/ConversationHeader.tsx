"use client";
import { useState, type ReactNode, type RefObject } from "react";
import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
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
import { Badge } from "@/components/ui/badge";
import { JanelaSelo } from "@/components/inbox/JanelaSelo";
import { ChannelLogo } from "@/components/inbox/ChannelLogo";
import {
  Archive,
  ArrowRight,
  ArrowsLeftRight,
  DotsThree,
  MagnifyingGlass,
  Phone,
  UserCircle,
} from "@/lib/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useReleaseConversation } from "@/hooks/inbox/useReleaseConversation";
import {
  useMarkPersonalContact,
  useUnmarkPersonalContact,
} from "@/hooks/contacts/usePersonalContact";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  useArchiveConversation,
  useCloseConversation,
  useReopenConversation,
} from "@/hooks/inbox/useCloseConversation";
import { useResumeAiAttendance } from "@/hooks/inbox/useResumeAiAttendance";
import { usePauseAiAttendance } from "@/hooks/inbox/usePauseAiAttendance";
import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";
import { OwnerBadge } from "@/components/kanban/OwnerBadge";
import { FaixaDaCarteira } from "@/components/inbox/FaixaDaCarteira";
import { comandoDaConversa, ROTULO_DO_MOTIVO } from "@/lib/inbox/comando-da-conversa";
import { ReassignDialog } from "@/components/inbox/ReassignDialog";
import { SnoozeSubmenu } from "@/components/inbox/SnoozeButton";
import { DialButton } from "@/components/voice/DialButton";
import { VideoCallButton } from "@/components/inbox/VideoCallButton";
import { BotaoModoFoco } from "@/components/inbox/BotaoModoFoco";
import { motivoDoContato } from "@/lib/inbox/motivo-do-envio-bloqueado";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloParaAEquipe } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoCanalDaConversa } from "@/lib/channels/estado";

interface Props {
  conversation: ConversationWithContact;
  /**
   * A busca DENTRO da conversa (#1793): abre um campo que filtra só as
   * mensagens já carregadas. O ref devolve o foco a este botão quando o campo
   * fecha — senão o Esc largava o foco no `body`.
   */
  onBuscar?: () => void;
  buscaAberta?: boolean;
  botaoBuscaRef?: RefObject<HTMLButtonElement | null>;
  /** Seleciona outra conversa no Inbox — a aba Número do Transferir abre a do outro número. */
  onAbrirConversa?: (id: string) => void;
  /** Modo foco (PC-011): sem `onAlternarFoco` o botão não aparece. */
  modoFoco?: boolean;
  onAlternarFoco?: () => void;
}

/**
 * O CHIP NOMEIA CICLO DE VIDA, NÃO COMANDO.
 *
 * Ele afirmava quem manda — "Automático atendendo", "Aguardando atendente" — a
 * 20px de um selo que responde a MESMA pergunta por outra fonte, e as duas se
 * contradiziam na tela: `conversations.status` não acompanha silêncio, trava de
 * contato nem atribuição, e o motor nunca o lê. Medido em 2026-08-30 num print
 * do dono: "Aguardando atendente" e "Automático" no mesmo cabeçalho.
 *
 * Quem responde "quem manda" é o `OwnerBadge`, que vem de `comandoDaConversa`.
 * Aqui fica só o que o status realmente sabe: o episódio está aberto ou acabou.
 *
 * Cobre os SETE valores do CHECK de propósito — o call site é
 * `t(STATUS_LABEL[status] ?? status)`, e um buraco imprime o token cru em inglês
 * no rosto do atendente. Vigiado pelo invariante de espelho.
 */
const STATUS_LABEL: Record<string, string> = {
  open: "Aberta",
  pending: "Aberta",
  claimed: "Aberta",
  ai_handling: "Aberta",
  resolved: "Resolvida",
  closed: "Fechada",
  archived: "Arquivada",
};

export function ConversationHeader({
  conversation,
  onAbrirConversa,
  onBuscar,
  buscaAberta,
  botaoBuscaRef,
  modoFoco = false,
  onAlternarFoco,
}: Props) {
  const t = useT();
  const { user, activeOrg } = useAuth();
  const claim = useClaimConversation();
  const release = useReleaseConversation();
  const close = useCloseConversation();
  const reopen = useReopenConversation();
  const arquivar = useArchiveConversation();
  const retomar = useResumeAiAttendance();
  const pausar = usePauseAiAttendance();
  // "Existe automático nesta org?" — sem isto o selo afirmava que o robô estava
  // atendendo em instalação que nunca configurou agente nenhum.
  const automaticoDaOrg = useAutomaticoAtivo();
  const [reassignOpen, setReassignOpen] = useState(false);
  const [confirmFecharOpen, setConfirmFecharOpen] = useState(false);
  const [confirmArquivarOpen, setConfirmArquivarOpen] = useState(false);
  const [confirmPessoalOpen, setConfirmPessoalOpen] = useState(false);

  const c = conversation.contacts ?? null;
  const displayName = rotuloParaAEquipe(c, t);
  /**
   * POR ONDE ESTA CONVERSA ENTROU — o mesmo rótulo da lista e da tela de
   * canais (#2383). `null` quando não há canal, e aí o badge não existe.
   */
  const rotuloCanal = rotuloDoCanalDaConversa(conversation.channel_sessions, t);
  const phone = c?.phone_number ? phoneForDisplay(c.phone_number) : null;
  const status = conversation.status;
  const isMineAssigned = conversation.assigned_to_user_id === user.id;
  const isOpen = status === "open" || conversation.assigned_to_user_id == null;

  // Marcar/desmarcar pessoal (spec 21, etapa 15 — botão no cabeçalho).
  //
  // GERENTE pode (spec decisão 1, D3): pessoal é decisão operacional — esconder
  // uma conversa da operação. Desbloquear exige ADMIN porque reabre um canal
  // que o cliente fechou (direito do titular, LGPD): dois gestos parecidos,
  // dois gates diferentes, cada um com seu motivo.
  //
  // Os hooks ficam AQUI, antes de qualquer early return (a ordem dos hooks não
  // pode mudar entre renderizações); com contato ausente o id vazio nunca
  // dispara porque o botão nem é desenhado.
  const ehPessoal = c?.is_personal === true;
  const podeMarcarPessoal =
    (user.is_platform_admin && !user.support) ||
    (activeOrg != null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager);
  const marcarPessoal = useMarkPersonalContact(c?.id ?? "");
  const desmarcarPessoal = useUnmarkPersonalContact(c?.id ?? "");

  /**
   * QUEM MANDA, uma pergunta com uma resposta.
   *
   * Este bloco era três leituras parciais. O selo e o botão de volta liam duas
   * travas (`bot_silenced_until || force_human`); a linha da lista lia uma, por
   * COR; o painel não lia nenhuma. Desde a 0173 há uma quarta situação —
   * "alguém assumiu" — e continuar somando condições à mão aqui é como as três
   * leituras divergiram em primeiro lugar. A regra mora em `lib/inbox`,
   * espelhando os gates que o MOTOR lê, e esta tela só a consome.
   */
  const fatosDoComando = {
    status,
    assigned_to_user_id: conversation.assigned_to_user_id,
    assigned_to_user_name: conversation.assigned_to_user_name ?? null,
    assignee_kind: conversation.assignee_kind ?? null,
    bot_silenced_until: conversation.bot_silenced_until ?? null,
    last_handoff_reason: conversation.last_handoff_reason ?? null,
    force_human: c?.force_human ?? null,
    is_blocked: conversation.contacts?.is_blocked ?? null,
    is_group: conversation.is_group ?? false,
    automaticoDaOrg: automaticoDaOrg.data,
  };
  const { comando, automaticoAtivo, travaVigente, motivo } = comandoDaConversa(fatosDoComando);
  /**
   * O QUE "LIBERAR" FAZ DEPENDE DO ESTADO, e a guia do botão (#3003) não pode
   * prometer o automático de volta quando ele não volta.
   *
   * `fn_conversation_assign` com dono `null` deixa a conversa aberta e sem dono,
   * mas só limpa `bot_silenced_until` quando NÃO houve escalação
   * (`last_handoff_at is null`). Depois de uma escalação, com o contato travado
   * (`force_human`), descadastrado, em grupo ou numa org sem automático, a
   * conversa cai na fila esperando gente. A pergunta é a mesma regra de quem
   * manda, aplicada ao estado que a RPC vai gravar.
   */
  const liberarDevolveAoAutomatico =
    comandoDaConversa({
      ...fatosDoComando,
      status: "open",
      assigned_to_user_id: null,
      assigned_to_user_name: null,
      assignee_kind: null,
      bot_silenced_until: conversation.last_handoff_at ? fatosDoComando.bot_silenced_until : null,
    }).comando.quem === "automatico";

  const encerrada = status === "closed" || status === "archived" || status === "resolved";
  /**
   * A VOLTA aparece sempre que há algo a devolver — inclusive em conversa
   * ENCERRADA. Antes ela era condicionada a `status !== "closed"`, e o resultado
   * era um beco sem saída medido: atendente assume, fecha, sai de férias; a
   * conversa fica com o automático parado e, para qualquer colega, sem NENHUMA
   * porta — "Liberar" só existe para o próprio dono e a rota recusa quem não é.
   * `devolverAtendimentoAoAgente` funciona nesse estado (o status fechado está na
   * lista de reativáveis), então esconder o botão escondia uma ação que existe.
   *
   * A condição é `travaVigente`, e NÃO `!automaticoAtivo`: conversa encerrada tem
   * o automático inativo sem ter trava nenhuma, e sair do segundo faria o botão
   * aparecer em toda conversa fechada — clicá-lo REABRIRIA uma conversa que
   * ninguém pediu para reabrir. Oferecer uma ação que não deveria acontecer é
   * pior que não oferecer nenhuma.
   */
  const podeDevolver = travaVigente;
  /**
   * PAUSAR só aparece quando pausar é um gesto DIFERENTE de assumir.
   *
   * Desde a 0173 "Assumir" já cala o automático (a RPC grava o silêncio). Numa
   * conversa sem dono, portanto, "Assumir" e "Pausar o automático" teriam
   * exatamente o mesmo efeito — dois botões para um ato é a confusão que esta
   * entrega existe para acabar, não para dobrar.
   *
   * Sobra o caso em que ele é próprio: a conversa JÁ tem dono e o automático
   * continua de pé. Isso é real e não é raro — o rodízio (`reason='routing'`)
   * distribui sem calar, de propósito, senão uma org em round_robin ficaria sem
   * automático nenhum.
   */
  const podePausar =
    automaticoAtivo && !encerrada && conversation.assigned_to_user_id !== null;

  if (user.support?.access_mode === "support_readonly") return <header className="flex items-center justify-between border-b p-4">
    <strong>{displayName}</strong><span className="text-sm text-muted-foreground">{STATUS_LABEL[status] ?? status} · Somente leitura</span>
  </header>;
  // Os selos que não cabem viram "+N" (PC-011). Status fica sempre à vista;
  // janela e canal aparecem soltos a partir do `2xl` e, abaixo disso, dentro do
  // "+N" — com a lista no toque e no passar do mouse.
  const outrosSelos = [
    rotuloCanal ? `${t("Entrou por")} ${rotuloCanal}` : null,
  ].filter((x): x is string => x !== null);
  const tituloDoTelefone = phone ? `${t("Telefone")}: ${phone}` : null;
  const automaticoParado = motivo !== null;

  return (
    // CABEÇALHO COMPACTO (PC-011). Uma linha de identidade e, ao lado dela, a
    // linha de ações; elas só quebram em duas quando a largura não comporta as
    // duas juntas. Antes eram quatro linhas (nome, quem manda, telefone e duas
    // fileiras de botões) e a conversa ficava com o resto.
    //
    // `flex-wrap` continua: o header não pode voltar a impor piso de largura à
    // tela (era o `min-content` de 707px que empurrava a ficha para fora em
    // 1280px). A barra também não é `shrink-0`, pelo mesmo motivo.
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-background px-3 py-1.5 md:px-4">
      {/* FAIXA DA CARTEIRA (#2591, regra 2): só existe quando o dono é OUTRA
          pessoa (o componente decide); `w-full` a põe numa linha própria. */}
      {c?.id && (
        <FaixaDaCarteira contactId={c.id} quemAtendeId={conversation.assigned_to_user_id} />
      )}
      <div className="flex min-w-0 flex-1 basis-56 items-center gap-1.5 overflow-hidden" data-testid="identidade-da-conversa">
        <ChannelLogo channel={conversation.channel_sessions} size={20} />
        <h2 className="min-w-[4rem] truncate text-sm font-semibold" title={displayName}>{displayName}</h2>
        <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px]">
          {t(STATUS_LABEL[status] ?? status)}
        </Badge>
        {/* "Dá para escrever agora?" se pergunta ANTES de digitar. */}
        <span className="hidden shrink-0 2xl:inline-flex">
          <JanelaSelo
            provider={conversation.channel_sessions?.provider ?? null}
            lastInboundAt={conversation.last_inbound_at}
          />
        </span>
        {/* #2383: o canal desta conversa, com o MESMO rótulo da lista e de
            /app/connections. */}
        {rotuloCanal && (
          <Badge
            variant="outline"
            className="hidden h-4 min-w-0 max-w-[9rem] truncate px-1.5 text-[10px] 2xl:inline-flex"
            title={`${t("Entrou por")} ${rotuloCanal}`}
            data-testid="canal-da-conversa"
          >
            <span className="truncate">{rotuloCanal}</span>
          </Badge>
        )}
        <SelosEscondidos
          janela={
            <JanelaSelo
              provider={conversation.channel_sessions?.provider ?? null}
              lastInboundAt={conversation.last_inbound_at}
            />
          }
          outros={outrosSelos}
        />
        {/* QUEM ESTÁ NO COMANDO — à vista, sem passar o mouse: anel vazado =
            automático, disco cheio = pessoa, tracejado = ninguém. O mesmo
            componente do funil e do dossiê, na variante de 16px. */}
        <div className="flex shrink-0 items-center gap-1.5" data-testid="comando-da-conversa">
          {comando.quem === "humano" ? (
            <OwnerBadge compacto ownerKind="user" ownerName={comando.nome ?? t("Atendente")} />
          ) : comando.quem === "automatico" ? (
            <OwnerBadge compacto ownerKind="ai" ownerName={t("Automático")} />
          ) : (
            <OwnerBadge compacto ownerKind={null} ownerName={null} />
          )}
        </div>
        {/* POR QUE O AUTOMÁTICO ESTÁ CALADO — em cor de aviso, para a conversa
            com o robô parado não ter a cara de uma conversa normal. O testid é
            contrato: `escalacao-ciclo.spec.ts` e `inbox-quem-manda.spec.ts`. */}
        {automaticoParado && (
          <Badge
            variant="outline"
            className="h-4 min-w-0 max-w-[11rem] shrink truncate border-warning-fg/40 bg-warning-bg px-1.5 text-[10px] text-warning-fg"
            title={t(ROTULO_DO_MOTIVO[motivo])}
            data-testid="badge-atendimento-humano"
          >
            <span className="truncate">{t(ROTULO_DO_MOTIVO[motivo])}</span>
          </Badge>
        )}
        {phone && tituloDoTelefone && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={tituloDoTelefone}
                title={tituloDoTelefone}
                data-testid="telefone-da-conversa"
              >
                <Phone size={13} weight="regular" aria-hidden />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto px-3 py-2 text-sm">
              <span className="select-all tabular-nums">{phone}</span>
            </PopoverContent>
          </Popover>
        )}
      </div>

      {/* AS AÇÕES, numa linha. À vista ficam a leitura (buscar, ligar, vídeo) e
          os gestos de quem manda — Assumir/Liberar, Devolver/Pausar o
          automático — e Fechar/Reabrir. O resto (Transferir, Lembrar,
          Arquivar, Marcar como pessoal, Ver contato) mora no "⋯", com o mesmo
          efeito e a mesma confirmação de antes (decisão do PC-011).

          No celular a barra é UMA fileira que rola, nunca três ou quatro. */}
      <div className="flex min-w-0 flex-wrap items-center gap-1 max-md:w-full max-md:flex-nowrap max-md:overflow-x-auto max-md:pb-0.5 max-md:[&>*]:shrink-0">
        {onBuscar && (
          <Button
            ref={botaoBuscaRef}
            size="sm"
            variant="ghost"
            className="w-11 px-0 lg:w-8"
            onClick={onBuscar}
            aria-label={t("Buscar nesta conversa")}
            title={t("Buscar nesta conversa")}
            aria-expanded={buscaAberta}
          >
            <MagnifyingGlass size={16} aria-hidden />
          </Button>
        )}
        {/* A chamada usa o telefone da ficha; grupo não é pessoa para ligar. */}
        {!conversation.is_group && c?.id && (
          <DialButton contactId={c.id} hasPhone={!!c.phone_number} />
        )}
        {/* Videochamada (#2440): sem JITSI_SERVER_URL não renderiza. Segue a
            MESMA régua do composer (janela, trava de contato, encerrada). */}
        <VideoCallButton
          conversationId={conversation.id}
          provider={conversation.channel_sessions?.provider ?? null}
          lastInboundAt={conversation.last_inbound_at}
          bloqueio={motivoDoContato(c, t)}
          encerrada={status === "closed"}
        />
        {isOpen && (
          <Button
            size="sm"
            variant="default"
            disabled={claim.isPending}
            // Desde a 0173 assumir também para o atendimento automático; o
            // rótulo é contrato, a consequência vai na guia.
            title={t("Você passa a responder esta conversa e o atendimento automático para aqui.")}
            onClick={() =>
              claim.mutate({
                conversation_id: conversation.id,
                expected_assignee: conversation.assigned_to_user_id,
              })
            }
          >
            {t("Assumir")}
          </Button>
        )}
        {isMineAssigned && (
          <Button
            size="sm"
            variant="outline"
            disabled={release.isPending}
            // GUIA CURTA (#3003): a guia diz para onde a conversa vai.
            title={
              liberarDevolveAoAutomatico
                ? t("Solta esta conversa: ela fica sem dono e o atendimento automático volta a responder.")
                : t("Solta esta conversa: ela fica sem dono e volta para a fila, esperando um atendente.")
            }
            onClick={() => release.mutate({ conversation_id: conversation.id })}
          >
            {t("Liberar")}
          </Button>
        )}
        {/* O INTERRUPTOR do automático: um slot, dois estados exclusivos.
            Abaixo do `2xl` o rótulo visível encurta ("Devolver", "Pausar") para
            caber na linha; o nome acessível é sempre o completo. */}
        {podeDevolver && (
          <Button
            size="sm"
            variant="outline"
            disabled={retomar.isPending}
            data-testid="devolver-ao-automatico"
            title={
              motivo === "contato_travado"
                ? t("Religa o atendimento automático para este cliente — vale para todas as conversas dele.")
                : t("Devolve esta conversa ao atendimento automático.")
            }
            onClick={() => retomar.mutate({ conversation_id: conversation.id })}
          >
            {/* O rótulo completo aparece UMA vez: é o nome do botão para quem
                usa leitor de tela, e a frase que a Central e o resumo da
                passagem citam (`handoff-por-orcamento.test.ts` confere). */}
            <span className="2xl:hidden" aria-hidden>
              {retomar.isPending ? t("Devolvendo...") : t("Devolver")}
            </span>
            <span className="sr-only 2xl:not-sr-only">
              {retomar.isPending ? t("Devolvendo...") : t("Devolver ao automático")}
            </span>
          </Button>
        )}
        {podePausar && (
          <Button
            size="sm"
            variant="outline"
            disabled={pausar.isPending}
            data-testid="pausar-o-automatico"
            title={t("O atendimento automático para nesta conversa. O dono não muda.")}
            onClick={() => pausar.mutate({ conversation_id: conversation.id })}
          >
            <span className="2xl:hidden" aria-hidden>
              {pausar.isPending ? t("Pausando...") : t("Pausar")}
            </span>
            <span className="sr-only 2xl:not-sr-only">
              {pausar.isPending ? t("Pausando...") : t("Pausar o automático")}
            </span>
          </Button>
        )}
        {!encerrada && (
          <Button
            size="sm"
            variant="outline"
            disabled={close.isPending}
            // GUIA CURTA (#3003): distingue encerrar de arquivar.
            title={t("Encerra o atendimento. Depois você pode reabrir a conversa.")}
            onClick={() => setConfirmFecharOpen(true)}
          >
            {t("Fechar")}
          </Button>
        )}
        {encerrada && <Button size="sm" variant="outline" disabled={reopen.isPending}
          title={t("Reabre o atendimento desta conversa, que estava encerrada.")}
          onClick={() => reopen.mutate({ conversation_id: conversation.id, expected_revision: conversation.service_revision })}>
          {t("Reabrir")}
        </Button>}
        {onAlternarFoco && (
          <BotaoModoFoco ligado={modoFoco} onAlternar={onAlternarFoco} className="max-md:hidden" />
        )}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="w-11 px-0 lg:w-8"
              aria-label={t("Mais ações")}
              title={t("Mais ações")}
              data-testid="mais-acoes-da-conversa"
            >
              <DotsThree size={18} weight="bold" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            {!encerrada && (
              <DropdownMenuItem
                // GUIA CURTA (#3003): a aba Número do diálogo continua o
                // atendimento do contato por outro número conectado.
                title={t("Passa esta conversa para outro atendente. Se houver outro número conectado, dá para continuar o atendimento por ele.")}
                onSelect={() => setReassignOpen(true)}
              >
                <ArrowsLeftRight size={14} aria-hidden />
                {t("Transferir")}
              </DropdownMenuItem>
            )}
            {!encerrada && (
              <SnoozeSubmenu
                conversationId={conversation.id}
                snoozeUntil={conversation.snooze_until ?? null}
              />
            )}
            {/* ARQUIVAR (#923): tira da frente sem destruir; numa conversa
                aberta ENCERRA o atendimento — a confirmação diz isso. */}
            {status !== "archived" && (
              <DropdownMenuItem
                disabled={arquivar.isPending}
                title={t("Guarda a conversa na aba Arquivadas. Se ainda estiver aberta, o atendimento é encerrado.")}
                onSelect={() => setConfirmArquivarOpen(true)}
              >
                <Archive size={14} aria-hidden />
                {arquivar.isPending ? t("Arquivando...") : t("Arquivar")}
              </DropdownMenuItem>
            )}
            {/* PESSOAL (spec 21, etapa 15). Os `data-testid` são contrato do
                e2e `contato-pessoal-sai-da-operacao.spec.ts`. */}
            {podeMarcarPessoal && c?.id && !ehPessoal && (
              <DropdownMenuItem
                disabled={marcarPessoal.isPending}
                data-testid="marcar-pessoal"
                title={t("Tira este contato da operação: a conversa sai do inbox.")}
                onSelect={() => setConfirmPessoalOpen(true)}
              >
                <UserCircle size={14} aria-hidden />
                {t("Marcar como pessoal")}
              </DropdownMenuItem>
            )}
            {podeMarcarPessoal && c?.id && ehPessoal && (
              <DropdownMenuItem
                disabled={desmarcarPessoal.isPending}
                data-testid="desmarcar-pessoal"
                title={t("Devolve este contato à operação: a conversa volta ao inbox.")}
                onSelect={() => desmarcarPessoal.mutate()}
              >
                <UserCircle size={14} aria-hidden />
                {desmarcarPessoal.isPending ? t("Desmarcando...") : t("Desmarcar pessoal")}
              </DropdownMenuItem>
            )}
            {c?.id && (
              <DropdownMenuItem asChild>
                <Link
                  href={`/app/contacts/${c.id}`}
                  title={t("Abre a ficha completa deste contato.")}
                >
                  <ArrowRight size={14} weight="regular" aria-hidden />
                  {t("Ver contato")}
                </Link>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ReassignDialog
        conversationId={conversation.id}
        open={reassignOpen}
        onOpenChange={setReassignOpen}
        numero={
          onAbrirConversa && c?.id
            ? {
                contactId: c.id,
                contactPhone: c.phone_number ?? null,
                channelSessionId: conversation.channel_session_id,
                onAbrirConversa,
              }
            : undefined
        }
      />
      <AlertDialog open={confirmFecharOpen} onOpenChange={setConfirmFecharOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Fechar esta conversa?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("O atendimento é encerrado. Se o cliente escrever de novo, você pode reabrir.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                close.mutate({
                  conversation_id: conversation.id,
                  expected_revision: conversation.service_revision,
                })
              }
            >
              {t("Fechar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* A confirmação precisa dizer o que ACONTECE, e o que acontece depende
          do estado. `fn_conversation_set_status` trata `archived` como
          terminal: encerra o atendimento (grava `service_closed_at`,
          incrementa a revisão) e, com isso, desfaz a pausa do automático. Um
          atendente que leia "arquivar = tirar da vista, volto depois"
          encerraria o atendimento sem saber — e o robô voltaria a responder
          no próximo "oi" do cliente. Por isso a descrição só aparece quando
          `!encerrada`: quando já está encerrada, arquivar não muda o
          atendimento, só o lugar onde a conversa mora. */}
      <AlertDialog open={confirmArquivarOpen} onOpenChange={setConfirmArquivarOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Arquivar esta conversa?")}</AlertDialogTitle>
            {!encerrada && (
              <AlertDialogDescription>
                {t(
                  "Arquivar encerra este atendimento e guarda a conversa no histórico. Se o cliente escrever de novo, ela volta.",
                )}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                arquivar.mutate({
                  conversation_id: conversation.id,
                  expected_revision: conversation.service_revision,
                })
              }
            >
              {t("Arquivar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* A confirmação diz o que ACONTECE ao marcar: a conversa fecha e sai do
          atendente, e o contato fica inutilizado para envio — sem apagar nada.
          Desmarcar é direto no botão porque só relista o que já está lá. */}
      <AlertDialog open={confirmPessoalOpen} onOpenChange={setConfirmPessoalOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Marcar este contato como pessoal?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "A conversa sai do inbox e o contato fica fora da operação: sem IA, sem follow-up, sem campanha e sem envio. O histórico continua no banco e volta à vista ao desmarcar; follow-ups e campanhas cancelados não voltam.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => marcarPessoal.mutate()}>
              {t("Marcar como pessoal")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * "+N" DOS SELOS QUE NÃO CABEM (PC-011). Abaixo do `2xl` a janela de 24 h e o
 * canal saem da linha do nome e vêm para cá; o número diz quantos são, o
 * `title` os lista no passar do mouse e o toque abre a lista. A partir do `2xl`
 * eles voltam soltos na linha e este botão some.
 */
function SelosEscondidos({ janela, outros }: { janela: ReactNode; outros: string[] }) {
  const t = useT();
  const total = 1 + outros.length;
  const lista = [t("Janela de resposta"), ...outros].join(" · ");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-4 shrink-0 items-center rounded-full border border-border px-1.5 text-[10px] font-medium text-muted-foreground hover:bg-muted 2xl:hidden"
          aria-label={`${t("Mais detalhes")}: ${lista}`}
          title={lista}
          data-testid="selos-escondidos"
        >
          +{total}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-auto max-w-72 flex-col items-start gap-1.5 px-3 py-2 text-xs">
        {janela}
        {outros.map((o) => (
          <span key={o} className="text-muted-foreground">
            {o}
          </span>
        ))}
      </PopoverContent>
    </Popover>
  );
}
