/**
 * A tela "Novo Tenant" abre com cinco áreas DESMARCADAS (fork LeadSales IA):
 * campanha, agente, follow-up, automação e servidor MCP externo de um
 * escritório cliente são montados pela agência, não pelo escritório.
 *
 * Casos: as cinco somem da navegação de quem administra; nada além delas some;
 * a seleção passa no schema e na guarda de "sobra alguma área" que o botão
 * "Criar organização" cobra.
 */
import { describe, expect, it } from "vitest";

import { NAV_CATALOG } from "@/lib/navigation/catalogo";
import {
  AREAS_FECHADAS_NA_CRIACAO,
  destinosDaInterface,
  INTERFACE_PADRAO_NA_CRIACAO,
  interfaceSettingsSchema,
  interfaceTemDestino,
} from "@/lib/navigation/interface";

const visiveis = (s: unknown) => destinosDaInterface(s, false, "admin").map((d) => d.href);

describe("seleção padrão da tela Novo Tenant", () => {
  it("esconde as cinco áreas fechadas de quem administra o escritório", () => {
    const hrefs = visiveis(INTERFACE_PADRAO_NA_CRIACAO);
    for (const area of AREAS_FECHADAS_NA_CRIACAO) expect(hrefs).not.toContain(area);
  });

  it("não esconde nada além delas", () => {
    const completa = visiveis({ preset: "completa" });
    const esperado = completa.filter(
      (h) => !(AREAS_FECHADAS_NA_CRIACAO as readonly string[]).includes(h),
    );
    expect(visiveis(INTERFACE_PADRAO_NA_CRIACAO)).toEqual(esperado);
  });

  it("toda área fechada existe no catálogo (renomear a rota não pode abrir a porta em silêncio)", () => {
    const hrefs = NAV_CATALOG.map((d) => d.href as string);
    for (const area of AREAS_FECHADAS_NA_CRIACAO) expect(hrefs).toContain(area);
  });

  it("é uma seleção válida para o botão Criar organização", () => {
    expect(interfaceSettingsSchema.safeParse(INTERFACE_PADRAO_NA_CRIACAO).success).toBe(true);
    expect(interfaceTemDestino(INTERFACE_PADRAO_NA_CRIACAO, "admin")).toBe(true);
  });
});
