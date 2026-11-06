/**
 * A regra da mensagem automática do celular (PM-027 §6) com os números que o
 * Gestor mediu na Bórbora (60 dias, `external_device`).
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Baixar a proporção para 30%: "Ok" e "Boa tarde" viram automáticos e acusam.
 * - Exigir 2 conversas: o texto de 2 conversas entra e acusa.
 * - Tirar o "[Unsupported message]" da regra: o último caso acusa.
 */
import { describe, expect, it } from "vitest";

import { ehMensagemAutomatica, normalizarTexto, textosAutomaticos, type ContagemDoTexto } from "./textos-automaticos";

const SAUDACAO = "Olá! Sou do escritório Bórbora Advogados Associados. Como posso te chamar?";
const MENU = "Perfeito! Você quer saber mais sobre: Auxílio Acidente, BPC/Loas, Auxílio Doença";
const DOCS = "Me manda seu Documento pessoal Comprovante de endereço";
const linha = (texto: string, conversas: number, pct: number): ContagemDoTexto => ({
  texto: normalizarTexto(texto),
  conversas,
  vezes: 100,
  no_prazo: pct,
});

describe("textosAutomaticos", () => {
  const automaticos = textosAutomaticos([
    linha(SAUDACAO, 43, 95),
    linha(MENU, 4, 100),
    linha("[Unsupported message]", 60, 80),
    linha("Ok", 30, 39),
    linha("Boa tarde", 14, 41),
    linha("Só um momento", 14, 38),
    linha(DOCS, 29, 24),
    linha("Texto em só duas conversas", 2, 100),
  ]);

  it("pega a saudação, o menu do robô e o conteúdo não importado (80% conta)", () => {
    for (const t of [SAUDACAO, MENU, "[Unsupported message]"]) expect(automaticos.has(normalizarTexto(t))).toBe(true);
  });

  it("não pega as frases de pessoa repetidas, nem texto de menos de 3 conversas", () => {
    for (const t of ["Ok", "Boa tarde", "Só um momento", DOCS, "Texto em só duas conversas"]) {
      expect(automaticos.has(normalizarTexto(t))).toBe(false);
    }
  });

  it("o texto vale com espaços e maiúsculas diferentes; só a saída do celular é marcada", () => {
    const m = (body: string, sent_via = "external_device", direction = "outbound") => ({ body, sent_via, direction });
    expect(ehMensagemAutomatica(m(`  ${SAUDACAO.toUpperCase()}\n`), automaticos)).toBe(true);
    expect(ehMensagemAutomatica(m("Ok"), automaticos)).toBe(false);
    expect(ehMensagemAutomatica(m(SAUDACAO, "user"), automaticos)).toBe(false);
    expect(ehMensagemAutomatica(m(SAUDACAO, "external_device", "inbound"), automaticos)).toBe(false);
  });

  it("\"[Unsupported message]\" nunca é pessoa, mesmo sem contagem nenhuma", () => {
    expect(ehMensagemAutomatica({ direction: "outbound", sent_via: "external_device", body: "[Unsupported message]" }, textosAutomaticos([]))).toBe(true);
  });
});
