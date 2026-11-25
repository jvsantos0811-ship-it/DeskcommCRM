/**
 * A MÍDIA DO AQUECIMENTO (PC-052 parte 3, a parte 2 do PC-045): um vídeo e até
 * três imagens da organização, que a sequência depois de marcar manda na noite
 * do dia em que a reunião foi marcada.
 *
 * Mora no bucket privado `agenda-media` (migration 9043), sob o prefixo da
 * organização, e o caminho fica em `organizations.settings.midia_do_aquecimento`.
 * Este é o schema ÚNICO dessa chave: a rota grava, o cron lê, e ninguém lê o
 * caminho do jsonb direto. `lerMidiaDoAquecimento` nunca lança e só aceita
 * caminho DESTA organização — a linha é gravável e o bucket é assinado pelo
 * service_role.
 *
 * O tipo do arquivo é FAREJADO pelos bytes, nunca pelo `content-type` que o
 * navegador declara.
 */

export const BUCKET_DA_MIDIA_DA_AGENDA = "agenda-media";

/** 16 MB: o teto de vídeo do WhatsApp. Igual ao `file_size_limit` do bucket. */
export const TAMANHO_MAXIMO_DO_VIDEO = 16 * 1024 * 1024;
/** 5 MB por imagem: o teto de imagem do WhatsApp. */
export const TAMANHO_MAXIMO_DA_IMAGEM = 5 * 1024 * 1024;
export const MAXIMO_DE_IMAGENS = 3;

export type TipoDaMidiaDoAquecimento = "video/mp4" | "image/jpeg" | "image/png";

export interface ArquivoDoAquecimento {
  caminho: string;
  mime: TipoDaMidiaDoAquecimento;
  bytes: number;
}

export interface MidiaDoAquecimento {
  video: ArquivoDoAquecimento | null;
  imagens: ArquivoDoAquecimento[];
}

export const MIDIA_VAZIA: MidiaDoAquecimento = Object.freeze({ video: null, imagens: [] }) as MidiaDoAquecimento;

/** Pelos primeiros bytes: MP4 (`ftyp` no byte 4), JPEG e PNG. */
export function farejarMidiaDoAquecimento(bytes: Uint8Array): TipoDaMidiaDoAquecimento | null {
  if (bytes.length < 12) return null;
  const ascii = (inicio: number, fim: number) => String.fromCharCode(...bytes.slice(inicio, fim));
  if (ascii(4, 8) === "ftyp") return "video/mp4";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  return null;
}

export function extensaoDaMidia(tipo: TipoDaMidiaDoAquecimento): string {
  return tipo === "video/mp4" ? "mp4" : tipo === "image/jpeg" ? "jpg" : "png";
}

const TIPOS: readonly string[] = ["video/mp4", "image/jpeg", "image/png"];

function arquivo(v: unknown, orgId: string): ArquivoDoAquecimento | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.caminho !== "string" || !o.caminho.startsWith(`${orgId}/`)) return null;
  // O prefixo sozinho não prova posse: nada de `..` ou segmento vazio depois dele.
  if (o.caminho.slice(orgId.length + 1).split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  if (typeof o.mime !== "string" || !TIPOS.includes(o.mime)) return null;
  return {
    caminho: o.caminho,
    mime: o.mime as TipoDaMidiaDoAquecimento,
    bytes: typeof o.bytes === "number" && Number.isFinite(o.bytes) ? o.bytes : 0,
  };
}

/** Lê `settings.midia_do_aquecimento`. Nunca lança; o que não passa vira ausência. */
export function lerMidiaDoAquecimento(settings: unknown, orgId: string): MidiaDoAquecimento {
  const s = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  const bruto = s.midia_do_aquecimento;
  if (!bruto || typeof bruto !== "object") return MIDIA_VAZIA;
  const b = bruto as Record<string, unknown>;
  const video = arquivo(b.video, orgId);
  const imagens = (Array.isArray(b.imagens) ? b.imagens : [])
    .map((i) => arquivo(i, orgId))
    .filter((i): i is ArquivoDoAquecimento => i !== null && i.mime !== "video/mp4")
    .slice(0, MAXIMO_DE_IMAGENS);
  return { video: video && video.mime === "video/mp4" ? video : null, imagens };
}

export function midiaParaGravar(m: MidiaDoAquecimento): Record<string, unknown> {
  return {
    video: m.video,
    imagens: m.imagens.slice(0, MAXIMO_DE_IMAGENS),
  };
}

export function temMidia(m: MidiaDoAquecimento): boolean {
  return m.video !== null || m.imagens.length > 0;
}
