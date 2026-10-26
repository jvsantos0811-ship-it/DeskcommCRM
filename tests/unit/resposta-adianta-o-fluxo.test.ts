/**
 * "CANCELAR SE O LEAD RESPONDER" DESLIGADO NUMA RÉGUA DE VENDAS
 * (fork, briefing do Operador item 5).
 *
 * ## O defeito que este arquivo prende
 *
 * Com `cancel_on_reply` desligado (o padrão), a resposta do cliente NÃO para o
 * fluxo: ela ENCURTA a espera em curso (`inbound_woke`, em
 * `lib/followup/reactivity.ts`) e o próximo passo sai logo em seguida. Numa
 * régua de vendas — "responder ao lead = parar de insistir" — quem montou
 * espera o contrário, e nada na tela avisava.
 *
 * O padrão não muda (reprovaria o re-publish de fluxos que já existem e que
 * QUEREM acordar com a resposta); o publicar passa a AVISAR, sem reprovar.
 *
 * ## Os casos
 *
 * 1. espera que encurta ligada direto a um passo que manda, sem
 *    `cancel_on_reply` → avisa;
 * 2. com `cancel_on_reply: true` → não avisa;
 * 3. espera imune (fixa + `immune_to_reply`) → não avisa: a resposta não a
 *    encurta;
 * 4. espera seguida de classificação → não avisa: a resposta é lida por esse
 *    nó, que é o desenho pedido;
 * 5. no-show de agendamento, ou gatilho ilegível → não avisa;
 * 6. pelo `validateFlowForPublish` inteiro: o aviso chega a `warnings` e o
 *    fluxo continua publicável.
 */
import { describe, expect, it } from "vitest";

import type { TriggerConfig } from "@/lib/followup/api-schemas";
import type { FlowEdge, FlowGraph, FlowNode } from "@/lib/followup/graph-schema";
import {
  avisosDaResposta,
  PUBLISH_WARNING_CODES,
  validateFlowForPublish,
} from "@/lib/followup/validate-publish";

const pos = { x: 0, y: 0 };
const DIA_MS = 86_400_000;
const TEMPLATE_ID = "00000000-0000-4000-8000-000000000000";

const gatilho: FlowNode = { id: "t", type: "trigger", label: "t", position: pos, config: {} };
const esperaComum: FlowNode = {
  id: "w",
  type: "wait",
  label: "w",
  position: pos,
  config: { mode: "fixed", duration_ms: DIA_MS },
};
const esperaImune: FlowNode = {
  id: "w",
  type: "wait",
  label: "w",
  position: pos,
  config: { mode: "fixed", duration_ms: 30 * DIA_MS, immune_to_reply: true },
};
const classificar: FlowNode = {
  id: "c",
  type: "ai_classify",
  label: "c",
  position: pos,
  config: { classes: ["sim", "nao"], grace_timeout_ms: 900_000, target: "last_reply" },
};
const passo: FlowNode = {
  id: "a",
  type: "action",
  label: "a",
  position: pos,
  config: { mode: "template", template_id: TEMPLATE_ID },
};
const fim: FlowNode = { id: "e", type: "end", label: "e", position: pos, config: { outcome: "exhausted" } };

let seq = 0;
function liga(source: string, target: string): FlowEdge {
  seq++;
  return { id: `e${seq}`, source, target, priority: 0, condition: { type: "always" } };
}

/** gatilho → espera → passo → fim: a régua mais simples de todas. */
function regua(espera: FlowNode): FlowGraph {
  return {
    nodes: [gatilho, espera, passo, fim],
    edges: [liga("t", "w"), liga("w", "a"), liga("a", "e")],
  };
}

const VENDAS: TriggerConfig = { kind: "lead_created" };
const VENDAS_QUE_PARA: TriggerConfig = { kind: "lead_created", cancel_on_reply: true };

function codigos(g: FlowGraph, trigger: TriggerConfig | undefined): string[] {
  return avisosDaResposta(g.nodes, g.edges, trigger).map((a) => a.code);
}

describe("aviso: a resposta adianta o fluxo", () => {
  it("o código é conhecido do contrato de avisos", () => {
    expect(PUBLISH_WARNING_CODES).toContain("resposta_adianta_o_fluxo");
  });

  it("⭐ espera que encurta ligada direto a um envio, sem cancelar na resposta → avisa", () => {
    expect(codigos(regua(esperaComum), VENDAS)).toEqual(["resposta_adianta_o_fluxo"]);
  });

  it("a mensagem diz o efeito e o remédio, com o nome que a tela usa", () => {
    const g = regua(esperaComum);
    const [aviso] = avisosDaResposta(g.nodes, g.edges, VENDAS);
    expect(aviso?.message).toMatch(/ENCURTA a espera/);
    expect(aviso?.message).toMatch(/Cancelar se o lead responder/);
  });

  it("com “Cancelar se o lead responder” ligado → não avisa", () => {
    expect(codigos(regua(esperaComum), VENDAS_QUE_PARA)).toEqual([]);
  });

  it("espera imune → não avisa: a resposta não a encurta", () => {
    expect(codigos(regua(esperaImune), VENDAS)).toEqual([]);
  });

  it("espera seguida de classificação → não avisa: a resposta é lida por esse nó", () => {
    const g: FlowGraph = {
      nodes: [gatilho, esperaComum, classificar, passo, fim],
      edges: [liga("t", "w"), liga("w", "c"), liga("c", "a"), liga("a", "e")],
    };
    expect(codigos(g, VENDAS)).toEqual([]);
  });

  it("no-show de agendamento e gatilho ilegível → não avisa", () => {
    expect(codigos(regua(esperaComum), { kind: "appointment_no_show" })).toEqual([]);
    expect(codigos(regua(esperaComum), undefined)).toEqual([]);
  });

  it("⭐ pelo publicar inteiro: chega aos avisos e o fluxo continua publicável", () => {
    const comAviso = validateFlowForPublish(regua(esperaComum), { trigger: VENDAS });
    expect(comAviso.ok).toBe(true);
    expect((comAviso.warnings ?? []).map((w) => w.code)).toContain("resposta_adianta_o_fluxo");

    const semAviso = validateFlowForPublish(regua(esperaComum), { trigger: VENDAS_QUE_PARA });
    expect(semAviso.ok).toBe(true);
    expect((semAviso.warnings ?? []).map((w) => w.code)).not.toContain("resposta_adianta_o_fluxo");
  });
});
