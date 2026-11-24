"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { conferirVideo, TEXTO_MAX, VIDEO_MIMES } from "@/lib/agenda/video-aquecimento";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";

/**
 * VÍDEO DE AQUECIMENTO (PC-045, parte 2) — por organização, fácil de trocar.
 *
 * Sem vídeo (o padrão), nada muda: a confirmação do agendamento sai sozinha.
 * Com vídeo, ele sai uma vez por compromisso, logo depois da confirmação, com o
 * texto curto opcional. Trocar vale para os próximos agendamentos.
 */
interface Video {
  mime: string;
  bytes: number;
  texto: string | null;
  trocado_em: string;
  previa_url: string | null;
}

const ROTA = "/api/v1/agenda/video-aquecimento";

export function VideoDeAquecimento({ podeMudar }: { podeMudar: boolean }) {
  const t = useT();
  const idioma = useIdioma();
  const [video, setVideo] = useState<Video | null | undefined>(undefined);
  const [texto, setTexto] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const arquivoRef = useRef<HTMLInputElement>(null);

  const [versao, setVersao] = useState(0);
  const ler = () => setVersao((v) => v + 1);

  useEffect(() => {
    let vivo = true;
    apiClient
      .get<{ data: { video: Video | null } }>(ROTA)
      .then(({ data }) => {
        if (!vivo) return;
        setVideo(data.video);
        setTexto(data.video?.texto ?? "");
      })
      .catch(() => {
        if (vivo) setVideo(null);
      });
    return () => {
      vivo = false;
    };
  }, [versao]);

  async function enviar(arquivo: File) {
    const recusa = conferirVideo({ type: arquivo.type, size: arquivo.size });
    if (recusa === "tamanho") return void toast.error(t("O vídeo passa de 16 MB, o limite do WhatsApp. Comprima e envie de novo."));
    if (recusa === "formato") return void toast.error(t("Formato não aceito: envie um vídeo .mp4."));
    if (recusa === "vazio") return void toast.error(t("O arquivo está vazio."));
    setOcupado(true);
    try {
      const corpo = new FormData();
      corpo.append("arquivo", arquivo);
      corpo.append("texto", texto);
      const r = await fetch(ROTA, { method: "POST", body: corpo, credentials: "same-origin" });
      if (!r.ok) {
        const erro = (await r.json().catch(() => null)) as { error?: { code?: string } } | null;
        toast.error(erro?.error?.code === "video_recusado" ? t("O vídeo foi recusado: confira o formato (.mp4) e o tamanho (até 16 MB).") : t("Não foi possível guardar o vídeo."));
        return;
      }
      toast.success(t("Vídeo salvo. Vale para os próximos agendamentos."));
      ler();
    } finally {
      setOcupado(false);
      if (arquivoRef.current) arquivoRef.current.value = "";
    }
  }

  async function salvarTexto() {
    setOcupado(true);
    try {
      await apiClient.patch(ROTA, { texto });
      toast.success(t("Texto salvo."));
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  async function tirar() {
    setOcupado(true);
    try {
      await apiClient.delete(ROTA);
      toast.success(t("Vídeo removido. A confirmação volta a sair sozinha."));
      ler();
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  if (video === undefined) return null;
  const mb = (bytes: number) => (bytes / (1024 * 1024)).toLocaleString(idioma, { maximumFractionDigits: 1 });

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4" data-testid="video-de-aquecimento">
      <div>
        <h3 className="text-sm font-semibold">{t("Vídeo de aquecimento")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("Enviado uma vez por agendamento, logo depois da confirmação, enquanto a conversa está aberta. Trocar vale para os próximos agendamentos; ninguém recebe de novo.")}
        </p>
      </div>
      {video ? (
        <div className="flex flex-col gap-2">
          {video.previa_url && (
            <video className="max-h-56 w-full max-w-md rounded-md border border-border" src={video.previa_url} controls preload="metadata" />
          )}
          <p className="text-xs text-muted-foreground">
            {mb(video.bytes)} MB · {t("trocado em")} {new Date(video.trocado_em).toLocaleDateString(idioma)}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("Nenhum vídeo: a confirmação sai sozinha, como hoje.")}</p>
      )}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium" htmlFor="video-aquecimento-texto">
          {t("Texto que acompanha o vídeo (opcional)")}
        </label>
        <Input
          id="video-aquecimento-texto"
          maxLength={TEXTO_MAX}
          value={texto}
          disabled={!podeMudar || ocupado}
          onChange={(e) => setTexto(e.target.value)}
        />
      </div>
      {podeMudar && (
        <div className="flex flex-wrap gap-2">
          <input
            ref={arquivoRef}
            type="file"
            accept={VIDEO_MIMES.join(",")}
            className="hidden"
            aria-label={t("Arquivo do vídeo")}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void enviar(f);
            }}
          />
          <Button size="sm" disabled={ocupado} onClick={() => arquivoRef.current?.click()}>
            {ocupado ? t("Enviando…") : video ? t("Trocar vídeo") : t("Enviar vídeo")}
          </Button>
          {video && (
            <Button size="sm" variant="outline" disabled={ocupado} onClick={() => void salvarTexto()}>
              {t("Salvar texto")}
            </Button>
          )}
          {video && (
            <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => void tirar()}>
              {t("Remover vídeo")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
