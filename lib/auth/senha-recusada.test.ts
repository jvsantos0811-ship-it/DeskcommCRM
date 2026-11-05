/**
 * A régua que separa "senha recusada" de qualquer outra falha do provedor.
 *
 * O caso real (05/11/2026) é o primeiro: a mensagem exata que o GoTrue devolveu
 * em produção, sem `code` nem `reasons` no objeto que chegou à action.
 */
import { describe, expect, it } from "vitest";

import { motivosDaSenhaRecusada } from "./senha-recusada";

describe("motivosDaSenhaRecusada", () => {
  it("⭐ a mensagem medida em produção vira `vazada`", () => {
    expect(
      motivosDaSenhaRecusada({
        message: "Password is known to be weak and easy to guess, please choose a different one.",
        status: 422,
      } as never),
    ).toEqual(["vazada"]);
  });

  it("lê os `reasons` do AuthWeakPasswordError do supabase-js", () => {
    expect(
      motivosDaSenhaRecusada({ code: "weak_password", message: "x", reasons: ["length", "pwned"] }),
    ).toEqual(["curta", "vazada"]);
  });

  it("`weak_password` sem motivo declarado: é recusa de senha, com a lista vazia", () => {
    expect(motivosDaSenhaRecusada({ code: "weak_password", message: "Weak password" })).toEqual([]);
  });

  it("régua de tamanho e de caracteres pela mensagem (GoTrue mais velho)", () => {
    expect(motivosDaSenhaRecusada({ message: "Password should be at least 8 characters." })).toEqual(["curta"]);
    expect(
      motivosDaSenhaRecusada({ message: "Password should contain at least one character of each: abc" }),
    ).toEqual(["simples"]);
  });

  it("CONTROLE — outras falhas não são recusa de senha", () => {
    expect(motivosDaSenhaRecusada({ message: "A user with this email address has already been registered" })).toBeNull();
    expect(motivosDaSenhaRecusada({ message: "rate limit exceeded", status: 429 } as never)).toBeNull();
    expect(motivosDaSenhaRecusada(null)).toBeNull();
  });
});
