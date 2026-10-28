import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A importação do histórico não passa por NENHUMA porta que acorda o produto.
 *
 * O silêncio do banco é provado em `tests/invariants/importacao-de-historico-silenciosa.test.ts`
 * (a função 9012 não deixa evento, demanda nem fila). Este arquivo guarda o lado
 * do código: os dois módulos da importação não podem importar nem chamar os
 * caminhos da ingestão que disparam IA, automação, follow-up ou contador de não
 * lidas — um "reaproveitamento" inocente de `ingestZernioInbound` desfaria tudo.
 */
const RAIZ = path.resolve(__dirname);
const ARQUIVOS = ["importar-historico.ts", "../triagem-do-historico.ts"];

const PROIBIDOS = [
  "aplicarEfeitosPosEntrada",
  "efeitosDaEntrada",
  "ingestZernioInbound",
  "marcarConversaComMensagem",
  "fn_mark_conversation_message",
  "fn_upsert_wa_conversation",
  "garantirLeadDaConversa",
  "ai_agent.dispatch_requested",
  '"lead.created"',
  "message.received",
  "sendMessageHandler",
  "pausarIaPorAtendimentoManual",
];

describe("importação do histórico: nenhuma porta que acorda o produto", () => {
  for (const arquivo of ARQUIVOS) {
    it(`${arquivo} não usa ${PROIBIDOS.length} caminhos de efeito`, () => {
      const codigo = readFileSync(path.join(RAIZ, arquivo), "utf8")
        // Comentários podem citar os nomes para explicar a ausência.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      const achados = PROIBIDOS.filter((p) => codigo.includes(p));
      expect(achados).toEqual([]);
    });
  }

  it("a gravação de cada conversa é a função silenciosa do banco", () => {
    const codigo = readFileSync(path.join(RAIZ, "importar-historico.ts"), "utf8");
    expect(codigo).toContain('"fn_importar_conversa_historica"');
  });
});
