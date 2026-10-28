/**
 * PC-002b — a regra da FRASE SEGURA (lib/messaging/frase-segura.ts).
 *
 * Uma trava existe para impedir a frase errada, nunca para trocá-la por
 * silêncio. Mas há travas cujo veto É "não fale agora" (opt-out, LGPD, janela,
 * ritmo) — nelas a frase não pode sair. Os dois lados estão aqui.
 */
import { describe, expect, it } from "vitest";

import {
  FRASE_SEGURA_PADRAO_ES,
  FRASE_SEGURA_PADRAO_PT,
  fraseSeguraDaOrg,
  fraseSeguraDeveSair,
  fraseSeguraEntradaSchema,
  resumoDoBloqueio,
  type VetoDoTurno,
} from "@/lib/messaging/frase-segura";

const veto = (trava: string, codigo = trava): VetoDoTurno => ({
  trava,
  codigo,
  motivo: "motivo da trava",
  texto: "texto barrado",
});

const base = {
  turnoDeResposta: true,
  enviadas: 0,
  vetos: [veto("case_promise", "case_promise_without_case")],
  turnoDescartado: false,
  passouParaAEquipe: false,
  capDeEnvio: false,
  optedOut: false,
};

describe("a rede da frase segura entra", () => {
  it("⭐ trava de conteúdo barrou e nada saiu → a frase sai", () => {
    expect(fraseSeguraDeveSair(base)).toBe(true);
    expect(fraseSeguraDeveSair({ ...base, vetos: [veto("clinical_claim")] })).toBe(true);
    expect(fraseSeguraDeveSair({ ...base, vetos: [veto("promise", "promise_semantic")] })).toBe(true);
  });
});

describe("a rede NÃO entra", () => {
  it("quando algo já saiu (o ensino funcionou)", () => {
    expect(fraseSeguraDeveSair({ ...base, enviadas: 1 })).toBe(false);
  });
  it("quando nada foi barrado (silêncio sem tentativa é o turno mudo, outra regra)", () => {
    expect(fraseSeguraDeveSair({ ...base, vetos: [] })).toBe(false);
  });
  it.each(["stop", "lgpd", "pacing", "messaging_window"])(
    "quando a trava que barrou é '%s' — ali o silêncio é a decisão",
    (trava) => {
      expect(fraseSeguraDeveSair({ ...base, vetos: [veto("case_promise"), veto(trava)] })).toBe(false);
    },
  );
  it("em turno que não responde (retomada/follow-up), descartado, passado à equipe, no teto ou com opt-out", () => {
    expect(fraseSeguraDeveSair({ ...base, turnoDeResposta: false })).toBe(false);
    expect(fraseSeguraDeveSair({ ...base, turnoDescartado: true })).toBe(false);
    expect(fraseSeguraDeveSair({ ...base, passouParaAEquipe: true })).toBe(false);
    expect(fraseSeguraDeveSair({ ...base, capDeEnvio: true })).toBe(false);
    expect(fraseSeguraDeveSair({ ...base, optedOut: true })).toBe(false);
  });
});

describe("a frase da organização", () => {
  it("padrão por idioma; a configurada vence; vazio volta à padrão", () => {
    expect(fraseSeguraDaOrg({}, "pt-BR")).toBe(FRASE_SEGURA_PADRAO_PT);
    expect(fraseSeguraDaOrg(null, "es-AR")).toBe(FRASE_SEGURA_PADRAO_ES);
    expect(fraseSeguraDaOrg({ frase_segura: "  Recebi!  Já te respondo. " }, "pt-BR")).toBe(
      "Recebi! Já te respondo.",
    );
    expect(fraseSeguraDaOrg({ frase_segura: "   " }, "pt-BR")).toBe(FRASE_SEGURA_PADRAO_PT);
    expect(fraseSeguraDaOrg({ frase_segura: 42 }, "pt-BR")).toBe(FRASE_SEGURA_PADRAO_PT);
  });

  it("a frase padrão não promete prazo, resultado nem quem atende (OAB)", () => {
    for (const f of [FRASE_SEGURA_PADRAO_PT, FRASE_SEGURA_PADRAO_ES]) {
      expect(f).not.toMatch(/advogad|equipe|garant|prazo|hora|resultado|abogad|equipo/i);
    }
  });

  it("entrada da tela: aceita vazio, recusa acima de 300 caracteres e campo extra", () => {
    expect(fraseSeguraEntradaSchema.parse({ frase: "" })).toEqual({ frase: "" });
    expect(fraseSeguraEntradaSchema.safeParse({ frase: "x".repeat(301) }).success).toBe(false);
    expect(fraseSeguraEntradaSchema.safeParse({ frase: "ok", outra: 1 }).success).toBe(false);
  });
});

describe("o que a equipe recebe", () => {
  it("o resumo leva o texto barrado e o motivo leva a trava e o código", () => {
    const r = resumoDoBloqueio([veto("clinical_claim")]);
    expect(r.resumo).toContain("texto barrado");
    expect(r.motivo).toContain('Trava "clinical_claim" (clinical_claim)');
  });
});
