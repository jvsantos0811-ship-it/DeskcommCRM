import type pg from "pg";
import { loadAgentVersionConfig } from "./agent-config";
import { runAgentPreview, type InboundTurnDeps } from "./inbound-turn";
import { newPreviewResult, scenarioContext } from "./preview";
export async function testAgentVersion(
  pool: pg.Pool,
  deps: InboundTurnDeps,
  input: {
    organizationId: string;
    agentId: string;
    versionId: string;
    runId: string;
    sampleMessage: string;
    sampleContact?: { name?: string; phone?: string };
    channelId: string | null;
    /** PC-002b (F1-l): a conversa da sessão até aqui (mais antiga primeiro). */
    historico?: ReadonlyArray<{ direcao: "cliente" | "agente"; texto: string }>;
    /** PC-002b (F1-l): o "agora" simulado do teste. */
    agora?: Date;
  },
) {
  const agent = await loadAgentVersionConfig(
    pool,
    input.organizationId,
    input.agentId,
    input.versionId,
  );
  if (!agent) throw new Error("preview_version_unavailable");
  const result = newPreviewResult();
  // PC-002b (F1-l): com hora simulada, o relógio do turno inteiro é ela — o
  // bloco "## Agora", a janela de atendimento e o horário das mensagens.
  const agora = input.agora ?? deps.clock?.() ?? new Date();
  const depsDoTeste: InboundTurnDeps = input.agora ? { ...deps, clock: () => agora } : deps;
  const context = scenarioContext(
    mensagensDoCenario(input.historico ?? [], input.sampleMessage, agora),
    input.sampleContact,
  );
  await runAgentPreview(depsDoTeste, pool, {
    kind: "sandbox",
    organizationId: input.organizationId,
    runId: input.runId,
    agent,
    context,
    contactId: null,
    channelId: input.channelId,
    result,
  });
  return result;
}

/**
 * A conversa do teste como o turno a leria: o histórico da sessão e, por
 * último, a mensagem nova. Os horários andam para trás de 1 em 1 minuto a
 * partir de `agora` — o modelo lê a ordem e o intervalo, e uma conversa com
 * todas as mensagens no mesmo segundo pareceria uma rajada.
 */
export function mensagensDoCenario(
  historico: ReadonlyArray<{ direcao: "cliente" | "agente"; texto: string }>,
  mensagemNova: string,
  agora: Date,
): Array<{ direction: "inbound" | "outbound"; body: string; sent_at: string }> {
  const total = historico.length;
  const linhas = historico.map((m, i) => ({
    direction: m.direcao === "cliente" ? ("inbound" as const) : ("outbound" as const),
    body: m.texto,
    sent_at: new Date(agora.getTime() - (total - i) * 60_000).toISOString(),
  }));
  return [...linhas, { direction: "inbound", body: mensagemNova, sent_at: agora.toISOString() }];
}
