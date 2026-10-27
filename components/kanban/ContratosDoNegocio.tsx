"use client";

import { useId, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useContratosDoLead } from "@/hooks/kanban/useContratosDoLead";
import type { ContratoDoNegocio } from "@/lib/contratos/tipos";
import { TAMANHO_MAXIMO_DO_CONTRATO, type StatusDoContrato } from "@/lib/contratos/vocabulario";
import { FileText, Plus } from "@/lib/ui/icons";

interface Props {
  leadId: string;
  /** Anexar, enviar e marcar o desfecho — `agent`+, a mesma régua das rotas ("qualquer atendente"). */
  podeEditar: boolean;
  /** O dossiê aberto. Fechado, a consulta não sai. */
  aberto: boolean;
}

type Acao = "enviar" | "assinar" | "recusar" | "cancelar";

type T = (texto: string) => string;

function rotuloDoStatus(status: StatusDoContrato, t: T): string {
  switch (status) {
    case "rascunho":
      return t("Ainda não enviado");
    case "enviado":
      return t("Aguardando assinatura");
    case "assinado":
      return t("Assinado");
    case "recusado":
      return t("Recusado");
    case "cancelado":
      return t("Cancelado");
  }
}

function varianteDoStatus(status: StatusDoContrato): "neutral" | "warning" | "success" | "error" | "secondary" {
  if (status === "enviado") return "warning";
  if (status === "assinado") return "success";
  if (status === "recusado") return "error";
  if (status === "cancelado") return "secondary";
  return "neutral";
}

/** A entrega lida da MENSAGEM do envio — o que o cliente de fato recebeu. */
function frasesDaEntrega(contrato: ContratoDoNegocio, t: T): { texto: string; erro: boolean } | null {
  const e = contrato.entrega;
  if (!e || contrato.status !== "enviado") return null;
  switch (e.status) {
    case "queued":
      return { texto: t("Na fila: sai assim que a conexão do WhatsApp voltar."), erro: false };
    case "sending":
      return { texto: t("Saindo pelo WhatsApp…"), erro: false };
    case "sent":
      return { texto: t("Enviado pelo WhatsApp."), erro: false };
    case "delivered":
      return { texto: t("Entregue ao cliente."), erro: false };
    case "read":
      return { texto: t("Lido pelo cliente."), erro: false };
    case "failed":
      return {
        texto: `${t("O WhatsApp não entregou")}${e.erro ? `: ${e.erro}` : ""}. ${t("Envie de novo.")}`,
        erro: true,
      };
  }
}

/**
 * A seção "Contratos" do dossiê do negócio (fork, migration 9008 — item 7 do
 * briefing de 26/10/2026).
 *
 * O escritório anexa o PDF do PRÓPRIO contrato, uma pessoa envia ao cliente
 * pelo WhatsApp, e depois alguém marca assinado (com a via assinada, se tiver)
 * ou recusado. Cada passo entra na linha do tempo do negócio. Nenhum agente de
 * IA envia contrato: as rotas são de sessão.
 *
 * Fica logo depois das Tarefas, e não no fim da coluna como as Propostas: um
 * contrato esperando assinatura é PRÓXIMO PASSO, e no fim da coluna ele ficaria
 * debaixo da linha do tempo inteira.
 */
export function ContratosDoNegocio({ leadId, podeEditar, aberto }: Props) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const { lista, anexar, enviar, decidir } = useContratosDoLead(leadId, aberto);
  const contratos = lista.data ?? [];
  const aguardando = contratos.filter((c) => c.status === "enviado").length;

  const [anexando, setAnexando] = useState(false);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [titulo, setTitulo] = useState("");
  const [erroDoArquivo, setErroDoArquivo] = useState<string | null>(null);
  const inputDoArquivo = useRef<HTMLInputElement>(null);

  const [painel, setPainel] = useState<{ contratoId: string; acao: Acao } | null>(null);
  const [mensagem, setMensagem] = useState("");
  const [motivo, setMotivo] = useState("");
  const [viaAssinada, setViaAssinada] = useState<File | null>(null);

  const idBase = useId();
  const quando = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(tagDoIdioma, { dateStyle: "short", timeStyle: "short" }) : "";

  function fecharAnexo() {
    setAnexando(false);
    setArquivo(null);
    setTitulo("");
    setErroDoArquivo(null);
    if (inputDoArquivo.current) inputDoArquivo.current.value = "";
  }

  function escolherArquivo(f: File | null) {
    setErroDoArquivo(null);
    setArquivo(f);
    if (!f) return;
    if (f.type && f.type !== "application/pdf") {
      setErroDoArquivo(t("O contrato precisa ser um arquivo PDF."));
    } else if (f.size > TAMANHO_MAXIMO_DO_CONTRATO) {
      setErroDoArquivo(t("O contrato passa de 20 MB."));
    }
    if (!titulo.trim()) setTitulo(f.name.replace(/\.pdf$/i, "").slice(0, 120));
  }

  async function confirmarAnexo() {
    if (!arquivo || erroDoArquivo || !titulo.trim()) return;
    try {
      await anexar.mutateAsync({ arquivo, titulo: titulo.trim() });
      fecharAnexo();
    } catch {
      /* o toast já disse o motivo; o formulário fica aberto para corrigir */
    }
  }

  function abrirPainel(contratoId: string, acao: Acao) {
    setPainel({ contratoId, acao });
    setMensagem(acao === "enviar" ? t("Segue o contrato para sua assinatura. Qualquer dúvida, é só me chamar.") : "");
    setMotivo("");
    setViaAssinada(null);
  }

  async function confirmarPainel(contrato: ContratoDoNegocio) {
    if (!painel) return;
    try {
      if (painel.acao === "enviar") {
        await enviar.mutateAsync({ contratoId: contrato.id, mensagem });
      } else {
        const desfecho = painel.acao === "assinar" ? "assinado" : painel.acao === "recusar" ? "recusado" : "cancelado";
        await decidir.mutateAsync({ contratoId: contrato.id, desfecho, motivo, viaAssinada });
      }
      setPainel(null);
    } catch {
      /* o toast já disse o motivo */
    }
  }

  const ocupado = enviar.isPending || decidir.isPending;

  return (
    <section className="border-b border-border py-3" aria-labelledby={`${idBase}-titulo`} data-testid="contratos-do-negocio">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 id={`${idBase}-titulo`} className="text-xs font-medium uppercase tracking-wide text-text-muted">
          {t("Contratos")}
          {aguardando > 0 ? (
            <span className="ml-1.5 normal-case tracking-normal">
              · {aguardando} {aguardando === 1 ? t("aguardando assinatura") : t("aguardando assinaturas")}
            </span>
          ) : null}
        </h3>
        {podeEditar && !anexando ? (
          <button
            type="button"
            onClick={() => setAnexando(true)}
            className="flex items-center gap-1 text-xs font-medium text-accent hover:underline"
          >
            <Plus size={12} aria-hidden />
            {t("Anexar contrato")}
          </button>
        ) : null}
      </div>

      {anexando ? (
        <div className="mb-3 space-y-2 rounded-md border border-border bg-surface-elevated p-3">
          <div className="space-y-1">
            <label htmlFor={`${idBase}-arquivo`} className="text-xs font-medium text-text">
              {t("Arquivo do contrato (PDF, até 20 MB)")}
            </label>
            <input
              ref={inputDoArquivo}
              id={`${idBase}-arquivo`}
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => escolherArquivo(e.target.files?.[0] ?? null)}
              className="block w-full text-xs text-text file:mr-2 file:rounded file:border file:border-border file:bg-surface file:px-2 file:py-1 file:text-xs"
            />
            {erroDoArquivo ? <p className="text-xs text-destructive">{erroDoArquivo}</p> : null}
          </div>
          <div className="space-y-1">
            <label htmlFor={`${idBase}-nome`} className="text-xs font-medium text-text">
              {t("Nome do contrato")}
            </label>
            <Input
              id={`${idBase}-nome`}
              value={titulo}
              maxLength={120}
              onChange={(e) => setTitulo(e.target.value)}
              placeholder={t("Ex.: Contrato de honorários")}
              className="h-9 text-xs"
            />
            <p className="text-[11px] text-text-muted">
              {t("É o nome com que o arquivo chega ao cliente no WhatsApp.")}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={fecharAnexo} disabled={anexar.isPending}>
              {t("Cancelar")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={confirmarAnexo}
              disabled={!arquivo || !!erroDoArquivo || !titulo.trim() || anexar.isPending}
            >
              {anexar.isPending ? t("Anexando…") : t("Anexar")}
            </Button>
          </div>
        </div>
      ) : null}

      {lista.isError ? (
        <p className="text-xs text-destructive">{t("Não foi possível carregar os contratos.")}</p>
      ) : lista.isLoading ? (
        <p className="text-xs text-text-muted" aria-busy>
          {t("Carregando…")}
        </p>
      ) : contratos.length === 0 ? (
        <p className="text-xs text-text-muted">
          {t("Nenhum contrato neste negócio. Anexe o PDF do escritório para enviar ao cliente pelo WhatsApp.")}
        </p>
      ) : (
        <ul className="space-y-2">
          {contratos.map((c) => {
            const entrega = frasesDaEntrega(c, t);
            const aberta = painel?.contratoId === c.id ? painel.acao : null;
            return (
              <li
                key={c.id}
                className="rounded-md border border-border p-2.5"
                data-testid={`contrato-${c.id}`}
                data-contrato-status={c.status}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-text">
                      <FileText size={14} aria-hidden className="shrink-0 text-text-muted" />
                      <span className="truncate">{c.titulo}</span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-text-muted">
                      {c.status === "rascunho" && `${t("Anexado em")} ${quando(c.created_at)}`}
                      {c.status === "enviado" && `${t("Enviado em")} ${quando(c.enviado_em)}`}
                      {c.status === "assinado" && `${t("Assinado em")} ${quando(c.decidido_em)}`}
                      {c.status === "recusado" && `${t("Recusado em")} ${quando(c.decidido_em)}`}
                      {c.status === "cancelado" && `${t("Cancelado em")} ${quando(c.decidido_em)}`}
                    </p>
                  </div>
                  <Badge variant={varianteDoStatus(c.status)} className="shrink-0 text-[11px]">
                    {rotuloDoStatus(c.status, t)}
                  </Badge>
                </div>

                {entrega ? (
                  <p className={`mt-1 text-[11px] ${entrega.erro ? "text-destructive" : "text-text-muted"}`}>
                    {entrega.texto}
                  </p>
                ) : null}
                {c.ultima_falha_envio && (c.status === "rascunho" || c.status === "enviado") ? (
                  <p className="mt-1 text-[11px] text-destructive" role="status">
                    {t("O último envio não saiu")}: {c.ultima_falha_envio}
                  </p>
                ) : null}
                {c.motivo && (c.status === "recusado" || c.status === "cancelado") ? (
                  <p className="mt-1 text-[11px] text-text-muted">
                    {t("Motivo")}: {c.motivo}
                  </p>
                ) : null}

                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                  {c.tem_arquivo ? (
                    <a
                      href={`/api/v1/contracts/${c.id}/arquivo`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-accent hover:underline"
                    >
                      {t("Abrir PDF")}
                    </a>
                  ) : (
                    <span className="text-text-muted">{t("Arquivo removido")}</span>
                  )}
                  {c.tem_assinado ? (
                    <a
                      href={`/api/v1/contracts/${c.id}/arquivo?via=assinada`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-accent hover:underline"
                    >
                      {t("Abrir via assinada")}
                    </a>
                  ) : null}
                </div>

                {podeEditar && !aberta && (c.status === "rascunho" || c.status === "enviado") ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {c.tem_arquivo ? (
                      <Button type="button" size="sm" variant={c.status === "rascunho" ? "primary" : "outline"} onClick={() => abrirPainel(c.id, "enviar")}>
                        {c.status === "rascunho" ? t("Enviar ao cliente") : t("Enviar de novo")}
                      </Button>
                    ) : null}
                    {c.status === "enviado" && c.desfecho_por_pessoa ? (
                      <>
                        <Button type="button" size="sm" onClick={() => abrirPainel(c.id, "assinar")}>
                          {t("Marcar como assinado")}
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => abrirPainel(c.id, "recusar")}>
                          {t("Marcar como recusado")}
                        </Button>
                      </>
                    ) : null}
                    <Button type="button" size="sm" variant="ghost" onClick={() => abrirPainel(c.id, "cancelar")}>
                      {t("Cancelar contrato")}
                    </Button>
                  </div>
                ) : null}

                {aberta ? (
                  <div className="mt-2 space-y-2 rounded-md border border-border bg-surface-elevated p-2.5">
                    {aberta === "enviar" ? (
                      <>
                        <label htmlFor={`${idBase}-${c.id}-msg`} className="text-xs font-medium text-text">
                          {t("Mensagem que vai junto com o arquivo (opcional)")}
                        </label>
                        <Textarea
                          id={`${idBase}-${c.id}-msg`}
                          value={mensagem}
                          maxLength={1000}
                          rows={3}
                          onChange={(e) => setMensagem(e.target.value)}
                          className="text-xs"
                        />
                        <p className="text-[11px] text-text-muted">
                          {t("Sai pelo WhatsApp da conversa deste cliente, em seu nome.")}
                        </p>
                      </>
                    ) : null}
                    {aberta === "assinar" ? (
                      <>
                        <label htmlFor={`${idBase}-${c.id}-via`} className="text-xs font-medium text-text">
                          {t("Via assinada em PDF (opcional)")}
                        </label>
                        <input
                          id={`${idBase}-${c.id}-via`}
                          type="file"
                          accept="application/pdf,.pdf"
                          onChange={(e) => setViaAssinada(e.target.files?.[0] ?? null)}
                          className="block w-full text-xs text-text file:mr-2 file:rounded file:border file:border-border file:bg-surface file:px-2 file:py-1 file:text-xs"
                        />
                      </>
                    ) : null}
                    {aberta === "recusar" || aberta === "cancelar" ? (
                      <>
                        <label htmlFor={`${idBase}-${c.id}-motivo`} className="text-xs font-medium text-text">
                          {aberta === "recusar" ? t("Por que o cliente recusou? (opcional)") : t("Por que cancelar? (opcional)")}
                        </label>
                        <Textarea
                          id={`${idBase}-${c.id}-motivo`}
                          value={motivo}
                          maxLength={500}
                          rows={2}
                          onChange={(e) => setMotivo(e.target.value)}
                          className="text-xs"
                        />
                      </>
                    ) : null}
                    <div className="flex justify-end gap-2">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setPainel(null)} disabled={ocupado}>
                        {t("Voltar")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={aberta === "cancelar" || aberta === "recusar" ? "destructive" : "primary"}
                        onClick={() => confirmarPainel(c)}
                        disabled={ocupado}
                      >
                        {aberta === "enviar"
                          ? enviar.isPending
                            ? t("Enviando…")
                            : t("Enviar pelo WhatsApp")
                          : aberta === "assinar"
                            ? t("Confirmar assinatura")
                            : aberta === "recusar"
                              ? t("Confirmar recusa")
                              : t("Confirmar cancelamento")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
