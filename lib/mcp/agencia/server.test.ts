import { describe, expect, it } from "vitest";

import { allTools } from "../tools";
import { FERRAMENTAS_EXCLUSIVAS_DA_PORTA_ADMIN } from "./ferramentas-do-agente";
import { ESCRITAS_DA_PORTA_ADMIN, LEITURAS_DA_PORTA_ADMIN, NUNCA_NA_PORTA_ADMIN } from "./porta-admin";
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

describe("ferramentasDaPorta('admin') — a fronteira da porta Admin", () => {
  const admin = ferramentasDaPorta("admin");
  const nomes = new Set(admin.map((t) => t.name));

  it("é exatamente a lista fechada de porta-admin.ts (nada entra por omissão)", () => {
    const declaradas = [...Object.keys(LEITURAS_DA_PORTA_ADMIN), ...Object.keys(ESCRITAS_DA_PORTA_ADMIN)].sort();
    expect([...nomes].sort()).toEqual(declaradas);
  });

  it("toda ferramenta citada na lista existe no CRM, com a categoria certa", () => {
    const porNome = new Map([...allTools, ...FERRAMENTAS_EXCLUSIVAS_DA_PORTA_ADMIN].map((t) => [t.name, t]));
    for (const nome of Object.keys(LEITURAS_DA_PORTA_ADMIN)) expect(porNome.get(nome)?.category, nome).toBe("read");
    for (const nome of Object.keys(ESCRITAS_DA_PORTA_ADMIN)) expect(porNome.get(nome)?.category, nome).toBe("write");
  });

  it("nunca: enviar, iniciar conversa, rascunho, histórico, conversa, contato, caso", () => {
    for (const nome of NUNCA_NA_PORTA_ADMIN) expect(nomes.has(nome), nome).toBe(false);
    for (const nome of [
      "crm_request_human_handoff",
      "crm_resume_ai_attendance",
      "crm_schedule_followup",
      "crm_enroll_followup_flow",
      "crm_propose_reactivation",
      "crm_book_appointment",
      "crm_list_followups",
      "crm_list_automation_runs",
      "crm_list_webhook_source_events",
      "crm_list_improvement_proposals",
      "crm_render_message_template",
    ]) {
      expect(nomes.has(nome), nome).toBe(false);
    }
  });

  it("o papel da porta alcança todas as ferramentas dela", () => {
    const rank = { viewer: 1, agent: 2, ai_operator: 3, manager: 4, admin: 5 } as const;
    for (const t of admin) expect(rank[t.requiresRole] <= rank.manager, t.name).toBe(true);
  });
});

describe("ferramentas do prompt do agente — só na porta Admin", () => {
  const exclusivas = FERRAMENTAS_EXCLUSIVAS_DA_PORTA_ADMIN.map((t) => t.name);

  it("não estão em allTools (nem no /api/mcp comum, nem na lista dos agentes de atendimento)", () => {
    const deTodos = new Set(allTools.map((t) => t.name));
    for (const nome of exclusivas) expect(deTodos.has(nome), nome).toBe(false);
  });

  it("estão na porta Admin e não na Leitura", () => {
    const admin = new Set(ferramentasDaPorta("admin").map((t) => t.name));
    const leitura = new Set(ferramentasDaPorta("leitura").map((t) => t.name));
    for (const nome of exclusivas) {
      expect(admin.has(nome), nome).toBe(true);
      expect(leitura.has(nome), nome).toBe(false);
    }
  });

  it("nenhuma delas publica rascunho: a única que publica é a de voltar a uma versão que já esteve no ar", () => {
    expect(exclusivas.sort()).toEqual(
      [
        "crm_get_ai_agent_prompt",
        "crm_list_ai_agents",
        "crm_request_ai_agent_publish",
        "crm_revert_ai_agent_version",
        "crm_save_ai_agent_draft",
      ].sort(),
    );
  });
});
