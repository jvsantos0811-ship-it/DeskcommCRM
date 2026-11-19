/**
 * Nota de voz gravada no browser → o formato que o WhatsApp aceita.
 *
 * ─── O defeito, medido em produção ──────────────────────────────────────────
 *
 * O `MediaRecorder` do Chrome não sabe gravar `audio/ogg`. Ele aceita o pedido,
 * cai no fallback `audio/webm;codecs=opus`, e o áudio sai do CRM nesse
 * container. O canal oficial recusa depois de aceitar o envio:
 *
 *   131053 — Media upload error — WhatsApp could not download the media
 *   attachment. Make sure the media URL is publicly accessible and in a
 *   supported format.
 *
 * A mensagem culpa a URL, e a URL estava certa: `webm` simplesmente não está na
 * lista de formatos de áudio aceitos (MP3, OGG, AMR, AAC). O operador vê
 * "falhou" numa nota de voz que gravou normalmente, sem nada dizendo o motivo
 * real.
 *
 * ─── Por que converter no UPLOAD, e não no envio ────────────────────────────
 *
 * Convertendo uma vez, ao guardar, TODO canal recebe um arquivo válido — e o
 * mesmo áudio pode ser reenviado, encaminhado ou usado por outro canal depois
 * sem repetir o trabalho. Converter no envio faria a mesma gravação ser
 * transcodificada a cada destinatário, e deixaria o arquivo guardado num
 * formato que só um canal aceita.
 *
 * ─── Por que não simplesmente mandar sem `voiceNote` ────────────────────────
 *
 * Porque não resolve: `webm` não é aceito nem como anexo comum. E porque a nota
 * de voz É o formato — chegar como arquivo anexo, sem a bolha e sem a onda,
 * muda o que a pessoa recebe.
 *
 * O codec já é opus dos dois lados; o que muda é o CONTAINER. Por isso
 * `-c:a copy`: sem reencodar, sem perda, e rápido o bastante para caber no
 * caminho do upload.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * O que o WhatsApp aceita como nota de voz.
 *
 * O `codecs=opus` NÃO é enfeite: a doc do canal oficial lista
 * `audio/ogg (OPUS codecs only; base audio/ogg not supported)`. Guardar o
 * arquivo como `audio/ogg` puro faz o Storage servir esse Content-Type, e a
 * plataforma recusa o download com o MESMO `131053` que o cabeçalho deste
 * arquivo descreve — a conversão acertava o container e errava a etiqueta.
 *
 * O defeito só aparecia no Chrome, e é por isso que passou: o Firefox grava
 * direto em `audio/ogg;codecs=opus` (`AudioRecorder.tsx`, `PREFERRED_MIMES`),
 * não passa por aqui, e a nota de voz dele sempre chegou. Esta é literalmente a
 * mesma string que o browser usa quando sabe gravar ogg.
 */
export const VOICE_MIME = "audio/ogg;codecs=opus";

/** Teto de segurança: nota de voz é curta, e acima disto é outra coisa. */
const MAX_BYTES = 16 * 1024 * 1024;

/**
 * Precisa converter? Só `webm` com opus — o resto ou já serve, ou não é nosso
 * problema resolver aqui.
 *
 * Com a chave "nota de voz no formato do WhatsApp" ligada (PC-043), o `ogg` que
 * o browser grava também passa pela conversão: o container já serve, mas o
 * conteúdo é o do gravador do browser, não o de uma nota de voz.
 */
export function precisaTranscodificar(mime: string, opcoes: OpcoesDaNotaDeVoz = {}): boolean {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "audio/webm" || base === "video/webm") return true;
  return opcoes.formatoWhatsapp === true && base === "audio/ogg";
}

export interface OpcoesDaNotaDeVoz {
  /**
   * PC-043 — `settings.nota_de_voz.formato_whatsapp` da organização. Ausente =
   * desligada = o comportamento de antes (só troca o container).
   */
  formatoWhatsapp?: boolean;
}

export interface Transcodificacao {
  buffer: Buffer;
  mime: string;
  /** `false` = devolvido intacto, porque não precisava (ou não deu). */
  convertido: boolean;
  /**
   * Qual conversão saiu: `formato_whatsapp` (reencodada, PC-043), `container`
   * (só a troca de webm para ogg) ou `nenhuma`.
   */
  modo: "formato_whatsapp" | "container" | "nenhuma";
}

/** Roda ffmpeg; rejeita se sair diferente de zero. Injetável para teste. */
async function runFfmpeg(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-nostdin", "-y", ...args], { cwd });
    let erro = "";
    proc.stderr?.on("data", (d: Buffer) => {
      // Só o fim interessa: ffmpeg escreve muito e o erro vem por último.
      erro = (erro + d.toString()).slice(-500);
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg_spawn_failed: ${err.message}`)));
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg_exit_${code}: ${erro}`)),
    );
  });
}

/**
 * PC-043 — os argumentos que deixam a gravação do browser igual a uma nota de
 * voz do WhatsApp.
 *
 * ─── O defeito, medido (19/11/2026) ─────────────────────────────────────────
 *
 * O `MediaRecorder` do Chrome grava opus a **128 kbps**, em quadros de **60 ms**,
 * e a conversão de container (`-c:a copy`) guarda isso como está, com
 * `pre-skip` zero. A nota de voz do próprio WhatsApp é ~16 kbps, mono, em
 * quadros de 20 ms. Pelo WAHA nada disso aparecia, porque o WAHA reconverte
 * (`convert: true`, `lib/waha/media-send.ts`). Pelo canal oficial (Zernio e
 * Meta) o arquivo chega ao celular do cliente como o browser gravou — e a
 * equipe relatou o áudio chegando "picotado". A doc do canal oficial pede
 * `audio/ogg` opus com "mono input only".
 *
 * ─── O que cada argumento faz ───────────────────────────────────────────────
 *
 * - `-ac 1`: mono, sempre (há microfone que entrega dois canais);
 * - `-c:a libopus -b:a 32k -application voip`: o perfil de voz do opus, com
 *   folga sobre os ~16 kbps do WhatsApp para não perder clareza;
 * - `-frame_duration 20`: quadros de 20 ms, como a nota de voz do celular;
 * - `-ar 48000`: a taxa que o opus usa por dentro (qualquer outra é reamostrada);
 * - `-avoid_negative_ts make_zero` e `-map_metadata -1`: relógio começando em
 *   zero e sem metadado do gravador.
 */
export const ARGS_FORMATO_WHATSAPP: readonly string[] = [
  "-vn",
  "-map_metadata",
  "-1",
  "-ac",
  "1",
  "-ar",
  "48000",
  "-c:a",
  "libopus",
  "-b:a",
  "32k",
  "-application",
  "voip",
  "-frame_duration",
  "20",
  "-avoid_negative_ts",
  "make_zero",
  "-f",
  "ogg",
];

/**
 * Gravação do browser → nota de voz.
 *
 * Desligada a chave (o padrão): WebM/Opus → Ogg/Opus, trocando só o container.
 * Ligada (PC-043): reencoda no formato do WhatsApp; se a reencodagem falhar, cai
 * para a troca de container (o que já funcionava), e só então para o original.
 *
 * Falha devolve o original INTACTO, não erro: um áudio que talvez não saia é
 * melhor que um envio que morre antes de tentar — e o canal que aceita webm
 * (porque converte sozinho) continua funcionando como sempre.
 */
export async function transcodificarNotaDeVoz(
  input: { buffer: Buffer; mime: string },
  deps: { run?: typeof runFfmpeg } = {},
  opcoes: OpcoesDaNotaDeVoz = {},
): Promise<Transcodificacao> {
  const intacto: Transcodificacao = {
    buffer: input.buffer,
    mime: input.mime,
    convertido: false,
    modo: "nenhuma",
  };
  if (!precisaTranscodificar(input.mime, opcoes)) return intacto;
  if (input.buffer.length > MAX_BYTES) return intacto;

  const executar = deps.run ?? runFfmpeg;
  const base = input.mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const ehWebm = base === "audio/webm" || base === "video/webm";
  const dir = await mkdtemp(join(tmpdir(), "voz-"));
  try {
    const entrada = join(dir, ehWebm ? "in.webm" : "in.ogg");
    await writeFile(entrada, input.buffer);

    if (opcoes.formatoWhatsapp === true) {
      const saida = join(dir, "voz.ogg");
      try {
        await executar(["-i", entrada, ...ARGS_FORMATO_WHATSAPP, saida], dir);
        const buffer = await readFile(saida);
        if (buffer.length > 0)
          return { buffer, mime: VOICE_MIME, convertido: true, modo: "formato_whatsapp" };
      } catch {
        // Cai para a troca de container abaixo: é o que funcionava antes da chave.
      }
    }

    // Ogg que chegou aqui só pela chave já está no container certo: sem a
    // reencodagem, ele segue como veio.
    if (!ehWebm) return intacto;

    const saida = join(dir, "out.ogg");
    // `-c:a copy`: o codec já é opus dos dois lados. Reencodar custaria tempo e
    // qualidade para chegar ao mesmo lugar.
    await executar(["-i", entrada, "-vn", "-c:a", "copy", "-f", "ogg", saida], dir);
    const buffer = await readFile(saida);
    if (buffer.length === 0) return intacto;
    return { buffer, mime: VOICE_MIME, convertido: true, modo: "container" };
  } catch {
    return intacto;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
