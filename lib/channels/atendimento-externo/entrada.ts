/**
 * O que a plataforma de atendimento (ChatGuru, PC-047) manda pelo "POST PARA
 * URL" de um diálogo — lido, conferido e normalizado ANTES de qualquer escrita.
 *
 * ─── O fio, medido ──────────────────────────────────────────────────────────
 *
 * Capturado numa entrada de teste em 22/11/2026: os campos são `nome, tags,
 * bsuid, email, origem, celular, chat_id, ctwa_ad, phone_id, username,
 * link_chat, bot_context, campanha_id, chat_created, campanha_nome,
 * datetime_post, executado_por, tipo_mensagem, texto_mensagem,
 * responsavel_nome, responsavel_email, campos_personalizados` (+ `url_arquivo`
 * nas mídias, visto em 26/11/2026). Só os NOMES
 * foram vistos (os valores são dado de quem escreveu), então a leitura aceita
 * texto ou número em cada campo e exige só o que é indispensável: o número do
 * chat (`celular`) e o que a pessoa disse (`texto_mensagem`).
 *
 * O corpo pode vir em JSON ou em formulário: os dois são lidos.
 *
 * ─── Não há id de mensagem ──────────────────────────────────────────────────
 *
 * O POST não traz o id da mensagem. Para a reentrega não virar duas linhas, o
 * `external_id` é derivado do que identifica a mensagem: número na plataforma,
 * chat, carimbo do POST, tipo e texto. O mesmo POST duas vezes dá o mesmo id —
 * e o `unique (organization_id, external_id)` faz o resto.
 *
 * ─── O segredo ──────────────────────────────────────────────────────────────
 *
 * A plataforma não assina o POST. O que prova a origem é o SEGREDO da conexão,
 * que viaja no caminho da URL (`/webhooks/channel/<token>/<segredo>`, a rota
 * aninhada o põe no cabeçalho `HEADER_DO_SEGREDO`) ou direto nesse cabeçalho,
 * para quem conseguir configurar um. Comparação em tempo constante.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { linkDoChatConferido } from "./link";

/** Cabeçalho que carrega o segredo da conexão até a conferência. */
export const HEADER_DO_SEGREDO = "x-webhook-segredo";

/** Curto demais para ser segredo — placeholder ou lixo de decrypt. */
const SEGREDO_MINIMO = 16;

/** O POST traz o segredo certo desta conexão? Falha FECHADA em qualquer dúvida. */
export function segredoConfere(headers: Headers, segredo: string | null): boolean {
  if (!segredo || segredo.length < SEGREDO_MINIMO) return false;
  const veio = headers.get(HEADER_DO_SEGREDO);
  if (!veio) return false;
  const a = Buffer.from(veio, "utf8");
  const b = Buffer.from(segredo, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface EntradaDoAtendimentoExterno {
  /** Número do chat como a plataforma o endereça: só dígitos, com DDI. */
  celular: string;
  chatId: string | null;
  phoneId: string | null;
  nome: string | null;
  /** Vocabulário de `messages.type`. */
  tipo: "text" | "image" | "video" | "audio" | "document";
  /** Texto, ou legenda/descrição quando há mídia. */
  texto: string;
  /** URL https da mídia, quando a plataforma mandou mídia com link. */
  midiaUrl: string | null;
  /** Carimbo do POST como veio (formato da plataforma), ou `null`. */
  dataHora: string | null;
  /** Link do chat dentro da plataforma, já conferido (https, domínio dela). */
  linkChat: string | null;
}

export type LeituraDaEntrada =
  | { ok: true; entrada: EntradaDoAtendimentoExterno }
  | { ok: true; ignorar: string }
  | { ok: false; motivo: "json_invalido" }
  | { ok: false; motivo: "contrato_violado"; campos: string[] };

/** Texto do campo, aceitando número; vazio vira `null`. */
function texto(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function lerCorpo(raw: string): Record<string, unknown> | null {
  const bruto = raw.trim();
  if (bruto.startsWith("{")) {
    try {
      const p = JSON.parse(bruto) as unknown;
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  if (bruto.includes("=")) {
    const form = new URLSearchParams(bruto);
    const obj: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) obj[k] = v;
    return Object.keys(obj).length > 0 ? obj : null;
  }
  return null;
}

function urlHttps(v: string): string | null {
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** `tipo_mensagem` da plataforma → `messages.type`. Desconhecido conta como texto. */
function tipoDaMensagem(v: string | null): EntradaDoAtendimentoExterno["tipo"] {
  const t = (v ?? "").toLowerCase();
  if (["image", "imagem", "foto", "sticker"].includes(t)) return "image";
  if (["video", "vídeo"].includes(t)) return "video";
  if (["audio", "áudio", "ptt", "voice", "voz"].includes(t)) return "audio";
  if (["document", "documento", "file", "arquivo"].includes(t)) return "document";
  return "text";
}

export function lerEntrada(rawBody: string): LeituraDaEntrada {
  const corpo = lerCorpo(rawBody);
  if (!corpo) return { ok: false, motivo: "json_invalido" };

  const celularBruto = texto(corpo.celular);
  const conteudo = texto(corpo.texto_mensagem);
  const tipoDeclarado = tipoDaMensagem(texto(corpo.tipo_mensagem));
  // PC-060: o ChatGuru manda o arquivo em `url_arquivo` (medido em 26/11/2026:
  // áudio chega com `texto_mensagem: "audio"` e o link do S3 neste campo). O
  // link dentro de `texto_mensagem` segue aceito, como antes.
  const linkDoArquivo = tipoDeclarado === "text" ? null : urlHttps(texto(corpo.url_arquivo) ?? "");

  // Áudio ou figurinha sem link nem descrição: não há o que ler, e 400 só faria
  // a plataforma reentregar para sempre. Fica no arquivo do webhook com o motivo.
  if (celularBruto && !conteudo && !linkDoArquivo && tipoDeclarado !== "text") return { ok: true, ignorar: "midia_sem_link" };

  const faltando: string[] = [];
  if (!celularBruto) faltando.push("celular");
  if (!conteudo && !linkDoArquivo) faltando.push("texto_mensagem");
  if (faltando.length > 0) return { ok: false, motivo: "contrato_violado", campos: faltando };

  // Grupo e endereço que não é telefone NÃO viram lead (PC-047, "não fazer"):
  // 200 com o motivo, para a plataforma não reentregar o que nunca vai entrar.
  // Id de grupo tem `@` (`…@g.us`) ou passa de 15 dígitos; telefone formatado
  // ("+55 (11) 99999-9999") só perde a pontuação.
  if (celularBruto!.includes("@")) return { ok: true, ignorar: "grupo_ou_endereco_nao_suportado" };
  const celular = celularBruto!.replace(/\D/g, "");
  if (celular.length > 15) return { ok: true, ignorar: "grupo_ou_endereco_nao_suportado" };
  if (celular.length < 10) return { ok: true, ignorar: "numero_fora_do_formato" };

  const tipo = tipoDeclarado;
  const midiaUrl = tipo === "text" ? null : (linkDoArquivo ?? urlHttps(conteudo ?? ""));

  return {
    ok: true,
    entrada: {
      celular,
      chatId: texto(corpo.chat_id),
      phoneId: texto(corpo.phone_id),
      nome: texto(corpo.nome),
      // Mídia sem link vira texto: a descrição que a plataforma mandou é o que
      // há para ler, e uma bolha de "imagem" sem imagem seria pior.
      tipo: midiaUrl ? tipo : "text",
      texto: midiaUrl ? "" : (conteudo ?? ""),
      midiaUrl,
      dataHora: texto(corpo.datetime_post),
      linkChat: linkDoChatConferido(corpo.link_chat),
    },
  };
}

/**
 * O `external_id` desta mensagem. Sem carimbo do POST, usa o minuto em que
 * chegou: reentrega no mesmo minuto não duplica, e a mesma frase dita de novo
 * minutos depois não é engolida como se fosse reentrega.
 */
export function idExternoDaEntrada(e: EntradaDoAtendimentoExterno, agora: Date = new Date()): string {
  const carimbo = e.dataHora ?? agora.toISOString().slice(0, 16);
  // PC-060: o link do arquivo vem assinado (a assinatura muda a cada reentrega);
  // só o endereço, sem a parte depois do `?`, identifica a mensagem.
  const midia = e.midiaUrl ? e.midiaUrl.split("?")[0]! : null;
  const base = [e.phoneId ?? "", e.chatId ?? "", e.celular, carimbo, e.tipo, midia ?? e.texto].join("|");
  return `ext_${createHash("sha256").update(base).digest("hex").slice(0, 40)}`;
}

/** O corpo do POST como objeto (JSON ou formulário), sem validar — para a enquete (PC-050). */
export function corpoDoPost(rawBody: string): Record<string, unknown> | null {
  return lerCorpo(rawBody);
}

/** O `phone_id` que o corpo declara, sem validar o resto — para a guarda de conta. */
export function phoneIdDoCorpo(rawBody: string): string | null {
  const corpo = lerCorpo(rawBody);
  return corpo ? texto(corpo.phone_id) : null;
}
