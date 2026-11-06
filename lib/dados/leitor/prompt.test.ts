import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAXIMO_DE_CARACTERES,
  montarPromptDoLeitor,
  transcreverConversa,
  type MensagemParaOLeitor,
} from "./prompt";

const variaveis = {
  organizacao: "Clínica Sorriso",
  agentes: ["Bia"],
  tipos: [
    { nome: "Implante", requisitos: ["perdeu o dente", "já avaliou", "forma de pagamento"] },
    { nome: "Clareamento", requisitos: [] },
  ],
  prefixosDeAnuncio: ["#C1"],
  termoDoContrato: "orçamento",
};

describe("prompt do Leitor (molde por organização)", () => {
  it("leva as variáveis da organização", () => {
    const p = montarPromptDoLeitor(variaveis);
    expect(p).toContain("a equipe de Clínica Sorriso");
    expect(p).toContain("(Bia)");
    expect(p).toContain('"Implante", "Clareamento"');
    expect(p).toContain("- Implante: perdeu o dente; já avaliou; forma de pagamento");
    expect(p).toContain('começam com "#C1"');
    expect(p).toContain("assinatura do orçamento");
    expect(p).toContain("esperando_a_equipe");
    expect(p).toContain("ja_atendido_por_outro");
  });

  it("sem catálogo, manda usar a_confirmar em vez de inventar tipo", () => {
    const p = montarPromptDoLeitor({ ...variaveis, tipos: [] });
    expect(p).toContain('nenhum tipo cadastrado: use "a_confirmar"');
    expect(p).toContain("nenhum checklist cadastrado");
  });

  it("o código do Leitor não tem nome de cliente nem de agente (PM-027 §4)", () => {
    const dir = path.join(process.cwd(), "lib/dados/leitor");
    for (const arq of ["prompt.ts", "selecao.ts"]) {
      const txt = readFileSync(path.join(dir, arq), "utf-8").toLowerCase();
      for (const nome of ["bórbora", "borbora", "raquel", "souza rodrigues"]) expect(txt).not.toContain(nome);
    }
  });
});

function m(p: Partial<MensagemParaOLeitor>): MensagemParaOLeitor {
  return {
    direction: "inbound",
    sent_via: "external_device",
    type: "text",
    body: "oi",
    media_derived_text: null,
    status: "delivered",
    created_at: "2026-11-05T13:05:00Z",
    ...p,
  };
}

describe("a conversa transcrita", () => {
  it("diz quem falou, quando (no fuso) e põe a transcrição no lugar do áudio", () => {
    const t = transcreverConversa(
      [
        m({ body: "quero saber do implante" }),
        m({ direction: "outbound", sent_via: "ai", body: "Claro! Você já avaliou?", created_at: "2026-11-05T13:06:00Z" }),
        m({ type: "audio", body: null, media_derived_text: "já avaliei sim", created_at: "2026-11-05T13:07:00Z" }),
        m({ direction: "outbound", sent_via: "external_device", body: "Te ligo amanhã", created_at: "2026-11-05T13:08:00Z" }),
        m({ direction: "outbound", sent_via: "system", body: "nota interna", created_at: "2026-11-05T13:09:00Z" }),
        m({ direction: "outbound", sent_via: "ai", body: "Oi?", status: "failed", created_at: "2026-11-05T13:10:00Z" }),
      ],
      "America/Sao_Paulo",
    );
    expect(t.split("\n")).toEqual([
      "[2026-11-05T10:05] Contato: quero saber do implante",
      "[2026-11-05T10:06] Assistente virtual: Claro! Você já avaliou?",
      "[2026-11-05T10:07] Contato: [áudio] já avaliei sim",
      "[2026-11-05T10:08] Equipe (pelo celular): Te ligo amanhã",
      "[2026-11-05T10:10] Assistente virtual (não entregue): Oi?",
    ]);
  });

  it("conversa longa: ficam as mais recentes, e o corte é avisado", () => {
    const longa = Array.from({ length: 400 }, (_, i) =>
      m({ body: `mensagem ${i} ${"x".repeat(200)}`, created_at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() }),
    );
    const t = transcreverConversa(longa, "America/Sao_Paulo");
    expect(t.length).toBeLessThanOrEqual(MAXIMO_DE_CARACTERES + 60);
    expect(t.startsWith("(")).toBe(true);
    expect(t).toContain("mensagem 399");
    expect(t).not.toContain("mensagem 0 ");
  });
});
