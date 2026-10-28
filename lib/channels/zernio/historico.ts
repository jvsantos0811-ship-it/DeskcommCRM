/**
 * Histórico da caixa de entrada do canal intermediado — a LEITURA, pura.
 *
 * O número que entra em coexistência traz até seis meses de conversa
 * individual para a caixa de entrada do provedor. Ao CRM só chega o que o
 * webhook entrega dali em diante; o passado mora na API de listagem. Este
 * módulo decide *o que a resposta da API diz* — sem banco, sem rede, sem
 * relógio —, e o importador (`./importar-historico.ts`) faz os efeitos.
 *
 * ─── Por que o `id` da mensagem casa com o do webhook ─────────────────────
 *
 * Medido em 24/09/2026 (`./localizacao.ts`): o `id` da mensagem na API de
 * listagem é o wamid, o MESMO `external_id` que o webhook grava. Por isso a
 * importação reaproveita `unique (organization_id, external_id)`: uma mensagem
 * que chegou pelo webhook e reaparece na listagem não vira uma segunda linha.
 * `platformMessageId` é lido primeiro quando existir, pela mesma regra do
 * parser do webhook.
 */
import { corpoDaLocalizacao, lerLocalizacao, type Localizacao } from "@/lib/messaging/localizacao";

import { resolveZernioIdentity, type ZernioIdentity } from "./webhook";

type Bruto = Record<string, unknown>;
const obj = (v: unknown): Bruto | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Uma conversa da listagem, já reduzida ao que a importação usa. */
export interface ConversaDoHistorico {
  /** Id da thread no provedor — o mesmo `conversationId` do webhook. */
  id: string;
  isGroup: boolean;
  /** Quando o provedor diz que a conversa mudou por último. */
  atualizadaEm: string | null;
  identity: ZernioIdentity;
}

export interface PaginaDeConversas {
  conversas: ConversaDoHistorico[];
  /** Conversas que vieram sem como saber quem é a pessoa. Contadas, não gravadas. */
  semIdentidade: number;
  proximoCursor: string | null;
  /** O provedor recusou a conta nesta página (e quanto pede para esperar). */
  contaRecusada: { erro: string; esperarSegundos: number | null } | null;
}

/**
 * Página de `GET /v1/inbox/conversations`.
 *
 * A identidade vem dos campos da CONVERSA (`participantId`, que é o telefone
 * sem `+`; `businessScopedUserId`; `participantName`), não das mensagens: é a
 * mesma pessoa do começo ao fim, e lê-la uma vez por conversa evita que duas
 * mensagens com remetentes diferentes (a nossa e a dela) disputem o contato.
 */
export function lerPaginaDeConversas(payload: unknown, accountId: string): PaginaDeConversas {
  const p = obj(payload) ?? {};
  const lista = Array.isArray(p.data) ? p.data : [];
  const conversas: ConversaDoHistorico[] = [];
  let semIdentidade = 0;

  for (const bruto of lista) {
    const c = obj(bruto);
    if (!c) continue;
    const id = str(c.id);
    if (!id) continue;
    // A conta serve outras redes; e a listagem filtrada por conta ainda pode
    // devolver item de outra (o filtro é do provedor, não nosso).
    if (str(c.platform) && str(c.platform) !== "whatsapp") continue;
    if (str(c.accountId) && str(c.accountId) !== accountId) continue;

    const digitos = (str(c.participantId) ?? "").replace(/\D/g, "");
    const identity = resolveZernioIdentity({
      phoneNumber: digitos.length >= 8 ? `+${digitos}` : null,
      businessScopedUserId: c.businessScopedUserId,
      whatsappUsername: c.whatsappUsername,
      name: c.participantName,
    });
    const isGroup = c.isGroup === true;
    if (!isGroup && !identity.anchor) {
      semIdentidade++;
      continue;
    }
    conversas.push({ id, isGroup, atualizadaEm: str(c.updatedTime), identity });
  }

  const pag = obj(p.pagination);
  const temMais = pag?.hasMore === true;
  const falhas = Array.isArray(obj(p.meta)?.failedAccounts) ? (obj(p.meta)!.failedAccounts as unknown[]) : [];
  const recusa = falhas.map(obj).find((f) => f && (!str(f.accountId) || str(f.accountId) === accountId));

  return {
    conversas,
    semIdentidade,
    proximoCursor: temMais ? str(pag?.nextCursor) : null,
    contaRecusada: recusa
      ? {
          erro: str(recusa.error) ?? str(recusa.code) ?? "conta_recusada",
          esperarSegundos: typeof recusa.retryAfter === "number" ? recusa.retryAfter : null,
        }
      : null,
  };
}

/** Uma mensagem pronta para gravar — o vocabulário de `messages`. */
export interface MensagemDoHistorico {
  externalId: string;
  direction: "inbound" | "outbound";
  /** Hora em que a mensagem foi ESCRITA, não a em que chegou ao CRM. */
  sentAt: string;
  type: "text" | "image" | "video" | "audio" | "sticker" | "document" | "location";
  body: string | null;
  status: "sent" | "delivered" | "read" | "failed";
  mediaUrl: string | null;
  mediaMime: string | null;
  /** A mensagem tinha mídia e o provedor não entregou o arquivo (coexistência antiga). */
  midiaSemArquivo: boolean;
  metadata: Record<string, unknown>;
}

export interface PaginaDeMensagens {
  mensagens: MensagemDoHistorico[];
  /** Apagadas, reações e linhas sem nada para mostrar. */
  ignoradas: number;
  proximoCursor: string | null;
}

const TIPOS_DE_ANEXO = new Set(["image", "video", "audio", "sticker"]);

function statusDaSaida(v: string | null): MensagemDoHistorico["status"] {
  switch (v) {
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "failed":
      return "failed";
    default:
      return "sent";
  }
}

/** Página de `GET /v1/inbox/conversations/{id}/messages`. */
export function lerPaginaDeMensagens(payload: unknown): PaginaDeMensagens {
  const p = obj(payload) ?? {};
  const lista = Array.isArray(p.messages) ? p.messages : [];
  const mensagens: MensagemDoHistorico[] = [];
  let ignoradas = 0;

  for (const bruto of lista) {
    const m = obj(bruto);
    if (!m) continue;
    const externalId = str(m.platformMessageId) ?? str(m.id);
    const sentAt = str(m.sentAt) ?? str(m.createdAt);
    if (!externalId || !sentAt || Number.isNaN(Date.parse(sentAt))) {
      ignoradas++;
      continue;
    }
    // Apagada no aplicativo: o cliente não vê mais, e o CRM também não deve
    // mostrar um texto que a pessoa retirou.
    if (m.isDeleted === true || str(m.deletedAt)) {
      ignoradas++;
      continue;
    }
    if (str(m.platform) && str(m.platform) !== "whatsapp") {
      ignoradas++;
      continue;
    }

    const texto = str(m.message);
    const anexos = (Array.isArray(m.attachments) ? m.attachments : []).map(obj).filter((a): a is Bruto => a !== null);
    const primeiro = anexos[0] ?? null;
    const metadata = obj(m.metadata) ?? {};
    const local: Localizacao | null = anexos.length === 0 ? lerLocalizacao(metadata.location) : null;

    if (!texto && !primeiro && !local) {
      ignoradas++;
      continue;
    }

    const tipoDoAnexo = primeiro ? (str(primeiro.type) ?? "file") : null;
    const url = primeiro ? str(primeiro.url) : null;
    const type: MensagemDoHistorico["type"] = local
      ? "location"
      : tipoDoAnexo
        ? TIPOS_DE_ANEXO.has(tipoDoAnexo)
          ? (tipoDoAnexo as MensagemDoHistorico["type"])
          : "document"
        : "text";

    const entrada = str(m.direction) === "incoming";
    mensagens.push({
      externalId,
      direction: entrada ? "inbound" : "outbound",
      sentAt: new Date(sentAt).toISOString(),
      type,
      body: local ? corpoDaLocalizacao(local) : texto,
      status: entrada ? "delivered" : statusDaSaida(str(m.deliveryStatus)),
      mediaUrl: url,
      mediaMime: primeiro ? (str(primeiro.mimeType) ?? null) : null,
      midiaSemArquivo: Boolean(primeiro) && !url,
      metadata: {
        importado_de: "zernio",
        // A chave que o banco já reservou para histórico importado: o gatilho
        // `trg_mensagem_do_vendedor_e_atividade` a respeita (não carimba
        // atividade de negócio com mensagem antiga).
        historico_importado: "true",
        ...(primeiro
          ? {
              provider_attachments: anexos.map((a) => ({
                type: str(a.type) ?? "file",
                url: str(a.url) ?? "",
                ...(str(a.filename) ? { filename: str(a.filename) } : {}),
              })),
            }
          : {}),
        ...(local ? { location: local } : {}),
      },
    });
  }

  const pag = obj(p.pagination);
  return {
    mensagens,
    ignoradas,
    proximoCursor: pag?.hasMore === true ? str(pag.nextCursor) : null,
  };
}

/**
 * As últimas N mensagens, em ordem de tempo, com a data — o que a triagem lê.
 *
 * Linhas de mídia viram um marcador legível ("[imagem]"): a triagem decide
 * pelo assunto da conversa, e a URL não ajuda o modelo a decidir nada.
 */
export function trechoParaTriagem(
  mensagens: Array<Pick<MensagemDoHistorico, "direction" | "sentAt" | "body" | "type">>,
  quantas = 7,
): string {
  const ordenadas = [...mensagens].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  return ordenadas
    .slice(-quantas)
    .map((m) => {
      const quem = m.direction === "inbound" ? "CLIENTE" : "ESCRITÓRIO";
      const dia = m.sentAt.slice(0, 10);
      const corpo =
        m.type === "text" || m.type === "location"
          ? (m.body ?? "").replace(/\s+/g, " ").slice(0, 400)
          : `[${m.type}]${m.body ? ` ${m.body.replace(/\s+/g, " ").slice(0, 200)}` : ""}`;
      return `${dia} ${quem}: ${corpo}`;
    })
    .join("\n");
}
