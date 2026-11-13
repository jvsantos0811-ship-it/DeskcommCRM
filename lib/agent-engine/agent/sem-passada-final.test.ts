import { describe, expect, it } from "vitest";

import { allTools } from "@/lib/mcp/tools";

import { ferramentaPedeLeitura, passadaEncerraOTurno, type PassadaDoLaco } from "./sem-passada-final";

/**
 * PC-035 — a regra "sem passada final", caso a caso. O laço inteiro (com o
 * `generateText` de verdade e uma chamada a menos) está em
 * `tests/unit/pc-035-abertura-e-laco.test.ts`; aqui fica a regra pura e a cerca
 * do catálogo.
 */

const enviada = { toolName: "send_message", output: { ok: true, status: "enviada", message_id: "m1" } };
const naFila = { toolName: "send_message", output: { ok: true, status: "aceita_aguardando_canal" } };
const vetada = { toolName: "send_message", output: { ok: false, error: { code: "frase_proibida", message: "…" } } };
const nota = { toolName: "save_lead_note", output: { ok: true, note_id: "n1" } };
const etiqueta = { toolName: "crm_manage_tags", output: { ok: true } };

function passada(resultados: Array<{ toolName: string; output: unknown }>, semResultado: string[] = []): PassadaDoLaco {
  return {
    toolCalls: [...resultados.map((r) => ({ toolName: r.toolName })), ...semResultado.map((toolName) => ({ toolName }))],
    toolResults: resultados,
  };
}

describe("passadaEncerraOTurno", () => {
  it("envio aceito + nota + etiqueta na mesma passada: encerra", () => {
    expect(passadaEncerraOTurno(passada([enviada, nota, etiqueta]))).toBe(true);
  });

  it("envio aceito pelo canal para sair depois (fila) também encerra: não é para reenviar", () => {
    expect(passadaEncerraOTurno(passada([naFila]))).toBe(true);
  });

  it("mensagem vetada: o laço segue (o modelo reescreve)", () => {
    expect(passadaEncerraOTurno(passada([vetada, nota]))).toBe(false);
  });

  it("ferramenta de registro que errou: o laço segue (o modelo precisa ler o erro de ensino)", () => {
    const etapaRecusada = {
      toolName: "update_lead_state",
      output: { ok: false, error: { code: "campos_faltando", message: "faltam os campos…" } },
    };
    expect(passadaEncerraOTurno(passada([enviada, etapaRecusada]))).toBe(false);
  });

  it("consulta pedida junto com o envio: o laço segue", () => {
    for (const consulta of ["search_knowledge", "get_lead_context", "get_lead_note", "crm_list_event_types", "crm_find_free_slots"]) {
      expect(passadaEncerraOTurno(passada([enviada, { toolName: consulta, output: { ok: true } }])), consulta).toBe(false);
    }
  });

  it("agenda (marcar, remarcar, desmarcar): o laço segue, o modelo confirma o horário", () => {
    expect(passadaEncerraOTurno(passada([enviada, { toolName: "crm_book_appointment", output: { ok: true } }]))).toBe(false);
  });

  it("ferramenta chamada sem resultado (lançou ou foi negada): o laço segue", () => {
    expect(passadaEncerraOTurno(passada([enviada], ["save_lead_note"]))).toBe(false);
  });

  it("passada sem envio, ou sem ferramenta nenhuma, ou nenhuma passada ainda: não encerra", () => {
    expect(passadaEncerraOTurno(passada([nota]))).toBe(false);
    expect(passadaEncerraOTurno({ toolCalls: [], toolResults: [] })).toBe(false);
    expect(passadaEncerraOTurno(undefined)).toBe(false);
  });

  it("envio com resultado sem `ok: true` (formato inesperado): na dúvida, o laço segue", () => {
    expect(passadaEncerraOTurno(passada([{ toolName: "send_message", output: "enviada" }]))).toBe(false);
  });
});

describe("cerca: toda ferramenta de LEITURA do catálogo do CRM pede leitura", () => {
  // Se uma ferramenta de leitura com nome novo entrar no catálogo e não casar com
  // a lista de `sem-passada-final.ts`, o turno terminaria SEM o modelo ler o que
  // consultou. Este teste reprova antes.
  it("todas as de categoria `read`", () => {
    const leitura = allTools.filter((t) => t.category === "read").map((t) => t.name);
    expect(leitura.length).toBeGreaterThan(20);
    const escapam = leitura.filter((nome) => !ferramentaPedeLeitura(nome));
    expect(escapam).toEqual([]);
  });

  it("as de registro mais comuns não pedem leitura (é o que permite encerrar)", () => {
    for (const nome of ["save_lead_note", "update_lead_state", "crm_manage_tags", "crm_update_lead", "crm_move_lead_stage"]) {
      expect(ferramentaPedeLeitura(nome), nome).toBe(false);
    }
  });
});
