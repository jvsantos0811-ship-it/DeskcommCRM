/**
 * ÁUDIO LONGO, TRANSCRITO INTEIRO E EM PARTES (PC-021, item 5).
 *
 * Acima de 3 min o áudio é cortado em partes de 2 min (por tempo, nunca por
 * silêncio — uma pausa longa do cliente não encerra a transcrição) e cada parte
 * é transcrita; o texto final é a junção, na ordem. Sem ffmpeg, ou se o corte
 * falhar, cai na transcrição do arquivo inteiro (o comportamento de antes).
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TranscriptionProvider } from "@/lib/messaging/media/transcription";
import { defaultRunFfmpeg } from "@/lib/messaging/media/video-derive";
import { PARTE_DO_AUDIO_S } from "@/lib/messaging/media/nao-entendida";

function extensao(mime: string): string {
  const b = mime.split(";")[0]!.trim().toLowerCase();
  if (b.includes("ogg")) return "ogg";
  if (b.includes("mpeg") || b.includes("mp3")) return "mp3";
  if (b.includes("mp4") || b.includes("m4a")) return "m4a";
  if (b.includes("webm")) return "webm";
  if (b.includes("wav")) return "wav";
  return "bin";
}

export interface OpcoesDoAudioLongo {
  /** Executa ffmpeg (injetável p/ teste). */
  runFfmpeg?: (args: string[], cwd: string) => Promise<void>;
  /** Segundos por parte (padrão 120). */
  parteS?: number;
}

/**
 * Embrulha o transcritor: o áudio é cortado em partes e cada uma vai ao
 * transcritor de base. Uma parte que falha derruba a transcrição (o worker
 * re-tenta), para não entregar ao agente um áudio "pela metade" como se fosse
 * inteiro.
 */
export function transcritorEmPartes(
  base: TranscriptionProvider,
  opcoes: OpcoesDoAudioLongo = {},
): TranscriptionProvider {
  const run = opcoes.runFfmpeg ?? defaultRunFfmpeg;
  const parteS = opcoes.parteS ?? PARTE_DO_AUDIO_S;
  return {
    async transcribe(audio, mime) {
      const ext = extensao(mime);
      const dir = await mkdtemp(join(tmpdir(), "audio-longo-"));
      try {
        await writeFile(join(dir, `in.${ext}`), audio);
        try {
          await run(
            ["-i", `in.${ext}`, "-f", "segment", "-segment_time", String(parteS), "-c", "copy", `parte%03d.${ext}`],
            dir,
          );
        } catch {
          return base.transcribe(audio, mime);
        }
        const partes = (await readdir(dir)).filter((f) => f.startsWith("parte")).sort();
        if (partes.length <= 1) return base.transcribe(audio, mime);
        const textos: string[] = [];
        for (const p of partes) {
          const t = await base.transcribe(await readFile(join(dir, p)), mime);
          if (t.trim()) textos.push(t.trim());
        }
        return textos.join(" ");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
