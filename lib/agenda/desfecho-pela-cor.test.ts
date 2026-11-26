import { describe, expect, it } from "vitest";
import { aplicaDesfecho, desfechoDaCor } from "./desfecho-pela-cor";

const cores = { realizado: "9", faltou: "8" };

describe("desfechoDaCor (PC-062)", () => {
  it("a cor de Realizado e a de Faltou viram o desfecho", () => {
    expect(desfechoDaCor("9", cores)).toBe("completed");
    expect(desfechoDaCor("8", cores)).toBe("no_show");
  });

  it("outra cor, sem cor ou desligado: nada", () => {
    expect(desfechoDaCor("7", cores)).toBeNull();
    expect(desfechoDaCor(undefined, cores)).toBeNull();
    expect(desfechoDaCor("", cores)).toBeNull();
    expect(desfechoDaCor("9", { realizado: null, faltou: null })).toBeNull();
  });

  it("a cor da presença do lead (pintada pelo CRM) nunca é desfecho", () => {
    for (const cor of ["5", "10", "11"]) {
      expect(desfechoDaCor(cor, { realizado: cor, faltou: cor })).toBeNull();
    }
  });
});

describe("aplicaDesfecho (PC-062)", () => {
  const agora = new Date("2026-11-27T15:00:00Z");
  const passado = "2026-11-27T13:20:00Z";
  const futuro = "2026-11-27T18:00:00Z";

  it("depois do início, num compromisso de pé: aplica", () => {
    expect(aplicaDesfecho({ status: "confirmed", starts_at: passado }, "completed", agora)).toBe(true);
    expect(aplicaDesfecho({ status: "pending", starts_at: passado }, "no_show", agora)).toBe(true);
  });

  it("antes do início: nunca", () => {
    expect(aplicaDesfecho({ status: "confirmed", starts_at: futuro }, "completed", agora)).toBe(false);
  });

  it("o mesmo desfecho não refaz; trocar corrige; cancelado não volta", () => {
    expect(aplicaDesfecho({ status: "completed", starts_at: passado }, "completed", agora)).toBe(false);
    expect(aplicaDesfecho({ status: "no_show", starts_at: passado }, "completed", agora)).toBe(true);
    expect(aplicaDesfecho({ status: "cancelled", starts_at: passado }, "completed", agora)).toBe(false);
  });
});
