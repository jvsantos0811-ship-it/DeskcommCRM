/**
 * A chamada à API v1 da plataforma de atendimento (ChatGuru, PC-047).
 *
 * Um endpoint só, `POST https://<servidor>.chatguru.app/api/v1`, e a operação
 * vai no parâmetro `action` (`message_send`, `note_add`, `dialog_execute`,
 * `chat_update_custom_fields`…). Formato `application/x-www-form-urlencoded`,
 * resposta JSON.
 *
 * ─── A key vai no CORPO, nunca na URL ───────────────────────────────────────
 *
 * A documentação da plataforma mostra a key na query string. O servidor aceita
 * os mesmos parâmetros no corpo do POST — é assim que os conectores dela fazem —
 * e é no corpo que ela vai aqui: query string vaza em log de proxy, de CDN e de
 * qualquer intermediário (regra do CLAUDE.md, "API key NUNCA em query string").
 *
 * ─── O que volta para quem chama ────────────────────────────────────────────
 *
 * A plataforma responde 200 até para recusa e diz o desfecho no corpo
 * (`result: "error"`, `code` ≥ 400). Ler só o status HTTP faria um "chat não
 * encontrado" parecer envio feito. O texto de erro dela pode citar o número do
 * cliente; antes de virar mensagem de erro (que vai para log e para
 * `messages.metadata`), toda sequência longa de dígitos é mascarada.
 */
import { urlDaApi, type CredenciaisDoAtendimentoExterno } from "./credenciais";

const TEMPO_LIMITE_MS = 15_000;

export interface RespostaDaApi {
  /** Id que a plataforma deu à mensagem, quando a operação cria uma. */
  messageId: string | null;
  corpo: Record<string, unknown>;
}

/** Mascara telefone/CPF/qualquer sequência longa de dígitos num texto do provedor. */
export function semDigitosLongos(texto: string): string {
  return texto.replace(/\+?\d[\d\s().-]{7,}\d/g, "…");
}

/**
 * Chama a operação `acao` com os parâmetros dados. LANÇA `chatguru_<código>: <motivo>`
 * quando a plataforma recusa ou não responde — o prefixo é o que o handler de
 * envio reconhece para gravar a falha (ver `codes` do adapter).
 */
export async function chamarApi(
  creds: Pick<CredenciaisDoAtendimentoExterno, "servidor" | "accountId" | "phoneId" | "apiKey">,
  acao: string,
  parametros: Record<string, string>,
  deps: { fetch?: typeof fetch } = {},
): Promise<RespostaDaApi> {
  const corpo = new URLSearchParams({
    ...parametros,
    key: creds.apiKey,
    account_id: creds.accountId,
    phone_id: creds.phoneId,
    action: acao,
  });

  const fazer = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await fazer(urlDaApi(creds.servidor), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: corpo.toString(),
      // A chave vai no corpo: um redirecionamento não pode levá-la a outro host.
      redirect: "error",
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch (err) {
    const motivo = err instanceof Error ? err.message : "erro_desconhecido";
    throw new Error(`chatguru_rede: ${semDigitosLongos(motivo).slice(0, 160)}`);
  }

  const lido = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const json = lido && typeof lido === "object" ? lido : {};
  const codigo = typeof json.code === "number" ? json.code : Number(json.code ?? NaN);
  const recusou =
    !res.ok ||
    json.result === "error" ||
    (Number.isFinite(codigo) && codigo >= 400) ||
    lido === null;

  if (recusou) {
    const descricao =
      typeof json.description === "string"
        ? json.description
        : typeof json.message === "string"
          ? json.message
          : `http_${res.status}`;
    const numero = Number.isFinite(codigo) ? codigo : res.status;
    throw new Error(`chatguru_${numero}: ${semDigitosLongos(descricao).slice(0, 160)}`);
  }

  const id = json.message_id ?? json.messageId ?? null;
  return { messageId: typeof id === "string" && id.length > 0 ? id : null, corpo: json };
}
