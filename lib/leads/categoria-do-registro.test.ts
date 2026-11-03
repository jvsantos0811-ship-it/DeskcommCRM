import { describe, expect, it } from "vitest";

import { ACTIVITY_LABELS } from "./activity-vocabulary";
import { CATEGORIAS_DO_REGISTRO, categoriaDoRegistro } from "./categoria-do-registro";

describe("categoriaDoRegistro (filtros da linha do tempo, PC-013)", () => {
  it("põe cada família de registro no seu filtro", () => {
    expect(categoriaDoRegistro("stage_changed")).toBe("etapas");
    expect(categoriaDoRegistro("lead_created")).toBe("etapas");
    expect(categoriaDoRegistro("moved_from_pipeline")).toBe("etapas");
    expect(categoriaDoRegistro("ai_turn")).toBe("conversa");
    expect(categoriaDoRegistro("conversation_claimed")).toBe("conversa");
    expect(categoriaDoRegistro("voice_call_missed")).toBe("conversa");
    expect(categoriaDoRegistro("task_created")).toBe("tarefas");
    expect(categoriaDoRegistro("appointment_scheduled")).toBe("tarefas");
    expect(categoriaDoRegistro("followup_snoozed")).toBe("tarefas");
    expect(categoriaDoRegistro("contract_signed")).toBe("contratos");
    expect(categoriaDoRegistro("proposal_sent")).toBe("contratos");
    expect(categoriaDoRegistro("lead_cooled")).toBe("sistema");
    expect(categoriaDoRegistro("reactivation_expired")).toBe("sistema");
  });

  it("tipo desconhecido cai em Sistema — nunca some da linha do tempo", () => {
    expect(categoriaDoRegistro("tipo_que_ainda_nao_existe")).toBe("sistema");
    expect(categoriaDoRegistro("")).toBe("sistema");
  });

  it("todo tipo do vocabulário cai numa categoria conhecida", () => {
    for (const tipo of Object.keys(ACTIVITY_LABELS)) {
      expect(CATEGORIAS_DO_REGISTRO).toContain(categoriaDoRegistro(tipo));
    }
  });
});
