/**
 * PC-030 — o adaptador da ZapSign contra um servidor de mentira que confere o
 * que a documentação pede (caminho, método, autenticação, corpo). Criar,
 * consultar, aviso de assinado e de recusado, expiração, cancelamento, o
 * download do assinado e o cadastro do aviso com o segredo no cabeçalho.
 */
import { describe, expect, it, vi } from "vitest";

import { ErroDoServico } from "./servico";
import { BASE_DA_ZAPSIGN, criarServicoZapsign, lerAvisoDaZapsign, situacaoDaZapsign } from "./zapsign";

type Chamada = { url: string; init?: RequestInit };

function servidor(respostas: Array<{ status: number; corpo?: unknown; bytes?: Buffer }>) {
  const chamadas: Chamada[] = [];
  const busca = vi.fn(async (url: string, init?: RequestInit) => {
    chamadas.push({ url, init });
    const r = respostas.shift() ?? { status: 500 };
    if (r.bytes) return new Response(new Uint8Array(r.bytes), { status: r.status });
    return new Response(r.corpo === undefined ? null : JSON.stringify(r.corpo), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { busca, chamadas };
}

const PEDIDO = {
  pdf: Buffer.from("%PDF-1.4 contrato"),
  nomeDoDocumento: "Contrato de honorários — Maria",
  signatario: { nome: "Maria da Silva", telefone: "5531998761234", cpf: "52998224725", email: null },
  prazo: "2026-11-17",
  referencia: "contrato-1",
};

describe("ZapSign — criar o pedido", () => {
  it("manda o PDF em base64, o signatário travado e sem envio automático; devolve documento e link", async () => {
    const s = servidor([
      {
        status: 200,
        corpo: {
          token: "doc-tok-123456",
          status: "pending",
          signers: [{ token: "sig-tok-abcdef", sign_url: "https://app.zapsign.co/verificar/sig-tok-abcdef" }],
        },
      },
    ]);
    const z = criarServicoZapsign({ chave: "chave-secreta-xyz", ambiente: "teste" }, s.busca);
    const r = await z.criarPedido(PEDIDO);

    expect(r).toEqual({ documentoId: "doc-tok-123456", linkAssinatura: "https://app.zapsign.co/verificar/sig-tok-abcdef" });
    const c = s.chamadas[0]!;
    expect(c.url).toBe(`${BASE_DA_ZAPSIGN.teste}/api/v1/docs/`);
    expect(c.init?.method).toBe("POST");
    expect((c.init?.headers as Record<string, string>).Authorization).toBe("Bearer chave-secreta-xyz");
    const corpo = JSON.parse(String(c.init?.body)) as Record<string, unknown>;
    expect(corpo.base64_pdf).toBe(PEDIDO.pdf.toString("base64"));
    expect(corpo.external_id).toBe("contrato-1");
    expect(corpo.date_limit_to_sign).toBe("2026-11-17");
    expect(corpo.disable_signer_emails).toBe(true);
    const [signatario] = corpo.signers as Array<Record<string, unknown>>;
    expect(signatario).toMatchObject({
      name: "Maria da Silva",
      phone_country: "55",
      phone_number: "31998761234",
      send_automatic_whatsapp: false,
      send_automatic_email: false,
      lock_name: true,
      lock_phone: true,
      cpf: "52998224725",
      require_cpf: true,
    });
    expect(signatario).not.toHaveProperty("email");
  });

  it("sem sign_url, recusa em vez de montar o link à mão", async () => {
    const s = servidor([{ status: 200, corpo: { token: "doc-tok-123456", signers: [{ token: "sig-tok-abcdef" }] } }]);
    await expect(
      criarServicoZapsign({ chave: "k-12345678", ambiente: "producao" }, s.busca).criarPedido(PEDIDO),
    ).rejects.toMatchObject({ codigo: "resposta_inesperada" });
    expect(s.chamadas[0]!.url.startsWith(BASE_DA_ZAPSIGN.producao)).toBe(true);
  });

  it.each([
    [401, "credencial_invalida"],
    [403, "credencial_invalida"],
    [400, "dado_recusado"],
    [402, "dado_recusado"],
    [500, "servico_fora"],
    [503, "servico_fora"],
  ])("HTTP %i vira %s — e o erro não ecoa a chave", async (status, codigo) => {
    const s = servidor([{ status, corpo: { detail: "chave-secreta-xyz recusada" } }]);
    const z = criarServicoZapsign({ chave: "chave-secreta-xyz", ambiente: "teste" }, s.busca);
    const erro = await z.criarPedido(PEDIDO).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroDoServico);
    expect((erro as ErroDoServico).codigo).toBe(codigo);
    expect((erro as ErroDoServico).message).not.toContain("chave-secreta-xyz");
  });

  it("rede fora vira servico_fora", async () => {
    const busca = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const erro = await criarServicoZapsign({ chave: "k-12345678", ambiente: "teste" }, busca)
      .criarPedido(PEDIDO)
      .catch((e: unknown) => e);
    expect((erro as ErroDoServico).codigo).toBe("servico_fora");
  });
});

describe("ZapSign — consultar a situação", () => {
  const agora = new Date("2026-11-10T15:00:00Z");

  it.each([
    [{ status: "pending", signers: [{ status: "new", times_viewed: 0 }] }, "enviado"],
    [{ status: "em-curso", signers: [{ status: "abriu-link", times_viewed: 1, last_view_at: "2026-11-10T14:00:00Z" }] }, "visualizado"],
    [{ status: "pending", signers: [{ status: "link-opened", times_viewed: 2 }] }, "visualizado"],
    [{ status: "signed", signers: [{ status: "signed", signed_at: "2026-11-10T14:30:00Z" }] }, "assinado"],
    [{ status: "assinado", signers: [{ status: "assinou" }] }, "assinado"],
    [{ status: "refused", rejected_reason: "Não concordo com o valor" }, "recusado"],
    [{ status: "recusado" }, "recusado"],
    [{ status: "pending", date_limit_to_sign: "2026-11-09T00:00:00Z", signers: [{ status: "new" }] }, "expirado"],
    [{ status: "pending", deleted: true }, "cancelado"],
  ])("%j → %s", (doc, estado) => {
    expect(situacaoDaZapsign(doc, agora).estado).toBe(estado);
  });

  it("assinado traz a data e o endereço temporário do PDF; recusado traz o motivo", () => {
    const a = situacaoDaZapsign(
      { status: "signed", signed_file: "https://zapsign.s3.amazonaws.com/x.pdf", signers: [{ signed_at: "2026-11-10T14:30:00Z" }] },
      agora,
    );
    expect(a.assinadoEm).toBe("2026-11-10T14:30:00Z");
    expect(a.arquivoAssinadoUrl).toBe("https://zapsign.s3.amazonaws.com/x.pdf");
    expect(situacaoDaZapsign({ status: "refused", rejected_reason: " Dado errado " }, agora).motivoRecusa).toBe("Dado errado");
  });

  it("consulta pelo GET do documento, com a credencial", async () => {
    const s = servidor([{ status: 200, corpo: { status: "signed", signers: [{ status: "signed" }] } }]);
    const r = await criarServicoZapsign({ chave: "k-12345678", ambiente: "teste" }, s.busca).consultar("doc-tok-123456");
    expect(r.estado).toBe("assinado");
    expect(s.chamadas[0]!.url).toBe(`${BASE_DA_ZAPSIGN.teste}/api/v1/docs/doc-tok-123456/`);
    expect(s.chamadas[0]!.init?.method).toBe("GET");
  });

  it("id de documento com caractere estranho nem sai para a rede", async () => {
    const s = servidor([]);
    const erro = await criarServicoZapsign({ chave: "k-12345678", ambiente: "teste" }, s.busca)
      .consultar("../../user/company")
      .catch((e: unknown) => e);
    expect((erro as ErroDoServico).codigo).toBe("nao_encontrado");
    expect(s.busca).not.toHaveBeenCalled();
  });
});

describe("ZapSign — o aviso (webhook)", () => {
  it("lê só o documento e o evento: assinado e recusado", () => {
    expect(lerAvisoDaZapsign({ event_type: "doc_signed", token: "doc-tok-123456", status: "signed" })).toEqual({
      documentoId: "doc-tok-123456",
      evento: "doc_signed",
    });
    expect(lerAvisoDaZapsign({ event_type: "doc_refused", token: "doc-tok-123456", status: "recusado" })).toEqual({
      documentoId: "doc-tok-123456",
      evento: "doc_refused",
    });
  });

  it.each([null, "texto", [], {}, { event_type: "doc_signed" }, { token: "doc-tok-123456" }, { event_type: "x", token: "a/b" }])(
    "corpo sem documento ou evento é ignorado (%j)",
    (corpo) => {
      expect(lerAvisoDaZapsign(corpo)).toBeNull();
    },
  );

  it("cadastra o aviso com o segredo NUM CABEÇALHO e devolve o id; remove o antigo pelo id", async () => {
    const s = servidor([{ status: 200, corpo: { id: 77 } }, { status: 200, corpo: {} }]);
    const z = criarServicoZapsign({ chave: "k-12345678", ambiente: "producao" }, s.busca);
    const r = await z.registrarAviso({
      url: "https://crm.exemplo.com.br/api/v1/webhooks/assinatura/tok",
      cabecalho: "x-assinatura-segredo",
      segredo: "seg-123",
    });
    expect(r).toEqual({ avisoId: "77" });
    const corpo = JSON.parse(String(s.chamadas[0]!.init?.body)) as Record<string, unknown>;
    expect(s.chamadas[0]!.url).toBe(`${BASE_DA_ZAPSIGN.producao}/api/v1/user/company/webhook/`);
    expect(corpo).toEqual({
      url: "https://crm.exemplo.com.br/api/v1/webhooks/assinatura/tok",
      type: "",
      headers: [{ name: "x-assinatura-segredo", value: "seg-123" }],
    });
    await z.removerAviso("77");
    expect(s.chamadas[1]!.init?.method).toBe("DELETE");
    expect(s.chamadas[1]!.url).toBe(`${BASE_DA_ZAPSIGN.producao}/api/v1/user/company/webhook/delete/`);
    expect(JSON.parse(String(s.chamadas[1]!.init?.body))).toEqual({ id: "77" });
  });
});

describe("ZapSign — cancelar e baixar o assinado", () => {
  it("cancelar é o DELETE do documento", async () => {
    const s = servidor([{ status: 200, corpo: {} }]);
    await criarServicoZapsign({ chave: "k-12345678", ambiente: "teste" }, s.busca).cancelar("doc-tok-123456");
    expect(s.chamadas[0]!.init?.method).toBe("DELETE");
    expect(s.chamadas[0]!.url).toBe(`${BASE_DA_ZAPSIGN.teste}/api/v1/docs/doc-tok-123456/`);
  });

  it("baixa o PDF assinado sem mandar a credencial, e recusa o que não é PDF", async () => {
    const pdf = Buffer.from("%PDF-1.7 assinado");
    const s = servidor([{ status: 200, bytes: pdf }, { status: 200, bytes: Buffer.from("<html>") }]);
    const z = criarServicoZapsign({ chave: "k-12345678", ambiente: "teste" }, s.busca);
    await expect(z.baixarAssinado("https://zapsign.s3.amazonaws.com/x.pdf")).resolves.toEqual(pdf);
    expect(s.chamadas[0]!.init?.headers).toBeUndefined();
    const erro = await z.baixarAssinado("https://zapsign.s3.amazonaws.com/y.pdf").catch((e: unknown) => e);
    expect((erro as ErroDoServico).codigo).toBe("resposta_inesperada");
  });

  it("endereço sem https não é baixado", async () => {
    const s = servidor([]);
    const erro = await criarServicoZapsign({ chave: "k-12345678", ambiente: "teste" }, s.busca)
      .baixarAssinado("http://169.254.169.254/latest")
      .catch((e: unknown) => e);
    expect((erro as ErroDoServico).codigo).toBe("resposta_inesperada");
    expect(s.busca).not.toHaveBeenCalled();
  });
});
