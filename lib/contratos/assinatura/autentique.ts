/**
 * ADAPTADOR AUTENTIQUE (PC-046) — o segundo serviço de assinatura eletrônica.
 *
 * Conferido na documentação pública da Autentique em 22/11/2026
 * (docs.autentique.com.br/api, versão 2). A API é SÓ GraphQL, num endereço:
 *
 *   POST https://api.autentique.com.br/v2/graphql
 *   Authorization: Bearer <token da API>
 *
 *   criar       mutation createDocument(sandbox, document, signers, file: Upload!)
 *               (multipart, no padrão "GraphQL multipart request": operations + map + arquivo)
 *   link        mutation createLinkToSignature(public_id) { short_link }
 *   consultar   query document(id) { files { signed } signatures { viewed signed rejected } }
 *   cancelar    mutation deleteDocument(id)   (sem assinatura: some; com assinatura: lixeira)
 *   testar      query me { id }               (a leitura barata do "testar conexão")
 *
 * Diferenças para a ZapSign que mudam o resto do CRM:
 *
 *  - **O teste é um argumento, não outro endereço.** `sandbox: true` no
 *    `createDocument` cria documento sem validade jurídica, na mesma conta.
 *  - **O aviso (webhook) NÃO se cadastra pela API**: o endpoint é criado no
 *    painel da Autentique, que escolhe os eventos e mostra o segredo. Por isso
 *    `cadastroDoAviso = "no_painel"`: a tela de Configurações mostra o endereço
 *    para o gerente colar lá, e o aviso prova a origem pela assinatura HMAC
 *    SHA-256 do corpo, no cabeçalho `x-autentique-signature`
 *    (`assinaturaDoAvisoConfere`). Como sempre, o aviso só diz QUAL documento
 *    mudou: a situação é relida aqui, com a credencial da organização.
 *  - **O signatário entra só com o nome**: assim a Autentique não manda nada
 *    sozinha (nem e-mail, nem WhatsApp, nem SMS) e devolve o link, que o CRM
 *    manda pelo WhatsApp da conversa — o mesmo desenho da ZapSign.
 *  - **Erro vem dentro de HTTP 200**, na lista `errors` do GraphQL: o código
 *    do `ErroDoServico` sai da mensagem, nunca do status.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  ErroDoServico,
  TETO_DO_PDF_ASSINADO,
  type AvisoDoServico,
  type BuscaHttp,
  type CodigoDoErroDoServico,
  type CredencialDoServico,
  type PedidoCriado,
  type PedidoDeAssinatura,
  type ServicoDeAssinatura,
  type SituacaoNoServico,
} from "./servico";

export const ENDERECO_DA_AUTENTIQUE = "https://api.autentique.com.br/v2/graphql";

/** O cabeçalho em que a Autentique manda o HMAC SHA-256 (hex) do corpo do aviso. */
export const CABECALHO_DO_AVISO_DA_AUTENTIQUE = "x-autentique-signature";

/** Tempo máximo de uma chamada: o envio do contrato não pode prender o turno. */
const PRAZO_DA_CHAMADA_MS = 20_000;

/** O id de documento e de assinatura da Autentique: hex/uuid. Nada mais entra no texto da query. */
const ID_SEGURO = /^[A-Za-z0-9-]{8,80}$/;

interface EventoDaAutentique {
  created_at?: unknown;
  reason?: unknown;
}

interface AssinaturaDaAutentique {
  public_id?: unknown;
  name?: unknown;
  action?: { name?: unknown } | null;
  link?: { short_link?: unknown } | null;
  viewed?: EventoDaAutentique | null;
  signed?: EventoDaAutentique | null;
  rejected?: EventoDaAutentique | null;
}

interface DocumentoDaAutentique {
  id?: unknown;
  deadline_at?: unknown;
  files?: { signed?: unknown } | null;
  signatures?: unknown;
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/**
 * A Autentique escreve data como "AAAA-MM-DD HH:MM:SS" (sem fuso, horário de
 * Brasília) ou em ISO. Devolve ISO, ou `null` se não reconhecer. Pura.
 */
export function dataDaAutentique(v: unknown): string | null {
  const s = texto(v);
  if (!s) return null;
  const semFuso = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)$/.exec(s);
  const d = semFuso ? new Date(`${semFuso[1]}T${semFuso[2]}-03:00`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Abriu o link: qualquer objeto basta (só serve para mostrar "visto"). */
const aconteceu = (e: EventoDaAutentique | null | undefined): boolean => Boolean(e && typeof e === "object");
/**
 * Assinou ou recusou: só com DATA válida. Um `signed: {}` ou
 * `{ created_at: null }` para quem ainda não assinou marcaria o contrato como
 * assinado e o negócio como ganho — e a documentação não diz como vem o vazio.
 */
const comData = (e: EventoDaAutentique | null | undefined): boolean =>
  Boolean(e && typeof e === "object" && dataDaAutentique(e.created_at));
const acaoDe = (s: AssinaturaDaAutentique): string => (texto(s.action?.name) ?? "").toUpperCase();

/**
 * Quem tem de assinar: as assinaturas com a ação SIGN. Sem ação nenhuma na
 * resposta (formato inesperado), vale a lista inteira — nunca "ninguém", que
 * faria um documento vazio parecer assinado.
 */
function quemAssina(doc: DocumentoDaAutentique): AssinaturaDaAutentique[] {
  const todas = (Array.isArray(doc.signatures) ? doc.signatures : []).filter(
    (s): s is AssinaturaDaAutentique => Boolean(s) && typeof s === "object",
  );
  const sign = todas.filter((s) => acaoDe(s) === "SIGN");
  return sign.length > 0 ? sign : todas.filter((s) => acaoDe(s) === "");
}

/** Lê a situação da resposta da query `document`. Pura. */
export function situacaoDaAutentique(doc: DocumentoDaAutentique, agora: Date = new Date()): SituacaoNoServico {
  const alvo = quemAssina(doc);
  const recusa = alvo.find((s) => comData(s.rejected));
  const todosAssinaram = alvo.length > 0 && alvo.every((s) => comData(s.signed));
  const vistas = alvo
    .filter((s) => aconteceu(s.viewed) || comData(s.signed))
    .map((s) => dataDaAutentique(s.viewed?.created_at) ?? dataDaAutentique(s.signed?.created_at) ?? agora.toISOString())
    .sort();
  const assinaturas = alvo
    .map((s) => dataDaAutentique(s.signed?.created_at))
    .filter((d): d is string => d !== null)
    .sort();
  const prazo = dataDaAutentique(doc.deadline_at);
  const prazoVencido = prazo !== null && Date.parse(prazo) < agora.getTime();
  const base = {
    visualizadoEm: vistas[0] ?? null,
    assinadoEm: todosAssinaram ? (assinaturas.at(-1) ?? null) : null,
    motivoRecusa: recusa ? texto(recusa.rejected?.reason) : null,
    arquivoAssinadoUrl: todosAssinaram ? texto(doc.files?.signed) : null,
  };

  if (recusa) return { ...base, estado: "recusado" };
  if (todosAssinaram) return { ...base, estado: "assinado" };
  if (prazoVencido) return { ...base, estado: "expirado" };
  return { ...base, estado: base.visualizadoEm ? "visualizado" : "enviado" };
}

/**
 * O aviso da Autentique: `{ event: { type, data } }`. Em evento de documento,
 * `data` é o documento (`data.id`); em evento de assinatura, `data` é a
 * assinatura, que aponta o documento (`data.document.id` ou `data.document`).
 * O resto do corpo NÃO é lido: a situação vem de `consultar`. Pura.
 */
export function lerAvisoDaAutentique(corpo: unknown): AvisoDoServico | null {
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return null;
  const evento = (corpo as { event?: unknown }).event;
  if (!evento || typeof evento !== "object") return null;
  const e = evento as { type?: unknown; data?: unknown };
  const tipo = texto(e.type);
  if (!tipo || !e.data || typeof e.data !== "object") return null;
  const dados = e.data as { id?: unknown; object?: unknown; document?: unknown; document_id?: unknown };
  const doDocumento = tipo.startsWith("document.") || texto(dados.object) === "document";
  const documento =
    typeof dados.document === "object" && dados.document !== null
      ? texto((dados.document as { id?: unknown }).id)
      : texto(dados.document);
  const documentoId = doDocumento ? texto(dados.id) : (documento ?? texto(dados.document_id));
  if (!documentoId || !ID_SEGURO.test(documentoId)) return null;
  return { documentoId, evento: tipo.slice(0, 60) };
}

/**
 * Confere a assinatura do aviso: HMAC SHA-256 do corpo BRUTO (os bytes que
 * chegaram — reserializar o JSON muda os bytes), em hex, em tempo constante.
 * Vale se bater com QUALQUER um dos segredos dados (o segredo do endpoint que
 * o gerente colou e, como reserva, o token da API). Pura.
 */
export function assinaturaDoAvisoConfere(
  corpoBruto: string | Buffer,
  cabecalho: string | null,
  segredos: ReadonlyArray<string | null>,
): boolean {
  const recebida = (cabecalho ?? "").trim().toLowerCase().replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/.test(recebida)) return false;
  const recebidaBytes = Buffer.from(recebida, "hex");
  let confere = false;
  for (const segredo of segredos) {
    if (!segredo) continue;
    const hmac = createHmac("sha256", segredo);
    if (typeof corpoBruto === "string") hmac.update(corpoBruto, "utf8");
    else hmac.update(corpoBruto);
    const esperada = hmac.digest();
    // Sem atalho: todo segredo é comparado, para o tempo não dizer qual bateu.
    if (esperada.length === recebidaBytes.length && timingSafeEqual(esperada, recebidaBytes)) confere = true;
  }
  return confere;
}

/** O prazo AAAA-MM-DD vira o fim do dia em Brasília, em ISO (o `deadline_at`). */
export function prazoDaAutentique(prazo: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(prazo)) return null;
  const d = new Date(`${prazo}T23:59:59.999-03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** O código do erro, pela MENSAGEM do GraphQL (o status é 200 mesmo no erro). */
export function codigoDoErroDaAutentique(mensagem: string): CodigoDoErroDoServico {
  const m = mensagem.toLowerCase();
  if (/unauthenticated|unauthori[sz]ed|not authenticated|invalid token|token inv|não autenticad|nao autenticad/.test(m)) {
    return "credencial_invalida";
  }
  if (/not.?found|não encontrad|nao encontrad|does not exist|não existe/.test(m)) return "nao_encontrado";
  if (/credit|crédito|credito|saldo|balance|\bplan|plano|limit|quota|validation|invalid|inválid|required|obrigat/.test(m)) {
    return "dado_recusado";
  }
  return "resposta_inesperada";
}

/** A frase do erro quando a Autentique recusa o PRAZO (recurso de plano): o único erro que se tenta de novo. */
const FRASE_DO_PRAZO_RECUSADO = "A Autentique recusou o prazo de assinatura.";

const FRASE_DO_ERRO: Record<CodigoDoErroDoServico, string> = {
  credencial_invalida: "A Autentique recusou o token da API.",
  servico_fora: "Não consegui falar com a Autentique (rede ou tempo esgotado).",
  dado_recusado: "A Autentique recusou os dados do pedido (ou a conta está sem plano ou sem saldo).",
  nao_encontrado: "A Autentique não achou o documento.",
  resposta_inesperada: "A Autentique respondeu num formato que não reconheci.",
};

/** Escolhe a assinatura do nosso signatário: a ação SIGN, de preferência com o mesmo nome. */
function assinaturaDoSignatario(lista: unknown, nome: string): AssinaturaDaAutentique | null {
  const todas = (Array.isArray(lista) ? lista : []).filter(
    (s): s is AssinaturaDaAutentique => Boolean(s) && typeof s === "object",
  );
  const comAcao = todas.filter((s) => acaoDe(s) === "SIGN");
  const sign = comAcao.length > 0 ? comAcao : todas.filter((s) => acaoDe(s) === "");
  const normal = (v: unknown) => (texto(v) ?? "").toLocaleLowerCase("pt-BR");
  return sign.find((s) => normal(s.name) === normal(nome)) ?? (sign.length === 1 ? sign[0]! : null);
}

const MUTATION_CRIAR = (sandbox: boolean) => `mutation CriarDocumento($document: DocumentInput!, $signers: [SignerInput!]!, $file: Upload!) {
  createDocument(${sandbox ? "sandbox: true, " : ""}document: $document, signers: $signers, file: $file) {
    id
    signatures { public_id name action { name } link { short_link } }
  }
}`;

export function criarServicoAutentique(cred: CredencialDoServico, busca: BuscaHttp = fetch): ServicoDeAssinatura {
  const sandbox = cred.ambiente === "teste";

  /** Uma chamada ao GraphQL. `corpo` já montado (JSON ou multipart). */
  async function chamar(corpo: string | FormData): Promise<Record<string, unknown>> {
    let resposta: Response;
    try {
      resposta = await busca(ENDERECO_DA_AUTENTIQUE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cred.chave}`,
          Accept: "application/json",
          // No multipart, o `fetch` põe o Content-Type com o boundary sozinho.
          ...(typeof corpo === "string" ? { "Content-Type": "application/json" } : {}),
        },
        body: corpo,
        signal: AbortSignal.timeout(PRAZO_DA_CHAMADA_MS),
        redirect: "error",
      });
    } catch {
      throw new ErroDoServico("servico_fora", FRASE_DO_ERRO.servico_fora);
    }
    if (resposta.status === 401 || resposta.status === 403) {
      throw new ErroDoServico("credencial_invalida", FRASE_DO_ERRO.credencial_invalida, resposta.status);
    }
    if (resposta.status === 413) {
      throw new ErroDoServico("dado_recusado", "A Autentique recusou o arquivo (grande demais).", 413);
    }
    if (resposta.status >= 500 || resposta.status === 429) {
      throw new ErroDoServico("servico_fora", `A Autentique respondeu ${resposta.status}.`, resposta.status);
    }
    const bruto = await resposta.text().catch(() => "");
    let json: unknown;
    try {
      json = bruto ? JSON.parse(bruto) : null;
    } catch {
      throw new ErroDoServico("resposta_inesperada", FRASE_DO_ERRO.resposta_inesperada, resposta.status);
    }
    const j = (json && typeof json === "object" ? json : {}) as { data?: unknown; errors?: unknown };
    const erros = Array.isArray(j.errors) ? j.errors : [];
    if (erros.length > 0) {
      // Só a mensagem decide o código; o corpo inteiro nunca vai para erro ou log
      // (a Autentique pode ecoar o nome do signatário).
      const mensagem = erros
        .map((e) => (e && typeof e === "object" ? texto((e as { message?: unknown }).message) : null) ?? "")
        .join(" | ");
      const codigo = codigoDoErroDaAutentique(mensagem);
      if (codigo !== "credencial_invalida" && /deadline|prazo/i.test(mensagem)) {
        // O documento pode ter nascido mesmo com o aviso do prazo: nesse caso
        // segue com ele, para a nova tentativa não criar um duplicado.
        const criado = (j.data as { createDocument?: { id?: unknown } } | null | undefined)?.createDocument;
        if (criado && texto(criado.id)) return j.data as Record<string, unknown>;
        throw new ErroDoServico("dado_recusado", FRASE_DO_PRAZO_RECUSADO, resposta.status);
      }
      throw new ErroDoServico(codigo, FRASE_DO_ERRO[codigo], resposta.status);
    }
    if (!resposta.ok) {
      const codigo: CodigoDoErroDoServico = resposta.status === 404 ? "nao_encontrado" : "dado_recusado";
      throw new ErroDoServico(codigo, FRASE_DO_ERRO[codigo], resposta.status);
    }
    if (!j.data || typeof j.data !== "object") {
      throw new ErroDoServico("resposta_inesperada", FRASE_DO_ERRO.resposta_inesperada, resposta.status);
    }
    return j.data as Record<string, unknown>;
  }

  const consulta = (query: string) => JSON.stringify({ query });

  const idSeguro = (id: string) => {
    if (!ID_SEGURO.test(id)) throw new ErroDoServico("nao_encontrado", "Id de documento inválido.");
    return id;
  };

  /** O multipart do `createDocument`, com ou sem o prazo (algumas contas não aceitam o prazo). */
  function corpoDoPedido(p: PedidoDeAssinatura, comPrazo: boolean): FormData {
    const deadline = comPrazo ? prazoDaAutentique(p.prazo) : null;
    const operations = {
      query: MUTATION_CRIAR(sandbox),
      variables: {
        document: {
          name: p.nomeDoDocumento.slice(0, 200),
          refusable: true,
          ...(deadline ? { deadline_at: deadline } : {}),
        },
        // Só o nome: a Autentique gera o link e não manda nada sozinha. O CPF o
        // cliente digita na tela de assinatura (a Autentique pede por padrão).
        signers: [{ name: p.signatario.nome.slice(0, 200), action: "SIGN" }],
        file: null,
      },
    };
    const form = new FormData();
    form.append("operations", JSON.stringify(operations));
    form.append("map", JSON.stringify({ arquivo: ["variables.file"] }));
    const nomeDoArquivo = `${p.referencia.replace(/[^A-Za-z0-9-]/g, "").slice(0, 60) || "contrato"}.pdf`;
    form.append("arquivo", new Blob([new Uint8Array(p.pdf)], { type: "application/pdf" }), nomeDoArquivo);
    return form;
  }

  return {
    id: "autentique",
    cadastroDoAviso: "no_painel",

    async testarConexao() {
      const d = await chamar(consulta("query { me { id } }"));
      if (!d.me || typeof d.me !== "object") {
        throw new ErroDoServico("credencial_invalida", FRASE_DO_ERRO.credencial_invalida);
      }
    },

    async criarPedido(p: PedidoDeAssinatura): Promise<PedidoCriado> {
      let d: Record<string, unknown>;
      try {
        d = await chamar(corpoDoPedido(p, true));
      } catch (err) {
        // O prazo de assinatura pode ser recurso de plano na Autentique:
        // recusado o PRAZO, tenta uma vez sem ele (o prazo fica sem efeito lá, e
        // o contrato segue no CRM). Qualquer outro erro sobe como veio.
        if (!(err instanceof ErroDoServico) || err.message !== FRASE_DO_PRAZO_RECUSADO) throw err;
        d = await chamar(corpoDoPedido(p, false));
      }
      const doc = (d.createDocument ?? null) as { id?: unknown; signatures?: unknown } | null;
      const documentoId = texto(doc?.id);
      if (!documentoId || !ID_SEGURO.test(documentoId)) {
        throw new ErroDoServico("resposta_inesperada", "A Autentique criou o pedido sem devolver o documento.");
      }
      const assinatura = assinaturaDoSignatario(doc?.signatures, p.signatario.nome);
      // O link vem do serviço, nunca montado aqui. Sem link na criação, pede um.
      let link = texto(assinatura?.link?.short_link);
      const publicId = texto(assinatura?.public_id);
      if (!link && publicId && ID_SEGURO.test(publicId)) {
        const r = await chamar(consulta(`mutation { createLinkToSignature(public_id: "${publicId}") { short_link } }`));
        link = texto((r.createLinkToSignature as { short_link?: unknown } | null)?.short_link);
      }
      if (!link || !link.startsWith("https://")) {
        // Sem link o cliente não assina: o documento órfão sai da Autentique
        // (melhor esforço) para não ficar contando no plano nem confundindo a equipe.
        await chamar(consulta(`mutation { deleteDocument(id: "${documentoId}") }`)).catch(() => null);
        throw new ErroDoServico("resposta_inesperada", "A Autentique criou o pedido sem devolver o link de assinatura.");
      }
      return { documentoId, linkAssinatura: link };
    },

    async consultar(documentoId: string): Promise<SituacaoNoServico> {
      const id = idSeguro(documentoId);
      const d = await chamar(
        consulta(`query {
  document(id: "${id}") {
    id
    deadline_at
    files { signed }
    signatures {
      public_id
      action { name }
      viewed { created_at }
      signed { created_at }
      rejected { created_at reason }
    }
  }
}`),
      );
      const doc = d.document;
      // Documento que não volta NÃO vira "cancelado": cancelado é final, e um
      // sumiço passageiro (conta trocada de organização na Autentique) faria o
      // CRM perder uma assinatura que chegasse depois. Quem cancela é a equipe.
      if (doc === null) throw new ErroDoServico("nao_encontrado", FRASE_DO_ERRO.nao_encontrado);
      if (!doc || typeof doc !== "object") {
        throw new ErroDoServico("resposta_inesperada", "A Autentique não devolveu o documento.");
      }
      return situacaoDaAutentique(doc as DocumentoDaAutentique);
    },

    async cancelar(documentoId: string) {
      const id = idSeguro(documentoId);
      try {
        await chamar(consulta(`mutation { deleteDocument(id: "${id}") }`));
      } catch (err) {
        // Já apagado pela tela deles: não é erro.
        if (err instanceof ErroDoServico && err.codigo === "nao_encontrado") return;
        throw err;
      }
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
      // O token da API só vai para a própria Autentique: o arquivo assinado mora
      // num endereço dela que pede autenticação. Endereço de outro domínio é
      // baixado sem credencial (pré-assinado) — nunca com o token.
      const daAutentique = u.hostname === "autentique.com.br" || u.hostname.endsWith(".autentique.com.br");
      let resposta: Response;
      try {
        resposta = await busca(u.toString(), {
          ...(daAutentique ? { headers: { Authorization: `Bearer ${cred.chave}` } } : {}),
          signal: AbortSignal.timeout(PRAZO_DA_CHAMADA_MS),
          // Seguir redirecionamento levaria o cabeçalho junto para outro lugar.
          redirect: daAutentique ? "manual" : "follow",
        });
        if (daAutentique && resposta.status >= 300 && resposta.status < 400) {
          const destino = resposta.headers.get("location");
          if (!destino) throw new Error("sem destino");
          const proximo = new URL(destino, u);
          if (proximo.protocol !== "https:") throw new Error("sem https");
          // O destino do redirecionamento é pré-assinado: vai sem o token.
          resposta = await busca(proximo.toString(), { signal: AbortSignal.timeout(PRAZO_DA_CHAMADA_MS), redirect: "follow" });
        }
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

    // O aviso da Autentique é cadastrado no PAINEL dela (`cadastroDoAviso`):
    // não há rota da API para isso. Quem chama não deve pedir; se pedir, nada
    // muda no serviço.
    async registrarAviso() {
      return { avisoId: null };
    },

    async removerAviso() {
      // Idem: o endpoint antigo, se houver, sai pelo painel da Autentique.
    },
  };
}
