"use client";
/**
 * "DEPOIS DE MARCAR" (PC-052 parte 3) — a sequência de cada tipo de atendimento
 * (vídeo e imagens na noite da marcação, confirmação em hora fixa) e a mídia do
 * aquecimento da organização. Ver `lib/agenda/sequencia.ts` e
 * `lib/agenda/midia-do-aquecimento.ts`.
 *
 * Desligado (o padrão) = nada sai. Todo membro vê o que está valendo; mudar é de
 * `manager` para cima, a mesma régua das rotas — quem não pode não vê o botão.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

interface ConfigNaTela {
  aquecimento: { ativo: boolean; hora: string; texto: string | null };
  confirmacao: {
    ativo: boolean;
    corte: string;
    hora_vespera: string;
    hora_do_dia: string;
    texto_vespera: string | null;
    texto_do_dia: string | null;
  };
}

interface TipoNaTela {
  tipo_id: string;
  nome: string;
  ativo: boolean;
  ligada: boolean;
  config: ConfigNaTela;
}

interface MidiaNaTela {
  video: { url: string | null; bytes: number } | null;
  imagens: Array<{ indice: number; url: string | null; bytes: number }>;
  maximo_de_imagens: number;
}

function megas(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TipoDaSequencia({ tipo, podeMudar }: { tipo: TipoNaTela; podeMudar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [ligada, setLigada] = React.useState(tipo.ligada);
  const [c, setC] = React.useState<ConfigNaTela>(tipo.config);
  const [salvando, setSalvando] = React.useState(false);

  const aq = (parcial: Partial<ConfigNaTela["aquecimento"]>) =>
    setC((v) => ({ ...v, aquecimento: { ...v.aquecimento, ...parcial } }));
  const co = (parcial: Partial<ConfigNaTela["confirmacao"]>) =>
    setC((v) => ({ ...v, confirmacao: { ...v.confirmacao, ...parcial } }));

  async function salvar() {
    setSalvando(true);
    try {
      await apiClient.patch("/api/v1/agenda/sequencia", { tipo_id: tipo.tipo_id, ligada, config: c });
      toast.success(t("Sequência salva"));
      await qc.invalidateQueries({ queryKey: ["agenda-sequencia"] });
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  const travado = !podeMudar || salvando;
  return (
    <li className="space-y-3 py-4" data-testid={`sequencia-${tipo.tipo_id}`}>
      <div className="flex items-center gap-3">
        <Switch
          checked={ligada}
          onCheckedChange={setLigada}
          disabled={travado}
          aria-label={t("Ligar a sequência deste tipo")}
          data-testid="sequencia-ligada"
        />
        <p className="text-sm font-medium">
          {tipo.nome}
          {tipo.ativo ? null : <span className="text-text-muted"> · {t("inativo")}</span>}
        </p>
      </div>
      {ligada ? (
        <div className="grid gap-4 pl-12 md:grid-cols-2">
          <fieldset className="space-y-2" disabled={travado}>
            <label className="flex items-center gap-2 text-sm font-medium">
              <Switch checked={c.aquecimento.ativo} onCheckedChange={(v) => aq({ ativo: v })} disabled={travado} />
              {t("Vídeo e imagens na noite da marcação")}
            </label>
            <label className="flex items-center gap-2 text-xs text-text-muted">
              {t("Hora")}
              <Input
                type="time"
                className="w-28"
                value={c.aquecimento.hora}
                onChange={(e) => aq({ hora: e.target.value })}
              />
            </label>
            <p className="text-xs text-text-muted">
              {t("Reunião no mesmo dia da marcação: sai logo depois de marcar.")}
            </p>
            <Textarea
              rows={3}
              placeholder={t("Texto antes do vídeo (opcional)")}
              value={c.aquecimento.texto ?? ""}
              onChange={(e) => aq({ texto: e.target.value })}
            />
          </fieldset>
          <fieldset className="space-y-2" disabled={travado}>
            <label className="flex items-center gap-2 text-sm font-medium">
              <Switch checked={c.confirmacao.ativo} onCheckedChange={(v) => co({ ativo: v })} disabled={travado} />
              {t("Confirmação em hora fixa")}
            </label>
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
              <span>{t("Reunião antes de")}</span>
              <Input type="time" className="w-28" value={c.confirmacao.corte} onChange={(e) => co({ corte: e.target.value })} />
              <span>{t("confirma na véspera às")}</span>
              <Input
                type="time"
                className="w-28"
                value={c.confirmacao.hora_vespera}
                onChange={(e) => co({ hora_vespera: e.target.value })}
              />
              <span>{t("; depois disso, no mesmo dia às")}</span>
              <Input
                type="time"
                className="w-28"
                value={c.confirmacao.hora_do_dia}
                onChange={(e) => co({ hora_do_dia: e.target.value })}
              />
            </div>
            <p className="text-xs text-text-muted">
              {t("Véspera sem envio (domingo, se o número não manda no domingo): sai no último dia com envio antes dela.")}
            </p>
            <Textarea
              rows={3}
              placeholder={t("Texto da véspera (vazio = o texto padrão)")}
              value={c.confirmacao.texto_vespera ?? ""}
              onChange={(e) => co({ texto_vespera: e.target.value })}
            />
            <Textarea
              rows={3}
              placeholder={t("Texto do dia (vazio = o texto padrão)")}
              value={c.confirmacao.texto_do_dia ?? ""}
              onChange={(e) => co({ texto_do_dia: e.target.value })}
            />
            <p className="text-xs text-text-muted">
              {t(
                "Pode usar {{primeiro_nome}}, {{hora}}, {{dia}}, {{dia_relativo}} (amanhã ou o dia da semana) e {{especialista}}.",
              )}
            </p>
          </fieldset>
        </div>
      ) : null}
      {podeMudar ? (
        <div className="pl-12">
          <Button size="sm" onClick={() => void salvar()} disabled={salvando} data-testid="sequencia-salvar">
            {salvando ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function MidiaDoAquecimento({ podeMudar }: { podeMudar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [enviando, setEnviando] = React.useState(false);
  const { data: midia } = useQuery({
    queryKey: ["agenda-midia"],
    queryFn: () => apiClient.get<{ data: MidiaNaTela }>("/api/v1/agenda/midia").then((r) => r.data),
  });

  async function enviar(tipo: "video" | "imagem", arquivo: File) {
    setEnviando(true);
    try {
      const form = new FormData();
      form.append("tipo", tipo);
      form.append("arquivo", arquivo);
      const res = await fetch("/api/v1/agenda/midia", { method: "POST", body: form });
      if (!res.ok) {
        const corpo = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(corpo?.error?.message ?? t("Erro ao subir a mídia."));
      }
      toast.success(t("Mídia salva"));
      await qc.invalidateQueries({ queryKey: ["agenda-midia"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Erro ao subir a mídia."));
    } finally {
      setEnviando(false);
    }
  }

  async function remover(caminho: string) {
    try {
      await apiClient.delete(`/api/v1/agenda/midia?${caminho}`);
      toast.success(t("Mídia removida"));
      await qc.invalidateQueries({ queryKey: ["agenda-midia"] });
    } catch (e) {
      showApiError(e);
    }
  }

  const cabeImagem = (midia?.imagens.length ?? 0) < (midia?.maximo_de_imagens ?? 3);
  return (
    <div className="space-y-3" data-testid="midia-do-aquecimento">
      <h3 className="text-sm font-semibold">{t("Vídeo e imagens do aquecimento")}</h3>
      <p className="text-xs text-text-muted">
        {t(
          "Um vídeo MP4 de até 16 MB e até três imagens JPG ou PNG de até 5 MB. Trocar vale para os próximos agendamentos.",
        )}
      </p>
      <p className="rounded-md border border-border p-2 text-xs text-text-muted" data-testid="midia-aviso-oab">
        {t(
          "OAB e LGPD: nada de valor ganho, decisão favorável, depoimento que prometa resultado ou print de cliente. Confira o conteúdo antes de subir.",
        )}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {midia?.video?.url ? (
          <a className="text-sm underline" href={midia.video.url} target="_blank" rel="noreferrer">
            {t("Ver o vídeo")} ({megas(midia.video.bytes)})
          </a>
        ) : (
          <span className="text-sm text-text-muted">{t("Sem vídeo")}</span>
        )}
        {podeMudar ? (
          <label className="cursor-pointer rounded-md border px-3 py-1.5 text-sm">
            {enviando ? t("Enviando…") : midia?.video ? t("Trocar o vídeo") : t("Enviar o vídeo")}
            <input
              type="file"
              accept="video/mp4,.mp4"
              className="sr-only"
              data-testid="midia-video-arquivo"
              disabled={enviando}
              onChange={(e) => {
                const arquivo = e.target.files?.[0];
                e.target.value = "";
                if (arquivo) void enviar("video", arquivo);
              }}
            />
          </label>
        ) : null}
        {podeMudar && midia?.video ? (
          <Button variant="ghost" size="sm" onClick={() => void remover("tipo=video")}>
            {t("Remover o vídeo")}
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-3">
        {(midia?.imagens ?? []).map((imagem) => (
          <li key={imagem.indice} className="flex flex-col items-start gap-1">
            {imagem.url ? (
              // eslint-disable-next-line @next/next/no-img-element -- URL assinada e curta do Storage privado
              <img src={imagem.url} alt={t("Imagem do aquecimento")} className="h-24 w-24 rounded-md object-cover" />
            ) : null}
            {podeMudar ? (
              <Button variant="ghost" size="sm" onClick={() => void remover(`tipo=imagem&indice=${imagem.indice}`)}>
                {t("Remover")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {podeMudar && cabeImagem ? (
        <label className="inline-block cursor-pointer rounded-md border px-3 py-1.5 text-sm">
          {enviando ? t("Enviando…") : t("Enviar uma imagem")}
          <input
            type="file"
            accept="image/jpeg,image/png,.jpg,.jpeg,.png"
            className="sr-only"
            data-testid="midia-imagem-arquivo"
            disabled={enviando}
            onChange={(e) => {
              const arquivo = e.target.files?.[0];
              e.target.value = "";
              if (arquivo) void enviar("imagem", arquivo);
            }}
          />
        </label>
      ) : null}
    </div>
  );
}

export function SequenciaDepoisDeMarcar({ podeMudar }: { podeMudar: boolean }) {
  const t = useT();
  const { data: tipos, isError } = useQuery({
    queryKey: ["agenda-sequencia"],
    queryFn: () => apiClient.get<{ data: TipoNaTela[] }>("/api/v1/agenda/sequencia").then((r) => r.data),
  });
  return (
    <Card className="space-y-4 p-4" data-testid="sequencia-depois-de-marcar">
      <div>
        <h2 className="text-base font-semibold">{t("Depois de marcar")}</h2>
        <p className="text-sm text-text-muted">
          {t(
            "Mensagens automáticas para o cliente depois que a reunião é marcada: o vídeo e as imagens na noite da marcação e a confirmação em hora fixa. Nunca fora da janela de envio do número, nunca para quem pediu para parar, e param se a reunião mudar ou o cliente disser que não vai.",
          )}
        </p>
      </div>
      {isError ? (
        <p className="text-sm text-text-muted">{t("Não foi possível ler a sequência dos tipos de atendimento.")}</p>
      ) : (
        <ul className="divide-y">
          {(tipos ?? []).map((tipo) => (
            <TipoDaSequencia key={tipo.tipo_id} tipo={tipo} podeMudar={podeMudar} />
          ))}
        </ul>
      )}
      <MidiaDoAquecimento podeMudar={podeMudar} />
    </Card>
  );
}
