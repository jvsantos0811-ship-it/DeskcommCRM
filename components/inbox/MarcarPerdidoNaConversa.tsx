"use client";
import { useEffect, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { XCircle } from "@/lib/ui/icons";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { LoseLeadDialog } from "@/components/kanban/LoseLeadDialog";
import { EVENTO_NEGOCIO_MUDOU } from "@/lib/inbox/evento-negocio-mudou";

/**
 * MARCAR COMO PERDIDO SEM SAIR DO INBOX (PC-024, item 2).
 *
 * ─── Por que existe ──────────────────────────────────────────────────────────
 *
 * Quem conversa com o cliente é quem sabe que ele desistiu — e, para registrar,
 * saía do Inbox, achava o card no funil e voltava. O painel do CRM à direita já
 * deixava escolher a etapa de perda no seletor de etapa, mas escondido: ninguém
 * procura "perdido" dentro de um seletor de etapa.
 *
 * ─── O mesmo diálogo e o mesmo serviço do funil ──────────────────────────────
 *
 * A escrita é o `LoseLeadDialog` do quadro, sem cópia: motivo obrigatório da
 * lista DO FUNIL DO CARD (`motivos_de_perda` vem com cada negócio), detalhe
 * opcional em "Outro", `POST /leads/{id}/lose` — o mesmo efeito, a mesma linha
 * do tempo, a mesma auditoria e a mesma etapa de perda do funil certo.
 *
 * ─── Qual negócio ────────────────────────────────────────────────────────────
 *
 * Os negócios ABERTOS do contato vêm da mesma leitura do painel do CRM
 * (`/contacts/{id}/crm-summary`, RLS do usuário). Um só: abre o motivo direto.
 * Vários: escolhe qual antes. Nenhum: o item fica desabilitado com a explicação.
 *
 * ─── Por que sem react-query aqui ────────────────────────────────────────────
 *
 * O item mora no "⋯" do cabeçalho, que o Radix só monta ao abrir: a leitura
 * acontece quando o menu abre, e não a cada conversa selecionada. O diálogo (que
 * usa a mutação do quadro) só é montado quando aberto.
 */

export interface NegocioAberto {
  id: string;
  title: string;
  pipeline_id: string;
  funil_nome: string | null;
  etapa_nome: string | null;
  motivos_de_perda?: string[];
}

interface LinhaDoResumo extends NegocioAberto {
  status: string;
}

type Leitura =
  | { estado: "lendo" }
  | { estado: "erro" }
  | { estado: "pronto"; abertos: NegocioAberto[] };


export function ItemMarcarPerdido({
  contactId,
  onEscolher,
}: {
  contactId: string;
  onEscolher: (abertos: NegocioAberto[]) => void;
}) {
  const t = useT();
  const [leitura, setLeitura] = useState<Leitura>({ estado: "lendo" });

  useEffect(() => {
    let cancelado = false;
    apiClient
      .get<{ data: { leads: LinhaDoResumo[] } }>(`/api/v1/contacts/${contactId}/crm-summary`, {
        semDesvioDeSuspensao: true,
      })
      .then((r) => {
        if (cancelado) return;
        const abertos = (r.data.leads ?? [])
          .filter((l) => l.status === "open")
          .map(({ id, title, pipeline_id, funil_nome, etapa_nome, motivos_de_perda }) => ({
            id,
            title,
            pipeline_id,
            funil_nome,
            etapa_nome,
            motivos_de_perda,
          }));
        setLeitura({ estado: "pronto", abertos });
      })
      .catch(() => {
        if (!cancelado) setLeitura({ estado: "erro" });
      });
    return () => {
      cancelado = true;
    };
  }, [contactId]);

  const abertos = leitura.estado === "pronto" ? leitura.abertos : [];
  const desabilitado = leitura.estado !== "pronto" || abertos.length === 0;
  const guia =
    leitura.estado === "lendo"
      ? t("Procurando os negócios abertos deste contato…")
      : leitura.estado === "erro"
        ? t("Não consegui ler os negócios deste contato. Feche o menu e tente de novo.")
        : abertos.length === 0
          ? t("Este contato não tem negócio aberto no funil.")
          : t("Registra que o negócio não fechou, com o motivo — igual a marcar perdido no funil.");

  return (
    <DropdownMenuItem
      disabled={desabilitado}
      title={guia}
      data-testid="marcar-perdido-na-conversa"
      onSelect={() => {
        if (!desabilitado) onEscolher(abertos);
      }}
    >
      <XCircle size={14} aria-hidden />
      {t("Marcar como perdido")}
    </DropdownMenuItem>
  );
}

/** Escolhe o negócio (quando há mais de um) e abre o MESMO diálogo do funil. */
export function MarcarPerdidoDialogo({
  abertos,
  onFechar,
}: {
  abertos: NegocioAberto[];
  onFechar: () => void;
}) {
  const t = useT();
  const [escolhido, setEscolhido] = useState<NegocioAberto | null>(
    abertos.length === 1 ? (abertos[0] ?? null) : null,
  );
  const [marcado, setMarcado] = useState<string>("");

  if (escolhido) {
    return (
      <LoseLeadDialog
        open
        onOpenChange={(aberto) => {
          if (!aberto) onFechar();
        }}
        leadId={escolhido.id}
        pipelineId={escolhido.pipeline_id}
        motivos={escolhido.motivos_de_perda}
        onPerdido={() => {
          window.dispatchEvent(new CustomEvent(EVENTO_NEGOCIO_MUDOU));
        }}
      />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(aberto) => {
        if (!aberto) onFechar();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Qual negócio não fechou?")}</DialogTitle>
          <DialogDescription>
            {t("Este contato tem mais de um negócio aberto. Escolha qual marcar como perdido.")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5" role="radiogroup" aria-label={t("Negócios abertos")}>
          {abertos.map((n) => (
            <label
              key={n.id}
              className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent"
            >
              <input
                type="radio"
                name="negocio-perdido"
                value={n.id}
                checked={marcado === n.id}
                onChange={() => setMarcado(n.id)}
                className="mt-1"
              />
              <span className="min-w-0">
                <span className="block truncate font-medium">{n.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[n.funil_nome, n.etapa_nome].filter(Boolean).join(" · ")}
                </span>
              </span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onFechar}>
            {t("Cancelar")}
          </Button>
          <Button
            disabled={!marcado}
            data-testid="escolher-negocio-perdido"
            onClick={() => setEscolhido(abertos.find((n) => n.id === marcado) ?? null)}
          >
            {t("Continuar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
