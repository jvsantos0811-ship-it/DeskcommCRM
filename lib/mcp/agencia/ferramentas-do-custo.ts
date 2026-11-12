/**
 * FERRAMENTA DE CUSTO POR RESPOSTA — só na porta Leitura da agência (PC-035).
 *
 * O Gestor mede o custo de cada resposta da IA antes e depois de uma mudança,
 * por organização e janela de tempo. A conta sai de `llm_calls` (só números e
 * nomes de ferramenta) e mora em `lib/ai/usage/custo-por-resposta.ts`.
 *
 * FORA de `allTools`, como as ferramentas do prompt do agente: o custo de IA de
 * cada escritório é assunto de quem revende, não da chave de integração de cada
 * empresa nem dos agentes de atendimento.
 */
import { z } from "zod";

import { resumirCustoPorResposta, type LinhaDeChamada } from "@/lib/ai/usage/custo-por-resposta";

import type { McpToolDefinition } from "../types";

/** Teto de linhas lidas por chamada: a janela maior que isso é recusada com instrução. */
const TETO_DE_LINHAS = 20_000;
const PAGINA = 1_000;
const JANELA_MAXIMA_DIAS = 31;

const COLUNAS =
  "id, job_id, agent_id, purpose, model, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, latency_ms, passadas, created_at";

const shape = {
  desde: z
    .string()
    .datetime({ offset: true })
    .describe("Início da janela, ISO 8601 com fuso (ex.: 2026-11-13T00:00:00-03:00)."),
  ate: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("Fim da janela, ISO 8601 com fuso. Ausente = agora."),
  agent_id: z
    .string()
    .uuid()
    .optional()
    .describe("Só as respostas deste agente (id de crm_list_ai_agents). Ausente = todos."),
};

class FalhaDoCusto extends Error {
  constructor(
    public readonly codigo: string,
    message: string,
  ) {
    super(`${codigo}: ${message}`);
    this.name = "FalhaDoCusto";
  }
}

export const crmGetAiCostByResponse: McpToolDefinition<typeof shape> = {
  name: "crm_get_ai_cost_by_response",
  description:
    "Custo de IA por resposta do agente numa janela de tempo, para medir antes e depois de uma mudança. " +
    "Devolve: quantas respostas, custo médio por resposta (centavos de dólar, com as chamadas auxiliares do " +
    "mesmo turno), e do laço do agente a média de passadas, tokens de entrada, lidos do cache, gravados no " +
    "cache (de 5 minutos e de 1 hora), tokens de saída, tempo, o custo pela tarifa real e o custo se toda a " +
    "gravação fosse a 1 hora; a distribuição por número de passadas; o consumo médio de cada passada; em " +
    "quantas respostas cada ferramenta foi pedida; e o gasto por tipo de chamada. Só números e nomes de " +
    "ferramenta: nenhum texto de conversa. O detalhe por passada existe a partir da versão que o grava. " +
    `Janela de até ${JANELA_MAXIMA_DIAS} dias.`,
  inputSchema: shape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const desde = new Date(input.desde);
    const ate = input.ate ? new Date(input.ate) : new Date();
    if (!(desde.getTime() < ate.getTime())) {
      throw new FalhaDoCusto("validation_failed", "`desde` tem de ser anterior a `ate`.");
    }
    if (ate.getTime() - desde.getTime() > JANELA_MAXIMA_DIAS * 24 * 3600_000) {
      throw new FalhaDoCusto("validation_failed", `Janela de no máximo ${JANELA_MAXIMA_DIAS} dias. Consulte em partes.`);
    }

    const linhas: LinhaDeChamada[] = [];
    for (let de = 0; de < TETO_DE_LINHAS; de += PAGINA) {
      let consulta = ctx.supabase
        .from("llm_calls")
        .select(COLUNAS)
        .eq("organization_id", ctx.organizationId)
        .gte("created_at", desde.toISOString())
        .lt("created_at", ate.toISOString())
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(de, de + PAGINA - 1);
      // Com agente, só o laço dele: as auxiliares não carregam `agent_id`.
      if (input.agent_id) consulta = consulta.eq("agent_id", input.agent_id);
      const { data, error } = await consulta;
      if (error) throw new FalhaDoCusto("internal_error", error.message.slice(0, 160));
      const pagina = (data ?? []) as unknown as LinhaDeChamada[];
      linhas.push(...pagina);
      if (pagina.length < PAGINA) break;
    }
    if (linhas.length >= TETO_DE_LINHAS) {
      throw new FalhaDoCusto(
        "janela_grande_demais",
        `A janela tem mais de ${TETO_DE_LINHAS} chamadas. Reduza a janela ou filtre por agente.`,
      );
    }

    return {
      janela: { desde: desde.toISOString(), ate: ate.toISOString() },
      agente: input.agent_id ?? null,
      // Com filtro de agente o custo por resposta é só o do laço (as auxiliares
      // do turno não têm agente gravado): o aviso evita ler o número como total.
      ...(input.agent_id
        ? { aviso: "Com agent_id, as chamadas auxiliares do turno ficam de fora: custo_por_resposta_cents é só o laço do agente." }
        : {}),
      ...resumirCustoPorResposta(linhas),
    };
  },
};

/** Exclusivas da porta Leitura (fora de `allTools`). */
export const FERRAMENTAS_EXCLUSIVAS_DA_PORTA_LEITURA: readonly McpToolDefinition[] = [
  crmGetAiCostByResponse as unknown as McpToolDefinition,
];
