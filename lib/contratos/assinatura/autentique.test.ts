/**
 * PC-046 — o adaptador da Autentique contra um servidor de mentira que confere
 * o que a documentação pede: um endereço GraphQL só, o token no Bearer, o
 * multipart do `createDocument` (operations + map + arquivo), o `sandbox` no
 * teste, o signatário só com o nome (a Autentique não manda nada sozinha), o
 * erro dentro do HTTP 200, a situação relida, o aviso e a assinatura HMAC dele.
 */
import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  assinaturaDoAvisoConfere,
  codigoDoErroDaAutentique,
  criarServicoAutentique,
  dataDaAutentique,
  ENDERECO_DA_AUTENTIQUE,
  lerAvisoDaAutentique,
  prazoDaAutentique,
  situacaoDaAutentique,
} from "./autentique";

type Chamada = { url: string; init?: RequestInit };
type Resposta = { status: number; corpo?: unknown; bytes?: Buffer; headers?: Record<string, string> };

function servidor(respostas: Resposta[]) {
  const chamadas: Chamada[] = [];
  const busca = vi.fn(async (url: string, init?: RequestInit) => {
    chamadas.push({ url, init });
    const r = respostas.shift() ?? { status: 500 };
    if (r.bytes) return new Response(new Uint8Array(r.bytes), { status: r.status, headers: r.headers });
    return new Response(r.corpo === undefined ? null : JSON.stringify(r.corpo), {
      status: r.status,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  });
  return { busca, chamadas };
}

const PEDIDO = {
  pdf: Buffer.from("%PDF-1.4 contrato"),
  nomeDoDocumento: "Contrato de honorários — Maria",
  signatario: { nome: "Maria da Silva", telefone: "5531998761234", cpf: "52998224725", email: null },
  prazo: "2026-11-29",
  referencia: "contrato-1",
};

const CRIADO = {
  data: {
    createDocument: {
      id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5",
      signatures: [
        { public_id: "pub-dono-0001", name: "Escritório", action: null, link: null },
        {
          public_id: "pub-maria-0001",
          name: "Maria da Silva",
          action: { name: "SIGN" },
          link: { short_link: "https://assina.ae/abc123" },
        },
      ],
    },
  },
};

async function partesDoMultipart(init?: RequestInit) {
  const corpo = init?.body;
  expect(corpo).toBeInstanceOf(FormData);
  const form = corpo as FormData;
  const operations = JSON.parse(String(form.get("operations"))) as {
    query: string;
    variables: { document: Record<string, unknown>; signers: Array<Record<string, unknown>>; file: unknown };
  };
  const map = JSON.parse(String(form.get("map"))) as Record<string, string[]>;
  const arquivo = form.get(Object.keys(map)[0]!) as Blob;
  return { operations, map, arquivo };
}

describe("Autentique — criar o pedido", () => {
  it("manda o multipart do GraphQL com sandbox no teste, só o nome do signatário e o prazo; devolve documento e link", async () => {
    const s = servidor([{ status: 200, corpo: CRIADO }]);
    const a = criarServicoAutentique({ chave: "token-secreto-xyz", ambiente: "teste" }, s.busca);
    const r = await a.criarPedido(PEDIDO);

    expect(r).toEqual({ documentoId: CRIADO.data.createDocument.id, linkAssinatura: "https://assina.ae/abc123" });
    const c = s.chamadas[0]!;
    expect(c.url).toBe(ENDERECO_DA_AUTENTIQUE);
    expect(c.init?.method).toBe("POST");
    const cabecalhos = c.init?.headers as Record<string, string>;
    expect(cabecalhos.Authorization).toBe("Bearer token-secreto-xyz");
    // O multipart leva o boundary no Content-Type que o fetch monta: não pode ser fixado aqui.
    expect(cabecalhos["Content-Type"]).toBeUndefined();

    const { operations, map, arquivo } = await partesDoMultipart(c.init);
    expect(operations.query).toContain("createDocument(sandbox: true, document: $document, signers: $signers, file: $file)");
    expect(operations.variables.file).toBeNull();
    expect(Object.values(map)).toEqual([["variables.file"]]);
    expect(Buffer.from(await arquivo.arrayBuffer()).toString("latin1")).toBe("%PDF-1.4 contrato");
    expect(arquivo.type).toBe("application/pdf");
    expect(operations.variables.document).toEqual({
      name: "Contrato de honorários — Maria",
      refusable: true,
      deadline_at: "2026-11-30T02:59:59.999Z",
    });
    // Só o nome: sem e-mail, telefone ou forma de entrega, a Autentique não manda nada sozinha.
    expect(operations.variables.signers).toEqual([{ name: "Maria da Silva", action: "SIGN" }]);
  });

  it("em produção não manda o sandbox", async () => {
    const s = servidor([{ status: 200, corpo: CRIADO }]);
    await criarServicoAutentique({ chave: "token-12345678", ambiente: "producao" }, s.busca).criarPedido(PEDIDO);
    const { operations } = await partesDoMultipart(s.chamadas[0]!.init);
    expect(operations.query).not.toContain("sandbox");
    expect(operations.query).toContain("createDocument(document: $document");
  });

  it("sem link na criação, pede o link da assinatura do signatário (nunca monta à mão)", async () => {
    const semLink = structuredClone(CRIADO);
    semLink.data.createDocument.signatures[1]!.link = null;
    const s = servidor([
      { status: 200, corpo: semLink },
      { status: 200, corpo: { data: { createLinkToSignature: { short_link: "https://assina.ae/novo456" } } } },
    ]);
    const r = await criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca).criarPedido(PEDIDO);
    expect(r.linkAssinatura).toBe("https://assina.ae/novo456");
    const corpo = JSON.parse(String(s.chamadas[1]!.init?.body)) as { query: string };
    expect(corpo.query).toContain('createLinkToSignature(public_id: "pub-maria-0001")');
  });

  it("prazo recusado pelo plano da conta: tenta uma vez sem o prazo", async () => {
    const s = servidor([
      { status: 200, corpo: { errors: [{ message: "The deadline_at feature requires a corporate plan" }], data: null } },
      { status: 200, corpo: CRIADO },
    ]);
    const r = await criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca).criarPedido(PEDIDO);
    expect(r.documentoId).toBe(CRIADO.data.createDocument.id);
    expect(s.chamadas).toHaveLength(2);
    const segunda = await partesDoMultipart(s.chamadas[1]!.init);
    expect(segunda.operations.variables.document).not.toHaveProperty("deadline_at");
  });

  it("aviso do prazo COM o documento criado: segue com ele, sem segunda tentativa (nada duplicado)", async () => {
    const s = servidor([
      { status: 200, corpo: { errors: [{ message: "Campo prazo ignorado no seu plano" }], data: CRIADO.data } },
    ]);
    const r = await criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca).criarPedido(PEDIDO);
    expect(r.documentoId).toBe(CRIADO.data.createDocument.id);
    expect(s.chamadas).toHaveLength(1);
  });

  it("outro dado recusado NÃO é tentado de novo", async () => {
    const s = servidor([{ status: 200, corpo: { errors: [{ message: "Insufficient credits" }], data: null } }]);
    await expect(
      criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca).criarPedido(PEDIDO),
    ).rejects.toMatchObject({ codigo: "dado_recusado" });
    expect(s.chamadas).toHaveLength(1);
  });

  it("sem link de volta, recusa e apaga o documento órfão (melhor esforço)", async () => {
    const s = servidor([
      { status: 200, corpo: { data: { createDocument: { id: "a1b2c3d4e5f6", signatures: [] } } } },
      { status: 200, corpo: { data: { deleteDocument: true } } },
    ]);
    await expect(
      criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca).criarPedido(PEDIDO),
    ).rejects.toMatchObject({ codigo: "resposta_inesperada" });
    expect(JSON.parse(String(s.chamadas[1]!.init?.body)).query).toContain('deleteDocument(id: "a1b2c3d4e5f6")');
  });

  it("sem documento de volta, recusa", async () => {
    const s = servidor([{ status: 200, corpo: { data: { createDocument: { signatures: [] } } } }]);
    await expect(
      criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca).criarPedido(PEDIDO),
    ).rejects.toMatchObject({ codigo: "resposta_inesperada" });
    expect(s.chamadas).toHaveLength(1);
  });

  it("erro do GraphQL dentro do HTTP 200 vira o código certo, sem ecoar o corpo", async () => {
    const s = servidor([{ status: 200, corpo: { errors: [{ message: "Unauthenticated. Maria da Silva" }] } }]);
    const err = await criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca)
      .criarPedido(PEDIDO)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ codigo: "credencial_invalida" });
    expect(String((err as Error).message)).not.toContain("Maria");
  });

  it("rede caída ou 5xx é serviço fora", async () => {
    const caiu = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(
      criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, caiu).criarPedido(PEDIDO),
    ).rejects.toMatchObject({ codigo: "servico_fora" });
    const s = servidor([{ status: 502 }]);
    await expect(
      criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca).criarPedido(PEDIDO),
    ).rejects.toMatchObject({ codigo: "servico_fora" });
  });
});

describe("Autentique — testar, consultar, cancelar", () => {
  it("testar conexão lê `me`; sem usuário, a chave é recusada", async () => {
    const ok = servidor([{ status: 200, corpo: { data: { me: { id: "u-1" } } } }]);
    await criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, ok.busca).testarConexao();
    expect(JSON.parse(String(ok.chamadas[0]!.init?.body))).toEqual({ query: "query { me { id } }" });

    const semUsuario = servidor([{ status: 200, corpo: { data: { me: null } } }]);
    await expect(
      criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, semUsuario.busca).testarConexao(),
    ).rejects.toMatchObject({ codigo: "credencial_invalida" });

    const recusada = servidor([{ status: 401 }]);
    await expect(
      criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, recusada.busca).testarConexao(),
    ).rejects.toMatchObject({ codigo: "credencial_invalida" });
  });

  it("consultar relê a situação pela query `document`", async () => {
    const s = servidor([
      {
        status: 200,
        corpo: {
          data: {
            document: {
              id: "doc-0000-aaaa",
              deadline_at: null,
              files: { signed: "https://api.autentique.com.br/documentos/doc-0000-aaaa/assinado.pdf" },
              signatures: [
                { public_id: "p1", action: { name: "SIGN" }, viewed: { created_at: "2026-11-22 10:00:00" }, signed: { created_at: "2026-11-22 10:05:00" }, rejected: null },
              ],
            },
          },
        },
      },
    ]);
    const r = await criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca).consultar("doc-0000-aaaa");
    expect(r).toEqual({
      estado: "assinado",
      visualizadoEm: "2026-11-22T13:00:00.000Z",
      assinadoEm: "2026-11-22T13:05:00.000Z",
      motivoRecusa: null,
      arquivoAssinadoUrl: "https://api.autentique.com.br/documentos/doc-0000-aaaa/assinado.pdf",
    });
    expect(JSON.parse(String(s.chamadas[0]!.init?.body)).query).toContain('document(id: "doc-0000-aaaa")');
  });

  it("documento que não volta NÃO vira cancelado (cancelado é final): sobe como não encontrado", async () => {
    const s = servidor([{ status: 200, corpo: { data: { document: null } } }]);
    await expect(
      criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca).consultar("doc-0000-aaaa"),
    ).rejects.toMatchObject({ codigo: "nao_encontrado" });
  });

  it("id com caractere estranho nunca entra no texto da query", async () => {
    const s = servidor([]);
    await expect(
      criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca).consultar('x") { id } me { id } #'),
    ).rejects.toMatchObject({ codigo: "nao_encontrado" });
    expect(s.chamadas).toHaveLength(0);
  });

  it("cancelar apaga o documento; já apagado não é erro", async () => {
    const s = servidor([
      { status: 200, corpo: { data: { deleteDocument: true } } },
      { status: 200, corpo: { errors: [{ message: "Document not found" }] } },
    ]);
    const a = criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca);
    await a.cancelar("doc-0000-aaaa");
    await a.cancelar("doc-0000-aaaa");
    expect(JSON.parse(String(s.chamadas[0]!.init?.body)).query).toContain('deleteDocument(id: "doc-0000-aaaa")');
  });

  it("o aviso é cadastrado no painel: registrar não chama o serviço", async () => {
    const s = servidor([]);
    const a = criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca);
    expect(a.cadastroDoAviso).toBe("no_painel");
    expect(await a.registrarAviso({ url: "https://crm.exemplo.test/x", cabecalho: "x", segredo: "y" })).toEqual({ avisoId: null });
    expect(s.chamadas).toHaveLength(0);
  });
});

describe("Autentique — baixar o PDF assinado", () => {
  const PDF = Buffer.from("%PDF-1.7 assinado");

  it("o token vai só para a própria Autentique", async () => {
    const s = servidor([{ status: 200, bytes: PDF }]);
    const a = criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca);
    expect(await a.baixarAssinado("https://api.autentique.com.br/documentos/x/assinado.pdf")).toEqual(PDF);
    expect((s.chamadas[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer token-12345678");
  });

  it("endereço de outro domínio é baixado SEM o token", async () => {
    const s = servidor([{ status: 200, bytes: PDF }]);
    const a = criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca);
    await a.baixarAssinado("https://armazenamento.exemplo.test/assinado.pdf?assinatura=abc");
    expect(s.chamadas[0]!.init?.headers).toBeUndefined();
  });

  it("redirecionamento da Autentique é seguido SEM o token", async () => {
    const s = servidor([
      { status: 302, headers: { location: "https://armazenamento.exemplo.test/assinado.pdf" } },
      { status: 200, bytes: PDF },
    ]);
    const a = criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, s.busca);
    expect(await a.baixarAssinado("https://api.autentique.com.br/documentos/x/assinado.pdf")).toEqual(PDF);
    expect(s.chamadas[1]!.url).toBe("https://armazenamento.exemplo.test/assinado.pdf");
    expect(s.chamadas[1]!.init?.headers).toBeUndefined();
  });

  it("sem https ou sem cara de PDF, recusa", async () => {
    const a = criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, servidor([]).busca);
    await expect(a.baixarAssinado("http://api.autentique.com.br/x.pdf")).rejects.toMatchObject({ codigo: "resposta_inesperada" });
    const html = servidor([{ status: 200, bytes: Buffer.from("<html>login</html>") }]);
    await expect(
      criarServicoAutentique({ chave: "token-12345678", ambiente: "teste" }, html.busca).baixarAssinado(
        "https://api.autentique.com.br/x.pdf",
      ),
    ).rejects.toMatchObject({ codigo: "resposta_inesperada" });
  });
});

describe("Autentique — a situação, pura", () => {
  const agora = new Date("2026-11-22T15:00:00Z");
  const sig = (extra: Record<string, unknown>) => ({ public_id: "p1", action: { name: "SIGN" }, ...extra });

  it("enviado, visualizado, assinado, recusado e expirado", () => {
    expect(situacaoDaAutentique({ signatures: [sig({})] }, agora).estado).toBe("enviado");
    const visto = situacaoDaAutentique({ signatures: [sig({ viewed: { created_at: "2026-11-22 11:00:00" } })] }, agora);
    expect(visto).toMatchObject({ estado: "visualizado", visualizadoEm: "2026-11-22T14:00:00.000Z", arquivoAssinadoUrl: null });
    const recusado = situacaoDaAutentique(
      { signatures: [sig({ viewed: {}, rejected: { created_at: "2026-11-22 11:30:00", reason: "Valor errado" } })] },
      agora,
    );
    expect(recusado).toMatchObject({ estado: "recusado", motivoRecusa: "Valor errado" });
    expect(situacaoDaAutentique({ deadline_at: "2026-11-21T02:59:59.999Z", signatures: [sig({})] }, agora).estado).toBe(
      "expirado",
    );
    // Assinado vence o prazo vencido: o cliente assinou antes.
    expect(
      situacaoDaAutentique({ deadline_at: "2026-11-21T02:59:59.999Z", signatures: [sig({ signed: { created_at: "2026-11-20 09:00:00" } })] }, agora)
        .estado,
    ).toBe("assinado");
  });

  it("⭐ `signed` ou `rejected` vazios (sem data) NÃO viram assinado nem recusado", () => {
    expect(situacaoDaAutentique({ signatures: [sig({ signed: {}, rejected: {} })] }, agora).estado).toBe("enviado");
    expect(
      situacaoDaAutentique({ signatures: [sig({ signed: { created_at: null }, rejected: { created_at: "" } })] }, agora).estado,
    ).toBe("enviado");
    // "Visto" segue tolerante: só mostra que abriu o link.
    expect(situacaoDaAutentique({ signatures: [sig({ viewed: {} })] }, agora).estado).toBe("visualizado");
  });

  it("a assinatura do dono do documento (sem ação SIGN) não conta", () => {
    const r = situacaoDaAutentique(
      { signatures: [{ public_id: "dono", action: null, signed: { created_at: "2026-11-22 08:00:00" } }, sig({})] },
      agora,
    );
    expect(r.estado).toBe("enviado");
  });

  it("documento sem assinatura nenhuma nunca parece assinado", () => {
    expect(situacaoDaAutentique({ signatures: [] }, agora).estado).toBe("enviado");
  });

  it("datas: sem fuso é horário de Brasília; ISO passa; lixo é nulo", () => {
    expect(dataDaAutentique("2026-11-22 10:00:00")).toBe("2026-11-22T13:00:00.000Z");
    expect(dataDaAutentique("2026-11-22T10:00:00Z")).toBe("2026-11-22T10:00:00.000Z");
    expect(dataDaAutentique("2026-11-22 10:00:00.123")).toBe("2026-11-22T13:00:00.123Z");
    expect(dataDaAutentique("ontem")).toBeNull();
    expect(prazoDaAutentique("2026-11-29")).toBe("2026-11-30T02:59:59.999Z");
    expect(prazoDaAutentique("29/11/2026")).toBeNull();
  });

  it("o código do erro sai da mensagem", () => {
    expect(codigoDoErroDaAutentique("Unauthenticated.")).toBe("credencial_invalida");
    expect(codigoDoErroDaAutentique("document_not_found")).toBe("nao_encontrado");
    expect(codigoDoErroDaAutentique("Saldo insuficiente")).toBe("dado_recusado");
    expect(codigoDoErroDaAutentique("algo estranho")).toBe("resposta_inesperada");
  });
});

describe("Autentique — o aviso e a assinatura dele", () => {
  it("evento de documento: o id do documento", () => {
    expect(
      lerAvisoDaAutentique({ id: "w1", object: "webhook", event: { type: "document.finished", data: { id: "doc-0000-aaaa", object: "document" } } }),
    ).toEqual({ documentoId: "doc-0000-aaaa", evento: "document.finished" });
  });

  it("evento de assinatura: o documento a que ela pertence (objeto ou id)", () => {
    expect(
      lerAvisoDaAutentique({ event: { type: "signature.accepted", data: { id: "sig-1111", object: "signature", document: { id: "doc-0000-aaaa" } } } }),
    ).toEqual({ documentoId: "doc-0000-aaaa", evento: "signature.accepted" });
    expect(
      lerAvisoDaAutentique({ event: { type: "signature.viewed", data: { id: "sig-1111", object: "signature", document: "doc-0000-bbbb" } } }),
    ).toEqual({ documentoId: "doc-0000-bbbb", evento: "signature.viewed" });
  });

  it("formato estranho ou id perigoso: nada", () => {
    expect(lerAvisoDaAutentique(null)).toBeNull();
    expect(lerAvisoDaAutentique({ evento: "contrato.assinado" })).toBeNull();
    expect(lerAvisoDaAutentique({ event: { type: "signature.accepted", data: { id: "sig-1111" } } })).toBeNull();
    expect(lerAvisoDaAutentique({ event: { type: "document.updated", data: { id: "../../x" } } })).toBeNull();
  });

  it("HMAC SHA-256 do corpo bruto, com qualquer um dos segredos, em hex", () => {
    const corpo = '{"event":{"type":"document.finished","data":{"id":"doc-0000-aaaa"}}}';
    const assinatura = createHmac("sha256", "segredo-do-endpoint").update(corpo).digest("hex");
    expect(assinaturaDoAvisoConfere(corpo, assinatura, ["segredo-do-endpoint"])).toBe(true);
    expect(assinaturaDoAvisoConfere(Buffer.from(corpo, "utf8"), assinatura, ["segredo-do-endpoint"])).toBe(true);
    expect(assinaturaDoAvisoConfere(corpo, assinatura.toUpperCase(), [null, "segredo-do-endpoint"])).toBe(true);
    expect(assinaturaDoAvisoConfere(corpo, `sha256=${assinatura}`, ["outro", "segredo-do-endpoint"])).toBe(true);
    expect(assinaturaDoAvisoConfere(corpo, assinatura, ["outro"])).toBe(false);
    expect(assinaturaDoAvisoConfere(corpo, assinatura, [null, null])).toBe(false);
    expect(assinaturaDoAvisoConfere(corpo, null, ["segredo-do-endpoint"])).toBe(false);
    // Um byte mudado no corpo (reserializado com espaço) não confere mais.
    expect(assinaturaDoAvisoConfere(corpo.replace(":", ": "), assinatura, ["segredo-do-endpoint"])).toBe(false);
  });
});
