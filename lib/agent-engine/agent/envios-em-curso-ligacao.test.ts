import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PC-035 B2 — cerca da LIGAÇÃO. `envios-em-curso.test.ts` prova o utilitário;
 * este arquivo reprova se o turno deixar de usá-lo: sem o embrulho dos envios,
 * ou com a passagem lendo `seq` antes de esperar, a corrida volta e o aviso
 * padrão sai por cima da fala do modelo.
 */
const fonte = readFileSync(join(__dirname, "inbound-turn.ts"), "utf-8");

describe("cerca: a passagem espera os envios da mesma passada", () => {
  it("send_message e send_template são embrulhados por enviosEmCurso.acompanhar", () => {
    const laco = fonte.match(/for \(const nome of \['send_message', 'send_template'\] as const\) \{[\s\S]*?\n {2}\}/);
    expect(laco, "laço que embrulha os envios sumiu").not.toBeNull();
    expect(laco![0]).toContain("enviosEmCurso.acompanhar(");
  });

  it("o embrulho vem antes de qualquer remoção de ferramenta e do disjuntor", () => {
    const embrulho = fonte.indexOf("for (const nome of ['send_message', 'send_template'] as const)");
    const remocaoDaPassagem = fonte.indexOf("delete rawTools.request_human_handoff");
    const disjuntor = fonte.indexOf("wrapToolsWithBreaker(", embrulho);
    expect(embrulho).toBeGreaterThan(0);
    expect(embrulho).toBeLessThan(remocaoDaPassagem);
    expect(disjuntor).toBeGreaterThan(embrulho);
  });

  it("dentro da passagem, a espera vem antes da leitura de `seq` que decide o aviso", () => {
    const inicio = fonte.indexOf("const passarParaAEquipeNoTurno = async");
    expect(inicio).toBeGreaterThan(0);
    const espera = fonte.indexOf("await enviosEmCurso.esperar();", inicio);
    const piso = fonte.indexOf("seq === 0", inicio);
    expect(espera).toBeGreaterThan(inicio);
    expect(piso).toBeGreaterThan(espera);
  });
});
