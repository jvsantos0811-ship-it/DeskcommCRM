/**
 * A ESPERA DO FLUXO EM HORAS/DIAS E A ESPERA IMUNE, PELA TELA
 * (fork, briefing do Operador item 5).
 *
 * Monta o formulário REAL (`WaitForm`):
 *
 *   1. uma espera de 30 dias (43200 min) abre como "30" em "dias" — e não
 *      "43200" em minutos, que era a única unidade da tela;
 *   2. digitar em dias grava milissegundos certos no config;
 *   3. a chave "Continuar esperando mesmo se o cliente responder" grava
 *      `immune_to_reply: true` — antes ela só entrava por `.fluxo.json`;
 *   4. desligada, a chave NÃO vai para o config (fluxo antigo igual);
 *   5. com menos de 24 h, a tela avisa que o publicar vai recusar.
 */
import * as React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

import { WaitForm } from "@/app/app/ai/followups/[id]/_components/forms/WaitForm";

const DIA_MS = 86_400_000;

function montar(config: Parameters<typeof WaitForm>[0]["config"]) {
  const onChange = vi.fn();
  render(<WaitForm config={config} onChange={onChange} />);
  return onChange;
}

describe("WaitForm — unidade e espera imune", () => {
  it("⭐ 30 dias abrem como 30 em dias, e o rótulo diz a unidade", () => {
    montar({ mode: "fixed", duration_ms: 30 * DIA_MS });
    expect(screen.getByLabelText("Duração (dias)")).toHaveValue(30);
  });

  it("espera curta continua em minutos, com o rótulo de sempre", () => {
    montar({ mode: "fixed", duration_ms: 10 * 60_000 });
    expect(screen.getByLabelText("Duração (minutos)")).toHaveValue(10);
  });

  it("⭐ digitar em dias grava os milissegundos certos", () => {
    const onChange = montar({ mode: "fixed", duration_ms: 30 * DIA_MS });
    fireEvent.change(screen.getByLabelText("Duração (dias)"), { target: { value: "45" } });
    expect(onChange).toHaveBeenLastCalledWith({ mode: "fixed", duration_ms: 45 * DIA_MS });
  });

  it("⭐ ligar a espera imune grava immune_to_reply: true; desligar tira a chave", async () => {
    const onChange = montar({ mode: "fixed", duration_ms: 30 * DIA_MS });
    const chave = screen.getByTestId("wait-imune");

    await userEvent.click(chave);
    expect(onChange).toHaveBeenLastCalledWith({ mode: "fixed", duration_ms: 30 * DIA_MS, immune_to_reply: true });

    await userEvent.click(chave);
    expect(onChange).toHaveBeenLastCalledWith({ mode: "fixed", duration_ms: 30 * DIA_MS });
  });

  it("imune com menos de 24 h: a tela avisa que não publica", () => {
    montar({ mode: "fixed", duration_ms: 10 * 60_000, immune_to_reply: true });
    expect(screen.getByTestId("wait-imune-curta")).toBeInTheDocument();
  });

  it("controle: imune com 30 dias não mostra o aviso", () => {
    montar({ mode: "fixed", duration_ms: 30 * DIA_MS, immune_to_reply: true });
    expect(screen.queryByTestId("wait-imune-curta")).toBeNull();
  });
});
