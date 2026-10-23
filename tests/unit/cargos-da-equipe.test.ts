import { describe, expect, it } from "vitest";

import { cargoSchema, motivoParaRecusarCargo } from "@/lib/team/cargos";

describe("cargos da equipe", () => {
  it("aceita um cargo de atendente com Inbox e Kanban", () => {
    const r = cargoSchema.safeParse({
      nome: "SDR",
      papel: "agent",
      interface_settings: { preset: "completa", destinos: ["/app/inbox", "/app/kanban"] },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(motivoParaRecusarCargo(r.data)).toBeNull();
  });

  it("recusa cargo de admin: administrar não é cargo", () => {
    expect(
      cargoSchema.safeParse({ nome: "Dono", papel: "admin", interface_settings: { preset: "completa" } }).success,
    ).toBe(false);
  });

  it("recusa seleção que só tem telas que o papel não alcança", () => {
    const r = cargoSchema.safeParse({
      nome: "Leitor",
      papel: "viewer",
      interface_settings: { preset: "completa", destinos: ["/app/prospecting"] },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(motivoParaRecusarCargo(r.data)).toMatch(/ao menos uma tela/);
  });

  it("recusa nome vazio", () => {
    expect(
      cargoSchema.safeParse({ nome: "  ", papel: "agent", interface_settings: { preset: "completa" } }).success,
    ).toBe(false);
  });
});
