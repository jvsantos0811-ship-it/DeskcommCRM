import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * Nota de voz gravada no browser → o formato que o WhatsApp aceita.
 *
 * ─── O defeito, medido em produção ──────────────────────────────────────────
 *
 * O `MediaRecorder` do Chrome não sabe gravar `audio/ogg`: aceita o pedido, cai
 * no fallback `audio/webm;codecs=opus`, e o canal oficial recusa DEPOIS de
 * aceitar o envio —
 *
 *   131053 Media upload error — "Make sure the media URL is publicly
 *   accessible and in a supported format."
 *
 * A mensagem culpa a URL, e a URL estava certa: `webm` não está na lista de
 * formatos aceitos (MP3, OGG, AMR, AAC). O operador vê "falhou" numa nota de
 * voz que gravou normalmente.
 *
 * ─── O que estes casos prendem ──────────────────────────────────────────────
 *
 * Que a conversão aconteça só quando precisa, que ela não seja um caminho
 * frágil (falhar devolve o original, nunca derruba o upload), e que o mime
 * DEVOLVIDO seja o do arquivo guardado — devolver o original mandaria o canal
 * buscar um `webm` que já não existe, que é o mesmo defeito um passo adiante.
 */
import { extFromMime } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { notaDeVozNoFormatoWhatsapp } from "@/lib/messaging/media/nota-de-voz-config";
import {
  ARGS_FORMATO_WHATSAPP,
  VOICE_MIME,
  precisaTranscodificar,
  transcodificarNotaDeVoz,
} from "@/lib/messaging/media/voice-transcode";

const webm = { buffer: Buffer.from("webm-bytes"), mime: "audio/webm;codecs=opus" };

describe("quando precisa converter", () => {
  it("webm do browser precisa — é o que o Chrome grava", () => {
    expect(precisaTranscodificar("audio/webm;codecs=opus")).toBe(true);
    expect(precisaTranscodificar("audio/webm")).toBe(true);
  });

  it("ogg NÃO precisa — já é o formato de destino", () => {
    expect(precisaTranscodificar("audio/ogg;codecs=opus")).toBe(false);
    expect(precisaTranscodificar("audio/ogg")).toBe(false);
  });

  it("mp3, aac e amr passam intactos — a plataforma os aceita", () => {
    for (const m of ["audio/mpeg", "audio/aac", "audio/amr"]) {
      expect(precisaTranscodificar(m)).toBe(false);
    }
  });

  it("imagem e documento não são assunto daqui", () => {
    expect(precisaTranscodificar("image/jpeg")).toBe(false);
    expect(precisaTranscodificar("application/pdf")).toBe(false);
  });
});

describe("a conversão", () => {
  it("devolve ogg quando dá certo", async () => {
    // Tipado com os args reais: o teste lê o 1º, e `async () => {}` o esconde.
    const run = vi.fn(async (_args: string[], _cwd: string) => {});
    // O dublê de ffmpeg não escreve arquivo, então o read falha e cai no
    // caminho de erro — que é justamente o próximo caso. Aqui o que importa é
    // que ffmpeg SEJA chamado com os argumentos certos.
    await transcodificarNotaDeVoz(webm, { run });
    expect(run).toHaveBeenCalled();
    const args = run.mock.calls[0]?.[0] ?? [];
    // `-c:a copy`: o codec já é opus dos dois lados; o que muda é o container.
    // Reencodar custaria tempo e qualidade para chegar ao mesmo lugar.
    expect(args).toContain("copy");
    expect(args).toContain("ogg");
  });

  it("NÃO chama ffmpeg quando não precisa — conversão à toa é custo puro", async () => {
    const run = vi.fn(async () => {});
    const r = await transcodificarNotaDeVoz(
      { buffer: Buffer.from("ogg"), mime: "audio/ogg" },
      { run },
    );
    expect(run).not.toHaveBeenCalled();
    expect(r.convertido).toBe(false);
    expect(r.mime).toBe("audio/ogg");
  });

  it("ffmpeg falhando devolve o ORIGINAL, não erro", async () => {
    // Um áudio que talvez não saia é melhor que um envio que morre antes de
    // tentar — e o canal que converte sozinho continua funcionando como sempre.
    const run = vi.fn(async () => {
      throw new Error("ffmpeg_exit_1");
    });
    const r = await transcodificarNotaDeVoz(webm, { run });
    expect(r.convertido).toBe(false);
    expect(r.buffer).toBe(webm.buffer);
    expect(r.mime).toBe(webm.mime);
  });

  it("arquivo grande demais passa intacto em vez de travar o upload", async () => {
    const run = vi.fn(async () => {});
    const grande = { buffer: Buffer.alloc(17 * 1024 * 1024), mime: "audio/webm" };
    const r = await transcodificarNotaDeVoz(grande, { run });
    expect(run).not.toHaveBeenCalled();
    expect(r.convertido).toBe(false);
  });

  it("o destino é o mime que a plataforma aceita — COM o codec", () => {
    // `base audio/ogg not supported` está na doc do canal oficial. Sem o
    // `codecs=opus` o Storage serve o Content-Type que a plataforma recusa, e o
    // 131053 volta — só que agora culpando um arquivo que está certo.
    expect(VOICE_MIME).toBe("audio/ogg;codecs=opus");
  });

  it("o mime de destino continua rendendo a extensão e a categoria certas", () => {
    // O `;codecs=opus` passa por dois pontos que cortam no `;`. Se um deles
    // deixar de cortar, o arquivo vira `.bin` no bucket ou perde a categoria
    // `audio` — e a nota de voz sai como documento.
    expect(extFromMime(VOICE_MIME)).toBe("ogg");
    expect(validateOutboundMedia(VOICE_MIME, 1024)).toEqual({ ok: true, kind: "audio" });
  });
});

describe("o elo que some sem barulho", () => {
  it("a rota de upload converte ANTES de guardar", () => {
    // Converter no envio faria a mesma gravação ser transcodificada por
    // destinatário, e deixaria guardado um formato que só um canal aceita.
    const fonte = readFileSync("app/api/v1/conversations/[id]/media/route.ts", "utf8");
    expect(fonte).toContain("transcodificarNotaDeVoz");
    expect(fonte).toMatch(/upload\(storagePath,\s*buffer,\s*\{\s*contentType:\s*mimeFinal/);
  });

  it("devolve o mime do arquivo GUARDADO, não o que chegou", () => {
    // Devolver o original mandaria o canal buscar um `webm` que já não existe —
    // o mesmo defeito, um passo adiante.
    const fonte = readFileSync("app/api/v1/conversations/[id]/media/route.ts", "utf8");
    expect(fonte).toMatch(/media_mime:\s*mimeFinal/);
    expect(fonte).toMatch(/media_size_bytes:\s*buffer\.length/);
  });
});

/**
 * PC-043 — a chave "nota de voz no formato do WhatsApp".
 *
 * Medido em 19/11/2026: o Chrome grava opus a 128 kbps em quadros de 60 ms, e a
 * troca de container guarda isso como está. Pelo WAHA não aparecia (o WAHA
 * reconverte); pelo canal oficial o arquivo chegava ao cliente "picotado".
 */
describe("PC-043: a chave por organização", () => {
  it("ausente, inválida ou diferente de true = DESLIGADA", () => {
    expect(notaDeVozNoFormatoWhatsapp(undefined)).toBe(false);
    expect(notaDeVozNoFormatoWhatsapp(null)).toBe(false);
    expect(notaDeVozNoFormatoWhatsapp({})).toBe(false);
    expect(notaDeVozNoFormatoWhatsapp({ nota_de_voz: null })).toBe(false);
    expect(notaDeVozNoFormatoWhatsapp({ nota_de_voz: { formato_whatsapp: "true" } })).toBe(false);
    expect(notaDeVozNoFormatoWhatsapp({ nota_de_voz: { formato_whatsapp: false } })).toBe(false);
    expect(notaDeVozNoFormatoWhatsapp({ nota_de_voz: { formato_whatsapp: true } })).toBe(true);
  });

  it("desligada, o ogg do browser segue intacto, como antes", () => {
    expect(precisaTranscodificar("audio/ogg;codecs=opus")).toBe(false);
    expect(precisaTranscodificar("audio/ogg;codecs=opus", { formatoWhatsapp: false })).toBe(false);
  });

  it("ligada, o ogg do browser também passa — o container serve, o conteúdo não", () => {
    expect(precisaTranscodificar("audio/ogg;codecs=opus", { formatoWhatsapp: true })).toBe(true);
    expect(precisaTranscodificar("audio/webm;codecs=opus", { formatoWhatsapp: true })).toBe(true);
  });

  it("ligada, mp3, aac, amr e documento continuam fora", () => {
    for (const m of ["audio/mpeg", "audio/aac", "audio/amr", "application/pdf"]) {
      expect(precisaTranscodificar(m, { formatoWhatsapp: true })).toBe(false);
    }
  });
});

describe("PC-043: a reencodagem", () => {
  /** Dublê que escreve a saída (último argumento), como o ffmpeg faria. */
  const escreveSaida = (conteudo: string) =>
    vi.fn(async (args: string[], _cwd: string) => {
      writeFileSync(args[args.length - 1] ?? "", conteudo);
    });

  it("os argumentos são os de uma nota de voz: mono, opus de voz a 32 kbps, quadros de 20 ms", () => {
    const a = [...ARGS_FORMATO_WHATSAPP];
    const valor = (flag: string) => a[a.indexOf(flag) + 1];
    expect(valor("-ac")).toBe("1");
    expect(valor("-c:a")).toBe("libopus");
    expect(valor("-b:a")).toBe("32k");
    expect(valor("-application")).toBe("voip");
    expect(valor("-frame_duration")).toBe("20");
    expect(valor("-f")).toBe("ogg");
    expect(a).not.toContain("copy");
  });

  it("ligada, reencoda e devolve ogg/opus marcado como formato_whatsapp", async () => {
    const run = escreveSaida("voz");
    const r = await transcodificarNotaDeVoz(webm, { run }, { formatoWhatsapp: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toContain("libopus");
    expect(r).toMatchObject({ convertido: true, mime: VOICE_MIME, modo: "formato_whatsapp" });
    expect(r.buffer.toString()).toBe("voz");
  });

  it("ligada e a reencodagem falhando, cai para a troca de container (o que já funcionava)", async () => {
    let chamada = 0;
    const run = vi.fn(async (args: string[], _cwd: string) => {
      chamada += 1;
      if (chamada === 1) throw new Error("ffmpeg_exit_1: Unknown encoder 'libopus'");
      writeFileSync(args[args.length - 1] ?? "", "container");
    });
    const r = await transcodificarNotaDeVoz(webm, { run }, { formatoWhatsapp: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toContain("copy");
    expect(r).toMatchObject({ convertido: true, mime: VOICE_MIME, modo: "container" });
  });

  it("ligada, ogg com a reencodagem falhando segue o ORIGINAL — já estava no container certo", async () => {
    const ogg = { buffer: Buffer.from("ogg-do-firefox"), mime: "audio/ogg;codecs=opus" };
    const run = vi.fn(async () => {
      throw new Error("ffmpeg_exit_1");
    });
    const r = await transcodificarNotaDeVoz(ogg, { run }, { formatoWhatsapp: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ convertido: false, modo: "nenhuma", mime: ogg.mime });
    expect(r.buffer).toBe(ogg.buffer);
  });

  it("desligada, o caminho é o de antes: só a troca de container", async () => {
    const run = escreveSaida("container");
    const r = await transcodificarNotaDeVoz(webm, { run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toContain("copy");
    expect(run.mock.calls[0]?.[0]).not.toContain("libopus");
    expect(r.modo).toBe("container");
  });

  it("a rota de upload lê a chave da organização e a passa à conversão", () => {
    const fonte = readFileSync("app/api/v1/conversations/[id]/media/route.ts", "utf8");
    expect(fonte).toContain("notaDeVozNoFormatoWhatsapp");
    expect(fonte).toMatch(
      /transcodificarNotaDeVoz\(\{ buffer: bruto, mime \}, \{\}, \{ formatoWhatsapp \}\)/,
    );
    // A org vem da sessão ou do token, nunca do corpo.
    expect(fonte).toMatch(/lerChaveDaNotaDeVoz\(activeOrg\.orgId\)/);
  });
});

/**
 * Com o ffmpeg de verdade, quando a máquina tem um com libopus (a imagem de
 * produção tem: `apk add ffmpeg`). Gera uma gravação no perfil do Chrome
 * (opus 128 kbps, quadros de 60 ms, em webm) e confere a saída pelo cabeçalho
 * do próprio arquivo, sem depender de ffprobe.
 */
const temLibopus = (() => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  return r.status === 0 && /libopus/.test(r.stdout ?? "");
})();

describe.skipIf(!temLibopus)("PC-043: com o ffmpeg de verdade", () => {
  it("a gravação no perfil do Chrome sai mono, opus, bem menor e em quadros de 20 ms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pc043-"));
    try {
      const entrada = join(dir, "chrome.webm");
      const g = spawnSync(
        "ffmpeg",
        [
          "-nostdin",
          "-y",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=220:sample_rate=48000:duration=6",
          "-ac",
          "2",
          "-c:a",
          "libopus",
          "-b:a",
          "128k",
          "-frame_duration",
          "60",
          "-f",
          "webm",
          entrada,
        ],
        { encoding: "utf8" },
      );
      expect(g.status).toBe(0);
      const bruto = readFileSync(entrada);

      const r = await transcodificarNotaDeVoz(
        { buffer: bruto, mime: "audio/webm;codecs=opus" },
        {},
        { formatoWhatsapp: true },
      );
      expect(r.modo).toBe("formato_whatsapp");
      expect(r.mime).toBe(VOICE_MIME);
      expect(r.buffer.subarray(0, 4).toString("latin1")).toBe("OggS");
      const cabeca = r.buffer.indexOf("OpusHead");
      expect(cabeca).toBeGreaterThan(0);
      expect(r.buffer[cabeca + 9]).toBe(1); // canais
      expect(r.buffer.length).toBeLessThan(bruto.length / 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
