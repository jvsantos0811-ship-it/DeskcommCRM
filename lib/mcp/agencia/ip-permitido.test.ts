import { describe, expect, it } from "vitest";

import { ipEstaNaLista, normalizarListaDeIps } from "./ip-permitido";
import { IPS_DE_SAIDA_DA_ANTHROPIC } from "./portas";

describe("ipEstaNaLista — a chave da agência só abre vinda da lista", () => {
  const anthropic = IPS_DE_SAIDA_DA_ANTHROPIC;

  it("aceita as pontas da faixa de saída da Anthropic (160.79.104.0/21)", () => {
    expect(ipEstaNaLista("160.79.104.0", anthropic)).toBe(true);
    expect(ipEstaNaLista("160.79.111.255", anthropic)).toBe(true);
    expect(ipEstaNaLista("160.79.107.42", anthropic)).toBe(true);
  });

  it("recusa logo fora da faixa", () => {
    expect(ipEstaNaLista("160.79.103.255", anthropic)).toBe(false);
    expect(ipEstaNaLista("160.79.112.0", anthropic)).toBe(false);
    expect(ipEstaNaLista("201.17.4.9", anthropic)).toBe(false);
  });

  it("entende o IPv4 visto por socket IPv6 (::ffff:)", () => {
    expect(ipEstaNaLista("::ffff:160.79.105.1", anthropic)).toBe(true);
    expect(ipEstaNaLista("::ffff:10.0.0.1", anthropic)).toBe(false);
  });

  it("falha fechada: sem IP, IP inválido ou lista vazia recusa", () => {
    expect(ipEstaNaLista(null, anthropic)).toBe(false);
    expect(ipEstaNaLista("", anthropic)).toBe(false);
    expect(ipEstaNaLista("não-é-ip", anthropic)).toBe(false);
    expect(ipEstaNaLista("160.79.105.1", [])).toBe(false);
    expect(ipEstaNaLista("160.79.105.1", null)).toBe(false);
  });

  it("aceita IP solto e IPv6 na lista", () => {
    expect(ipEstaNaLista("203.0.113.7", ["203.0.113.7"])).toBe(true);
    expect(ipEstaNaLista("2607:6bc0::10", ["2607:6bc0::/48"])).toBe(true);
    expect(ipEstaNaLista("2607:6bc1::10", ["2607:6bc0::/48"])).toBe(false);
  });
});

describe("normalizarListaDeIps — o que a tela grava", () => {
  it("normaliza IP solto para /32 e mantém faixas", () => {
    expect(normalizarListaDeIps(["160.79.104.0/21", " 203.0.113.7 "])).toEqual({
      ok: ["160.79.104.0/21", "203.0.113.7/32"],
    });
  });

  it("recusa item inválido e lista vazia", () => {
    expect(normalizarListaDeIps(["160.79.104.0/40"])).toEqual({ invalido: "160.79.104.0/40" });
    expect(normalizarListaDeIps(["abc"])).toEqual({ invalido: "abc" });
    expect(normalizarListaDeIps(["", "  "])).toEqual({ invalido: "" });
  });
});
