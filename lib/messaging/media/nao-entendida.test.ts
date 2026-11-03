import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { transcritorEmPartes } from "./audio-longo";
import {
  avaliarTranscricao,
  duracaoDoOggOpus,
  ehMidiaNaoEntendida,
  idiomaDoLocale,
  marcadorDeAudioNaoEntendido,
  marcadorDeMidiaNaoEntendida,
} from "./nao-entendida";
import { contarPorDia } from "./nao-entendidas-por-dia";
import { corpoDaMensagem } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { mensagensPendentesDoCliente } from "@/lib/agent-engine/agent/abertura/ritual";

/** Uma página Ogg mínima: "OggS" + versão + tipo + granule (8 bytes LE) + resto. */
function paginaOgg(granule: number, corpo: Uint8Array = new Uint8Array(0)): Uint8Array {
  const cab = new Uint8Array(27);
  cab.set([0x4f, 0x67, 0x67, 0x53], 0);
  let g = granule;
  for (let i = 0; i < 8; i++) {
    cab[6 + i] = g % 256;
    g = Math.floor(g / 256);
  }
  const out = new Uint8Array(cab.length + corpo.length);
  out.set(cab, 0);
  out.set(corpo, cab.length);
  return out;
}

function opusHead(preSkip: number): Uint8Array {
  const h = new Uint8Array(19);
  h.set([...Buffer.from("OpusHead")], 0);
  h[8] = 1; // versão
  h[9] = 1; // canais
  h[10] = preSkip & 0xff;
  h[11] = (preSkip >> 8) & 0xff;
  return h;
}

function oggDeSegundos(s: number): Uint8Array {
  const a = paginaOgg(0, opusHead(312));
  const meio = paginaOgg(48_000, new Uint8Array(40));
  const fim = paginaOgg(Math.round(s * 48_000) + 312, new Uint8Array(40));
  const out = new Uint8Array(a.length + meio.length + fim.length);
  out.set(a, 0);
  out.set(meio, a.length);
  out.set(fim, a.length + meio.length);
  return out;
}

describe("PC-021 — quando a transcrição não serve como fala", () => {
  it("vazia, só ruído e as alucinações do transcritor em silêncio", () => {
    expect(avaliarTranscricao("", 8)).toEqual({ entendida: false, motivo: "vazia" });
    expect(avaliarTranscricao("  ...  ", 8)).toEqual({ entendida: false, motivo: "vazia" });
    expect(avaliarTranscricao("[Música]", 8)).toEqual({ entendida: false, motivo: "so_ruido" });
    expect(avaliarTranscricao("(ruído de fundo) ♪", 8)).toEqual({ entendida: false, motivo: "so_ruido" });
    expect(avaliarTranscricao("Legendas pela comunidade Amara.org", 8)).toEqual({ entendida: false, motivo: "so_ruido" });
    expect(avaliarTranscricao("Obrigado por assistir!", 3)).toEqual({ entendida: false, motivo: "so_ruido" });
  });

  it("curta demais para a duração: menos de 3 palavras em mais de 5 s", () => {
    expect(avaliarTranscricao("é isso", 12)).toEqual({ entendida: false, motivo: "curta_demais" });
    expect(avaliarTranscricao("sim", 2)).toEqual({ entendida: true });
    expect(avaliarTranscricao("sim", null)).toEqual({ entendida: true });
  });

  it("fala de verdade passa", () => {
    expect(avaliarTranscricao("Meu neto sofreu o acidente de moto em março e ficou afastado.", 9)).toEqual({
      entendida: true,
    });
  });

  it("os marcadores dizem o que aconteceu, e o turno os reconhece (o antigo também)", () => {
    expect(marcadorDeAudioNaoEntendido(12.4)).toBe("ÁUDIO NÃO ENTENDIDO (duração 12s)");
    expect(marcadorDeAudioNaoEntendido(null)).toBe("ÁUDIO NÃO ENTENDIDO");
    expect(marcadorDeMidiaNaoEntendida("image")).toBe("MÍDIA NÃO ENTENDIDA (imagem)");
    expect(ehMidiaNaoEntendida("ÁUDIO NÃO ENTENDIDO (duração 7s)")).toBe(true);
    expect(ehMidiaNaoEntendida("[o cliente enviou uma mídia que não consegui interpretar]")).toBe(true);
    expect(ehMidiaNaoEntendida("Meu neto sofreu o acidente")).toBe(false);
  });

  it("idioma da organização: pt-BR → pt", () => {
    expect(idiomaDoLocale("pt-BR")).toBe("pt");
    expect(idiomaDoLocale("es")).toBe("es");
    expect(idiomaDoLocale("")).toBeNull();
  });
});

describe("PC-021 — a duração da nota de voz, lida do próprio OGG/Opus", () => {
  it("12 s e 4 min", () => {
    expect(duracaoDoOggOpus(oggDeSegundos(12))).toBeCloseTo(12, 1);
    expect(duracaoDoOggOpus(oggDeSegundos(240))).toBeCloseTo(240, 1);
  });

  it("outro formato: null", () => {
    expect(duracaoDoOggOpus(new Uint8Array(200).fill(7))).toBeNull();
  });
});

describe("PC-021 — o turno: pede para repetir em vez de adivinhar", () => {
  it("áudio só de ruído: a moldura manda pedir para repetir ou escrever, nunca 'trate como se tivesse ouvido'", () => {
    const corpo = corpoDaMensagem({
      type: "audio",
      body: null,
      media_url: "x",
      media_storage_path: "org/conv/a.ogg",
      media_derived_text: "ÁUDIO NÃO ENTENDIDO (duração 12s)",
    });
    expect(corpo).toContain("NÃO conseguiu entender (ÁUDIO NÃO ENTENDIDO (duração 12s))");
    expect(corpo).toContain("mande o áudio de novo ou escreva");
    expect(corpo).toContain("não adivinhe o conteúdo");
    expect(corpo).not.toContain("como se você mesma tivesse visto/ouvido");
  });

  it("foto borrada: pede outra foto ou que a pessoa escreva", () => {
    const corpo = corpoDaMensagem({
      type: "image",
      body: null,
      media_url: "x",
      media_storage_path: "org/conv/f.jpg",
      media_derived_text: "MÍDIA NÃO ENTENDIDA (imagem)",
    });
    expect(corpo).toContain("mande outra foto ou escreva");
  });

  it("áudio ainda sem texto (passou do teto de espera): responde ao resto e diz que vai ouvir", () => {
    const pendentes = mensagensPendentesDoCliente([
      { direction: "inbound", body: "[audio]", sent_at: "2026-11-03T10:00:00-03:00", type: "audio" },
      { direction: "inbound", body: "e aí, tem novidade?", sent_at: "2026-11-03T10:00:20-03:00" },
    ] as never);
    expect(pendentes).toHaveLength(2);
    expect(pendentes[0]!.texto).toContain("ainda sendo transcrito");
    expect(pendentes[0]!.texto).toContain("não invente o que foi dito");
    expect(pendentes[1]!.texto).toBe("e aí, tem novidade?");
  });
});

describe("PC-021 — áudio longo: inteiro, em partes", () => {
  it("corta em partes por tempo e junta o texto de todas, na ordem", async () => {
    const partes: string[] = [];
    const base = {
      transcribe: async (audio: Buffer) => {
        partes.push(audio.toString());
        return `texto da ${audio.toString()}`;
      },
    };
    const t = transcritorEmPartes(base, {
      runFfmpeg: async (args, cwd) => {
        expect(args).toContain("segment");
        expect(args).toContain("120");
        for (const n of ["000", "001"]) await writeFile(join(cwd, `parte${n}.ogg`), `parte${n}`);
      },
    });
    const texto = await t.transcribe(Buffer.from("audio de 4 minutos"), "audio/ogg; codecs=opus");
    expect(partes).toEqual(["parte000", "parte001"]);
    expect(texto).toBe("texto da parte000 texto da parte001");
  });

  it("sem ffmpeg (ou corte que falha): transcreve o arquivo inteiro", async () => {
    const t = transcritorEmPartes(
      { transcribe: async () => "inteiro" },
      { runFfmpeg: async () => Promise.reject(new Error("ffmpeg_spawn_failed")) },
    );
    expect(await t.transcribe(Buffer.from("x"), "audio/ogg")).toBe("inteiro");
    void mkdtemp;
  });
});

describe("PC-021 — mídias não entendidas por dia", () => {
  it("conta por dia no fuso da organização, mais recente primeiro", () => {
    const linhas = contarPorDia(
      [
        { type: "audio", created_at: "2026-11-03T13:00:00Z" },
        { type: "audio", created_at: "2026-11-03T14:00:00Z" },
        { type: "image", created_at: "2026-11-03T15:00:00Z" },
        { type: "audio", created_at: "2026-11-02T02:00:00Z" }, // 01/11 23h em SP
      ],
      "America/Sao_Paulo",
    );
    expect(linhas).toEqual([
      { dia: "03/11", audios: 2, outras: 1 },
      { dia: "01/11", audios: 1, outras: 0 },
    ]);
  });
});
