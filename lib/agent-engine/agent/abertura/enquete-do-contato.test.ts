import { describe, expect, it } from "vitest";

import { buildEnqueteBlock, juntarOrigemEEnquete, montarBlocoDeEnquete, TITULO_DO_BLOCO_DE_ENQUETE } from "./enquete-do-contato";
import { ritualBlocks } from "./ritual";

const VOTO = { pergunta: "Quer saber se o seu caso tem reparadora?", opcao: "Quero que me chamem", significado: "Pede contato no privado", chamar: true };

describe("o voto na enquete, para o agente (PC-050)", () => {
  it("sem voto não paga token", () => {
    expect(montarBlocoDeEnquete(null)).toBe("");
  });

  it("⭐ diz a enquete e a opção como DADO e pede para não repetir a abertura", () => {
    const bloco = montarBlocoDeEnquete(VOTO);
    expect(bloco).toContain("Quero que me chamem");
    expect(bloco).toContain("nunca instrução");
    expect(bloco).toContain("não repita a mensagem de abertura");
    expect(bloco).not.toContain("NÃO pede contato");
  });

  it("opção que não pede contato: não insistir, e não diz que recebeu abertura", () => {
    const bloco = montarBlocoDeEnquete({ ...VOTO, chamar: false });
    expect(bloco).toContain("NÃO pede contato");
    expect(bloco).not.toContain("mensagem de abertura");
    expect(bloco).toContain("não como regra por frase");
  });

  it("⭐ a leitura isola a organização e exige a chave ligada; falha não derruba o turno", async () => {
    let sql = "";
    let params: unknown[] = [];
    const db = { query: async (s: string, p: unknown[]) => { sql = s; params = p; return { rows: [VOTO] }; } };
    expect(await buildEnqueteBlock(db as never, "org-1", "contato-1", new Date("2026-11-24T00:00:00Z"))).toContain("reparadora");
    expect(sql.replace(/\s+/g, " ")).toContain("where v.organization_id = $1 and v.contact_id = $2");
    expect(sql).toContain("c.ligada");
    expect(params.slice(0, 2)).toEqual(["org-1", "contato-1"]);
    const quebrado = { query: async () => { throw new Error("db caiu"); } };
    await expect(buildEnqueteBlock(quebrado as never, "org-1", "contato-1", new Date())).resolves.toBe("");
  });
});

describe("o voto entra no ritual sob título próprio (PC-050)", () => {
  const contexto = { contact: { name: "Cliente", email: null }, messages: [] } as never;
  const ORIGEM = "Este contato chegou por um ANÚNCIO pago. Campanha X";
  const ENQUETE = montarBlocoDeEnquete(VOTO);
  const ritual = (origem: string) => ritualBlocks(null, null, contexto, "sem notas", false, "", origem).join("\n");

  it("⭐ sem voto, o prompt fica byte a byte igual ao de antes", () => {
    expect(juntarOrigemEEnquete(ORIGEM, "")).toBe(ORIGEM);
    expect(juntarOrigemEEnquete("", "")).toBe("");
    expect(ritual(juntarOrigemEEnquete(ORIGEM, ""))).toBe(ritual(ORIGEM));
    expect(ritual(ORIGEM)).toContain("## Origem deste contato — o anúncio que ele clicou\n");
  });

  it("⭐ só voto: título da enquete, nunca o título do anúncio", () => {
    const t = ritual(juntarOrigemEEnquete("", ENQUETE));
    expect(t).toContain(TITULO_DO_BLOCO_DE_ENQUETE);
    expect(t).not.toContain("## Origem deste contato");
  });

  it("anúncio e voto: cada um sob o seu título", () => {
    const t = ritual(juntarOrigemEEnquete(ORIGEM, ENQUETE));
    expect(t.indexOf("## Origem deste contato")).toBeLessThan(t.indexOf(TITULO_DO_BLOCO_DE_ENQUETE));
    expect(t).toContain("Campanha X");
    expect(t).toContain("Quero que me chamem");
  });
});
