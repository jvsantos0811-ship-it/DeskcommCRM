/**
 * ADAPTADOR ZAPSIGN (PC-030) — o primeiro serviço de assinatura eletrônica.
 *
 * Conferido na documentação pública da ZapSign em 10/11/2026
 * (docs.zapsign.com.br):
 *
 *   criar      POST   /api/v1/docs/                  (PDF em base64 + signatários)
 *   consultar  GET    /api/v1/docs/{token}/          (situação + link TEMPORÁRIO do assinado)
 *   cancelar   DELETE /api/v1/docs/{token}/          (exclusão lógica: some da tela deles)
 *   listar     GET    /api/v1/docs/?page=1           (a leitura barata do "testar conexão")
 *   aviso      POST   /api/v1/user/company/webhook/  (url + cabeçalhos próprios)
 *   tirar aviso DELETE /api/v1/user/company/webhook/delete/   (corpo { id })
 *
 * Autenticação: `Authorization: Bearer <token da API>`. Ambiente de teste em
 * `sandbox.api.zapsign.com.br` (sem validade jurídica), produção em
 * `api.zapsign.com.br`.
 *
 * A ZapSign NÃO assina o aviso (sem HMAC): a prova de origem é o cabeçalho
 * secreto que nós mesmos cadastramos no aviso, e — mais forte — a situação é
 * SEMPRE relida aqui, com a nossa credencial (`consultar`).
 *
 * Os valores de situação aparecem em duas línguas na documentação (`pending` /
 * `em-curso`, `signed` / `assinado`, `refused` / `recusado`; no signatário
 * `link-opened` / `abriu-link`): o mapa aceita as duas.
 */
import {
  ErroDoServico,
  TETO_DO_PDF_ASSINADO,
  type AvisoDoServico,
  type BuscaHttp,
  type CredencialDoServico,
  type PedidoCriado,
  type PedidoDeAssinatura,
  type ServicoDeAssinatura,
  type SituacaoNoServico,
} from "./servico";

export const BASE_DA_ZAPSIGN = {
  teste: "https://sandbox.api.zapsign.com.br",
  producao: "https://api.zapsign.com.br",
} as const;

/** Tempo máximo de uma chamada: o envio do contrato não pode prender o turno. */
const PRAZO_DA_CHAMADA_MS = 20_000;

interface SignatarioDaZapsign {
  token?: unknown;
  sign_url?: unknown;
  status?: unknown;
  times_viewed?: unknown;
  last_view_at?: unknown;
  signed_at?: unknown;
}

interface DocumentoDaZapsign {
  token?: unknown;
  status?: unknown;
  deleted?: unknown;
  signed_file?: unknown;
  date_limit_to_sign?: unknown;
  rejected_reason?: unknown;
  signers?: unknown;
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Lê a situação da resposta do "detalhar documento". Pura. */
export function situacaoDaZapsign(doc: DocumentoDaZapsign, agora: Date = new Date()): SituacaoNoServico {
  const status = (texto(doc.status) ?? "").toLowerCase();
  const signatarios = (Array.isArray(doc.signers) ? doc.signers : []) as SignatarioDaZapsign[];
  const primeiro = signatarios[0] ?? {};
  const assinadoEm = texto(primeiro.signed_at);
  const vistas = typeof primeiro.times_viewed === "number" ? primeiro.times_viewed : 0;
  const statusDoSignatario = (texto(primeiro.status) ?? "").toLowerCase();
  const abriu = vistas > 0 || statusDoSignatario === "link-opened" || statusDoSignatario === "abriu-link";
  const visualizadoEm = texto(primeiro.last_view_at) ?? (abriu ? agora.toISOString() : null);
  const prazo = texto(doc.date_limit_to_sign);
  const prazoVencido = prazo !== null && !Number.isNaN(Date.parse(prazo)) && Date.parse(prazo) < agora.getTime();
  const base = {
    visualizadoEm: abriu ? visualizadoEm : null,
    assinadoEm,
    motivoRecusa: texto(doc.rejected_reason),
    arquivoAssinadoUrl: texto(doc.signed_file),
  };

  if (doc.deleted === true || status === "lixeira" || status === "deleted") return { ...base, estado: "cancelado" };
  if (status === "signed" || status === "assinado") return { ...base, estado: "assinado" };
  if (status === "refused" || status === "recusado") return { ...base, estado: "recusado" };
  if (prazoVencido) return { ...base, estado: "expirado" };
  return { ...base, estado: abriu ? "visualizado" : "enviado" };
}

/**
 * O aviso da ZapSign diz o documento (`token`) e o evento (`event_type`). O
 * resto do corpo NÃO é lido: a situação vem de `consultar`. Pura.
 */
export function lerAvisoDaZapsign(corpo: unknown): AvisoDoServico | null {
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return null;
  const c = corpo as Record<string, unknown>;
  const documentoId = texto(c.token);
  const evento = texto(c.event_type);
  if (!documentoId || !evento) return null;
  if (!/^[A-Za-z0-9-]{8,80}$/.test(documentoId)) return null;
  return { documentoId, evento: evento.slice(0, 60) };
}

/** Só os dígitos do telefone, separados em DDI e número (a ZapSign pede assim). */
function telefoneDaZapsign(telefone: string): { phone_country: string; phone_number: string } {
  const digitos = telefone.replace(/\D/g, "");
  if (digitos.startsWith("55") && digitos.length >= 12) {
    return { phone_country: "55", phone_number: digitos.slice(2) };
  }
  return { phone_country: "55", phone_number: digitos };
}

export function criarServicoZapsign(cred: CredencialDoServico, busca: BuscaHttp = fetch): ServicoDeAssinatura {
  const base = BASE_DA_ZAPSIGN[cred.ambiente];

  async function chamar(metodo: string, caminho: string, corpo?: unknown): Promise<unknown> {
    let resposta: Response;
    try {
      resposta = await busca(`${base}${caminho}`, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${cred.chave}`,
          Accept: "application/json",
          ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
        signal: AbortSignal.timeout(PRAZO_DA_CHAMADA_MS),
        redirect: "error",
      });
    } catch {
      throw new ErroDoServico("servico_fora", "Não consegui falar com a ZapSign (rede ou tempo esgotado).");
    }
    if (resposta.status === 401 || resposta.status === 403) {
      throw new ErroDoServico("credencial_invalida", "A ZapSign recusou a chave da API.", resposta.status);
    }
    if (resposta.status === 404) {
      throw new ErroDoServico("nao_encontrado", "A ZapSign não achou o documento.", 404);
    }
    if (resposta.status === 400 || resposta.status === 422) {
      throw new ErroDoServico("dado_recusado", "A ZapSign recusou os dados do pedido.", resposta.status);
    }
    if (resposta.status === 402) {
      throw new ErroDoServico("dado_recusado", "A conta da ZapSign está sem plano ou sem saldo de envelopes.", 402);
    }
    if (!resposta.ok) {
      throw new ErroDoServico("servico_fora", `A ZapSign respondeu ${resposta.status}.`, resposta.status);
    }
    if (resposta.status === 204) return null;
    const bruto = await resposta.text();
    if (!bruto) return null;
    try {
      return JSON.parse(bruto) as unknown;
    } catch {
      throw new ErroDoServico("resposta_inesperada", "A ZapSign respondeu num formato que não reconheci.", resposta.status);
    }
  }

  const idDoDocumento = (documentoId: string) => {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(documentoId)) {
      throw new ErroDoServico("nao_encontrado", "Id de documento inválido.");
    }
    return encodeURIComponent(documentoId);
  };

  return {
    id: "zapsign",

    async testarConexao() {
      await chamar("GET", "/api/v1/docs/?page=1");
    },

    async criarPedido(p: PedidoDeAssinatura): Promise<PedidoCriado> {
      const telefone = telefoneDaZapsign(p.signatario.telefone);
      const resposta = (await chamar("POST", "/api/v1/docs/", {
        name: p.nomeDoDocumento.slice(0, 255),
        base64_pdf: p.pdf.toString("base64"),
        lang: "pt-br",
        external_id: p.referencia,
        date_limit_to_sign: p.prazo,
        // O link vai pelo WhatsApp da conversa, pelo CRM: o serviço não manda nada sozinho.
        disable_signer_emails: true,
        allow_refuse_signature: true,
        signers: [
          {
            name: p.signatario.nome.slice(0, 255),
            ...(p.signatario.email ? { email: p.signatario.email } : {}),
            ...telefone,
            auth_mode: "assinaturaTela",
            send_automatic_email: false,
            send_automatic_whatsapp: false,
            lock_name: true,
            lock_phone: true,
            external_id: p.referencia,
            ...(p.signatario.cpf ? { cpf: p.signatario.cpf, require_cpf: true } : {}),
          },
        ],
      })) as DocumentoDaZapsign | null;
      const documentoId = texto(resposta?.token);
      const signatarios = (Array.isArray(resposta?.signers) ? resposta?.signers : []) as SignatarioDaZapsign[];
      const s = signatarios[0];
      // O link vem do serviço, nunca montado aqui: endereço montado à mão
      // apodrece em silêncio quando o serviço muda o caminho.
      const link = texto(s?.sign_url);
      if (!documentoId || !link) {
        throw new ErroDoServico("resposta_inesperada", "A ZapSign criou o pedido sem devolver o documento ou o link.");
      }
      return { documentoId, linkAssinatura: link };
    },

    async consultar(documentoId: string): Promise<SituacaoNoServico> {
      const doc = (await chamar("GET", `/api/v1/docs/${idDoDocumento(documentoId)}/`)) as DocumentoDaZapsign | null;
      if (!doc || typeof doc !== "object") {
        throw new ErroDoServico("resposta_inesperada", "A ZapSign não devolveu o documento.");
      }
      return situacaoDaZapsign(doc);
    },

    async cancelar(documentoId: string) {
      await chamar("DELETE", `/api/v1/docs/${idDoDocumento(documentoId)}/`);
    },

    async baixarAssinado(url: string): Promise<Buffer> {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new ErroDoServico("resposta_inesperada", "Endereço do PDF assinado inválido.");
      }
      if (u.protocol !== "https:") {
        throw new ErroDoServico("resposta_inesperada", "Endereço do PDF assinado sem https.");
      }
      let resposta: Response;
      try {
        // Sem a credencial: o endereço é pré-assinado pelo serviço.
        resposta = await busca(u.toString(), { signal: AbortSignal.timeout(PRAZO_DA_CHAMADA_MS), redirect: "follow" });
      } catch {
        throw new ErroDoServico("servico_fora", "Não consegui baixar o PDF assinado.");
      }
      if (!resposta.ok) throw new ErroDoServico("servico_fora", `Download do PDF assinado: ${resposta.status}.`);
      const bytes = Buffer.from(await resposta.arrayBuffer());
      if (bytes.length === 0 || bytes.length > TETO_DO_PDF_ASSINADO) {
        throw new ErroDoServico("resposta_inesperada", "PDF assinado vazio ou grande demais.");
      }
      if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
        throw new ErroDoServico("resposta_inesperada", "O arquivo assinado não é um PDF.");
      }
      return bytes;
    },

    async registrarAviso(aviso) {
      const r = (await chamar("POST", "/api/v1/user/company/webhook/", {
        url: aviso.url,
        type: "",
        headers: [{ name: aviso.cabecalho, value: aviso.segredo }],
      })) as { id?: unknown } | null;
      const id = r?.id;
      return { avisoId: typeof id === "number" || typeof id === "string" ? String(id) : null };
    },

    async removerAviso(avisoId: string) {
      if (!/^[A-Za-z0-9-]{1,80}$/.test(avisoId)) return;
      try {
        await chamar("DELETE", "/api/v1/user/company/webhook/delete/", { id: avisoId });
      } catch (err) {
        // O aviso antigo já pode ter sido tirado pela tela deles: não é erro.
        if (err instanceof ErroDoServico && err.codigo === "nao_encontrado") return;
        throw err;
      }
    },
  };
}
