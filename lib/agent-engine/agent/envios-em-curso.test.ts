import { describe, expect, it } from "vitest";

import { criarEnviosEmCurso } from "./envios-em-curso";

/** PC-035 B2: a passagem da mesma passada espera o envio que está saindo. */
describe("criarEnviosEmCurso", () => {
  it("quem espera só segue depois de o envio em curso terminar (o `seq` já contou a fala)", async () => {
    const envios = criarEnviosEmCurso();
    let seq = 0;
    let soltar!: () => void;
    const envio = envios.acompanhar(
      new Promise<void>((r) => {
        soltar = () => {
          seq += 1;
          r();
        };
      }),
    );
    expect(envios.emCurso).toBe(1);
    const passagem = envios.esperar().then(() => seq);
    await Promise.resolve();
    soltar();
    await envio;
    expect(await passagem).toBe(1);
    expect(envios.emCurso).toBe(0);
  });

  it("envio que falhou não derruba a passagem: esperar nunca lança", async () => {
    const envios = criarEnviosEmCurso();
    const falho = envios.acompanhar(Promise.reject(new Error("canal fora")));
    await expect(envios.esperar()).resolves.toBeUndefined();
    await expect(falho).rejects.toThrow("canal fora");
    expect(envios.emCurso).toBe(0);
  });

  it("sem envio em curso, esperar devolve na hora", async () => {
    await expect(criarEnviosEmCurso().esperar()).resolves.toBeUndefined();
  });

  it("devolve o mesmo resultado do envio (o modelo lê o retorno de sempre)", async () => {
    const envios = criarEnviosEmCurso();
    await expect(envios.acompanhar(Promise.resolve({ ok: true, seq: 1 }))).resolves.toEqual({ ok: true, seq: 1 });
  });
});
