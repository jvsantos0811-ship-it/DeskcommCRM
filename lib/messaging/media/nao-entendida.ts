/**
 * ÁUDIO OU IMAGEM QUE NÃO DEU PARA ENTENDER (PC-021, Pacote Conversa).
 *
 * ## O defeito
 *
 * O leitor de mídia gravava "não lida" para imagem que o modelo não enxergava,
 * mas o áudio que transcrevia mal, vazio ou só com ruído seguia para o turno
 * como se fosse fala válida — e o turno respondia ao que leu. Medido na Bórbora
 * (pulso 31/10): áudio ignorado numa conversa e transcrição errada em outra; o
 * cliente do previdenciário manda muito áudio (idosos, pouca leitura).
 *
 * ## A régua (pura; sem import, vai também para o cliente)
 *
 * Áudio NÃO ENTENDIDO quando a transcrição volta vazia, é só ruído (as
 * "alucinações" conhecidas do Whisper em silêncio — "Legendas pela comunidade
 * Amara.org", "Obrigado por assistir", "[Música]"…), ou é curta demais para a
 * duração (menos de 3 palavras num áudio de mais de 5 s). O derivado vira
 * "ÁUDIO NÃO ENTENDIDO (duração Ns)" e o turno recebe a instrução de pedir, com
 * naturalidade, que a pessoa repita ou escreva — nunca responder como se
 * tivesse entendido. Imagem ou PDF ilegível → "MÍDIA NÃO ENTENDIDA (tipo)",
 * mesma conduta.
 */

export const PREFIXO_AUDIO_NAO_ENTENDIDO = "ÁUDIO NÃO ENTENDIDO";
export const PREFIXO_MIDIA_NAO_ENTENDIDA = "MÍDIA NÃO ENTENDIDA";

/** O marcador antigo de mídia não lida (configuração) — o turno o trata igual. */
const MARCADOR_ANTIGO = "[o cliente enviou uma mídia que não consegui interpretar]";

/** "ÁUDIO NÃO ENTENDIDO (duração 12s)" — sem duração conhecida, sem o parêntese. */
export function marcadorDeAudioNaoEntendido(duracaoS: number | null): string {
  return duracaoS !== null && Number.isFinite(duracaoS) && duracaoS > 0
    ? `${PREFIXO_AUDIO_NAO_ENTENDIDO} (duração ${Math.round(duracaoS)}s)`
    : PREFIXO_AUDIO_NAO_ENTENDIDO;
}

const ROTULO: Record<string, string> = { image: "imagem", document: "documento", video: "vídeo", audio: "áudio" };

/** "MÍDIA NÃO ENTENDIDA (imagem)". */
export function marcadorDeMidiaNaoEntendida(tipo: string): string {
  return `${PREFIXO_MIDIA_NAO_ENTENDIDA} (${ROTULO[tipo] ?? tipo})`;
}

/** O derivado diz que a mídia NÃO foi entendida (inclusive o marcador antigo)? */
export function ehMidiaNaoEntendida(derivado: string | null | undefined): boolean {
  if (!derivado) return false;
  const t = derivado.trim();
  return (
    t.startsWith(PREFIXO_AUDIO_NAO_ENTENDIDO) || t.startsWith(PREFIXO_MIDIA_NAO_ENTENDIDA) || t === MARCADOR_ANTIGO
  );
}

/**
 * Frases que o transcritor devolve para áudio SEM fala (ruído, silêncio,
 * música). Comparadas com o texto inteiro, sem pontuação nem caixa.
 */
const ALUCINACOES = [
  "legendas pela comunidade amara org",
  "legenda adriana zanotto",
  "obrigado por assistir",
  "obrigada por assistir",
  "obrigado por assistirem",
  "thanks for watching",
  "thank you for watching",
  "subtitles by the amara org community",
  "inscreva se no canal",
  "musica",
  "som de fundo",
  "ruido",
  "silencio",
  "inaudivel",
  "aplausos",
  "risos",
];

function semAcento(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function palavras(t: string): string[] {
  return semAcento(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export type AvaliacaoDaTranscricao =
  | { entendida: true }
  | { entendida: false; motivo: "vazia" | "so_ruido" | "curta_demais" };

/**
 * A transcrição serve como fala do cliente? Pura.
 *
 *  - vazia (ou só pontuação/símbolos);
 *  - só ruído: marcações entre colchetes/parênteses ("[Música]", "(ruído)"),
 *    símbolos musicais, ou uma das alucinações conhecidas do transcritor;
 *  - curta demais: menos de 3 palavras num áudio de mais de 5 s (a duração
 *    desconhecida não reprova).
 */
export function avaliarTranscricao(texto: string, duracaoS: number | null): AvaliacaoDaTranscricao {
  const semMarcacoes = texto.replace(/\[[^\]]*\]|\([^)]*\)|[♪♫]/g, " ");
  const p = palavras(semMarcacoes);
  if (palavras(texto).length === 0) return { entendida: false, motivo: "vazia" };
  if (p.length === 0) return { entendida: false, motivo: "so_ruido" };
  const junto = p.join(" ");
  if (ALUCINACOES.some((a) => junto === a || junto === `${a} ${a}`)) return { entendida: false, motivo: "so_ruido" };
  if (duracaoS !== null && duracaoS > 5 && p.length < 3) return { entendida: false, motivo: "curta_demais" };
  return { entendida: true };
}

/**
 * Duração de um áudio OGG/Opus (a nota de voz do WhatsApp), lida do próprio
 * arquivo: a posição (granule) da última página dividida por 48 kHz, menos o
 * pre-skip do cabeçalho Opus. Outro formato, ou arquivo estranho → `null`. Pura.
 */
export function duracaoDoOggOpus(buf: Uint8Array): number | null {
  const ehOggS = (i: number) => buf[i] === 0x4f && buf[i + 1] === 0x67 && buf[i + 2] === 0x67 && buf[i + 3] === 0x53;
  if (buf.length < 64 || !ehOggS(0)) return null;
  // pre-skip: "OpusHead" + versão(1) + canais(1) + pre-skip(2, LE)
  let preSkip = 0;
  for (let i = 0; i < Math.min(buf.length - 12, 512); i++) {
    if (
      buf[i] === 0x4f && buf[i + 1] === 0x70 && buf[i + 2] === 0x75 && buf[i + 3] === 0x73 &&
      buf[i + 4] === 0x48 && buf[i + 5] === 0x65 && buf[i + 6] === 0x61 && buf[i + 7] === 0x64
    ) {
      preSkip = buf[i + 10]! | (buf[i + 11]! << 8);
      break;
    }
  }
  for (let i = buf.length - 27; i >= 0; i--) {
    if (!ehOggS(i)) continue;
    let granule = 0;
    for (let b = 7; b >= 0; b--) granule = granule * 256 + buf[i + 6 + b]!;
    if (granule <= 0 || !Number.isFinite(granule)) return null;
    const s = (granule - preSkip) / 48_000;
    return s > 0 && s < 24 * 3600 ? s : null;
  }
  return null;
}

/** Áudio acima disto é transcrito EM PARTES (inteiro, sem cortar em silêncio). */
export const AUDIO_LONGO_S = 180;
/** Tamanho de cada parte do áudio longo. */
export const PARTE_DO_AUDIO_S = 120;

/** Idioma ISO-639-1 do locale da organização ("pt-BR" → "pt"). `null` se não der para ler. */
export function idiomaDoLocale(locale: string | null | undefined): string | null {
  const m = /^([a-z]{2,3})(?:[-_][A-Za-z]{2})?$/.exec((locale ?? "").trim());
  return m ? m[1]!.toLowerCase() : null;
}
