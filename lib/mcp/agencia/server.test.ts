import { describe, expect, it } from "vitest";

import { allTools } from "../tools";
import { ferramentasDaPorta } from "./server";

/**
 * A FRONTEIRA DA PORTA LEITURA. A PM aprovada (30/10/2026) diz: "qualquer
 * ferramenta de escrita retorna erro nesta porta, mesmo se chamada. O bloqueio
 * fica no servidor". Aqui é mais forte: a ferramenta de escrita nem é
 * registrada — chamá-la responde "ferramenta desconhecida".
 */
describe("ferramentasDaPorta('leitura')", () => {
  const leitura = ferramentasDaPorta("leitura");
  const nomes = new Set(leitura.map((t) => t.name));

  it("só tem ferramentas de leitura", () => {
    expect(leitura.length).toBeGreaterThan(20);
    for (const t of leitura) {
      expect(t.category, t.name).toBe("read");
      expect(t.requiresScope, t.name).toBe("mcp:read");
    }
  });

  it("nenhuma ferramenta de escrita ou de passagem entra", () => {
    const deEscrita = allTools.filter((t) => t.category !== "read").map((t) => t.name);
    expect(deEscrita.length).toBeGreaterThan(0);
    for (const nome of deEscrita) expect(nomes.has(nome), nome).toBe(false);
  });

  it("as que o Gestor usa estão lá (conversas, histórico, leads, funil, follow-ups, casos)", () => {
    for (const nome of [
      "crm_list_conversations",
      "crm_get_conversation_history",
      "crm_list_leads",
      "crm_get_pipeline_forecast",
      "crm_list_at_risk_leads",
      "crm_list_followups",
      "crm_list_human_cases",
      "crm_list_automation_runs",
    ]) {
      expect(nomes.has(nome), nome).toBe(true);
    }
  });

  it("enviar mensagem e mover etapa ficam de fora", () => {
    for (const nome of ["crm_send_whatsapp_message", "crm_start_conversation_and_send", "crm_move_lead_stage"]) {
      expect(nomes.has(nome), nome).toBe(false);
    }
  });

  it("nenhuma ferramenta já tem um argumento organization_id (o servidor da agência o acrescenta)", () => {
    for (const t of leitura) expect(Object.keys(t.inputSchema), t.name).not.toContain("organization_id");
  });
});

describe("ferramentasDaPorta('admin')", () => {
  it("vazia até a entrega da porta Admin", () => {
    expect(ferramentasDaPorta("admin")).toEqual([]);
  });
});
