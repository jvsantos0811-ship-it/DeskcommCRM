import { describe, expect, it } from "vitest";

import { HEADER_DO_SEGREDO, idExternoDaEntrada, lerEntrada, phoneIdDoCorpo, segredoConfere } from "./entrada";
import { linkExternoDaConversa } from "./link";

/**
 * O POST da plataforma de atendimento (PC-047). Os valores abaixo são de
 * mentira — nenhum telefone, nome ou texto de cliente real entra em teste.
 */
const SEGREDO = "a".repeat(64);

function corpo(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    nome: "Pessoa Teste",
    celular: "5500900000001",
    chat_id: "chat-teste-1",
    phone_id: "fone-teste-1",
    tipo_mensagem: "chat",
    texto_mensagem: "Olá, quero saber do meu caso",
    datetime_post: "2026-11-22 08:54:00",
    link_chat: "https://s7.chatguru.app/chats#chat-teste-1",
    ...extra,
  });
}

describe("segredo da entrada", () => {
  it("só aceita o segredo exato, no cabeçalho", () => {
    expect(segredoConfere(new Headers({ [HEADER_DO_SEGREDO]: SEGREDO }), SEGREDO)).toBe(true);
    expect(segredoConfere(new Headers({ [HEADER_DO_SEGREDO]: `${SEGREDO}x` }), SEGREDO)).toBe(false);
    expect(segredoConfere(new Headers({ [HEADER_DO_SEGREDO]: "b".repeat(64) }), SEGREDO)).toBe(false);
    expect(segredoConfere(new Headers(), SEGREDO)).toBe(false);
  });

  it("falha FECHADA sem segredo gravado ou com segredo curto demais", () => {
    expect(segredoConfere(new Headers({ [HEADER_DO_SEGREDO]: "curto" }), "curto")).toBe(false);
    expect(segredoConfere(new Headers({ [HEADER_DO_SEGREDO]: SEGREDO }), null)).toBe(false);
  });
});

describe("leitura do POST", () => {
  it("lê o JSON e normaliza o número em dígitos", () => {
    const r = lerEntrada(corpo({ celular: "+55 (00) 90000-0001" }));
    expect(r.ok && "entrada" in r ? r.entrada.celular : null).toBe("5500900000001");
    if (r.ok && "entrada" in r) {
      expect(r.entrada.tipo).toBe("text");
      expect(r.entrada.texto).toBe("Olá, quero saber do meu caso");
      expect(r.entrada.linkChat).toBe("https://s7.chatguru.app/chats#chat-teste-1");
    }
  });

  it("lê também o corpo em formulário", () => {
    const form = new URLSearchParams({ celular: "5500900000001", texto_mensagem: "oi" }).toString();
    const r = lerEntrada(form);
    expect(r.ok && "entrada" in r ? r.entrada.texto : null).toBe("oi");
  });

  it("aceita número em vez de texto no campo do celular", () => {
    const r = lerEntrada(JSON.stringify({ celular: 5500900000001, texto_mensagem: "oi" }));
    expect(r.ok && "entrada" in r ? r.entrada.celular : null).toBe("5500900000001");
  });

  it("recusa com o NOME do campo quando falta o indispensável — nunca com o valor", () => {
    const r = lerEntrada(JSON.stringify({ nome: "x" }));
    expect(r).toEqual({ ok: false, motivo: "contrato_violado", campos: ["celular", "texto_mensagem"] });
    expect(lerEntrada("nada disso")).toEqual({ ok: false, motivo: "json_invalido" });
  });

  it("grupo e endereço que não é telefone não viram lead", () => {
    const grupo = lerEntrada(corpo({ celular: "120363000000000000@g.us" }));
    expect(grupo).toEqual({ ok: true, ignorar: "grupo_ou_endereco_nao_suportado" });
    const longo = lerEntrada(corpo({ celular: "1203630000000000001" }));
    expect(longo).toEqual({ ok: true, ignorar: "grupo_ou_endereco_nao_suportado" });
    const curto = lerEntrada(corpo({ celular: "1234" }));
    expect(curto).toEqual({ ok: true, ignorar: "numero_fora_do_formato" });
  });

  it("mídia com link https vira mídia; sem link vira o texto que veio", () => {
    const audio = lerEntrada(corpo({ tipo_mensagem: "ptt", texto_mensagem: "https://arquivos.exemplo.com.br/a.ogg" }));
    if (!audio.ok || !("entrada" in audio)) throw new Error("devia ler");
    expect(audio.entrada.tipo).toBe("audio");
    expect(audio.entrada.midiaUrl).toBe("https://arquivos.exemplo.com.br/a.ogg");

    const semLink = lerEntrada(corpo({ tipo_mensagem: "image", texto_mensagem: "foto do laudo" }));
    if (!semLink.ok || !("entrada" in semLink)) throw new Error("devia ler");
    expect(semLink.entrada.tipo).toBe("text");
    expect(semLink.entrada.texto).toBe("foto do laudo");
  });

  it("link do chat fora do domínio da plataforma não entra", () => {
    const r = lerEntrada(corpo({ link_chat: "https://outro-site.exemplo.com/chats" }));
    expect(r.ok && "entrada" in r ? r.entrada.linkChat : "x").toBeNull();
    const http = lerEntrada(corpo({ link_chat: "http://s7.chatguru.app/chats" }));
    expect(http.ok && "entrada" in http ? http.entrada.linkChat : "x").toBeNull();
  });

  it("phone_id do corpo é lido sem validar o resto (guarda de conta)", () => {
    expect(phoneIdDoCorpo(corpo())).toBe("fone-teste-1");
    expect(phoneIdDoCorpo("{}")).toBeNull();
  });
});

describe("id externo — a reentrega não duplica", () => {
  it("o mesmo POST dá o mesmo id; outra mensagem dá outro", () => {
    const a = lerEntrada(corpo());
    const b = lerEntrada(corpo());
    const c = lerEntrada(corpo({ texto_mensagem: "outra coisa" }));
    if (!a.ok || !("entrada" in a) || !b.ok || !("entrada" in b) || !c.ok || !("entrada" in c)) throw new Error("devia ler");
    expect(idExternoDaEntrada(a.entrada)).toBe(idExternoDaEntrada(b.entrada));
    expect(idExternoDaEntrada(a.entrada)).not.toBe(idExternoDaEntrada(c.entrada));
    expect(idExternoDaEntrada(a.entrada)).toMatch(/^ext_[0-9a-f]{40}$/);
  });

  it("sem carimbo do POST, o minuto de chegada separa a mesma frase dita depois", () => {
    const r = lerEntrada(corpo({ datetime_post: undefined }));
    if (!r.ok || !("entrada" in r)) throw new Error("devia ler");
    const t0 = new Date("2026-11-22T11:00:10Z");
    const t1 = new Date("2026-11-22T11:00:50Z");
    const t2 = new Date("2026-11-22T11:05:00Z");
    expect(idExternoDaEntrada(r.entrada, t0)).toBe(idExternoDaEntrada(r.entrada, t1));
    expect(idExternoDaEntrada(r.entrada, t0)).not.toBe(idExternoDaEntrada(r.entrada, t2));
  });
});

describe("link na conversa (o que a Inbox lê)", () => {
  it("só devolve link conferido", () => {
    expect(linkExternoDaConversa({ link_externo: "https://s7.chatguru.app/chats#x" })).toBe("https://s7.chatguru.app/chats#x");
    expect(linkExternoDaConversa({ link_externo: "javascript:alert(1)" })).toBeNull();
    expect(linkExternoDaConversa({ link_externo: "https://chatguru.app.exemplo.com/x" })).toBeNull();
    expect(linkExternoDaConversa(null)).toBeNull();
    expect(linkExternoDaConversa({})).toBeNull();
  });
});
