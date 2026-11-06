/**
 * FERRAMENTAS DO FUNIL DE CADA NÚMERO — só na porta Admin da agência.
 *
 * Briefing do Operador de 06/11/2026: cada número da empresa escolhe se a
 * conversa nova abre card no funil e em qual funil/etapa (migration 9025). Com
 * estas duas ferramentas o Operador configura empresa nova sem depender da tela:
 *
 *   - `crm_list_channel_numbers` LÊ os números (conexões) da empresa, o ajuste
 *     de cada um e ONDE os cards nascem hoje — a mesma resposta da tela;
 *   - `crm_set_channel_entry_funnel` GRAVA o ajuste de um número, com a mesma
 *     conferência da tela (`lib/channels/funil-do-numero.ts`).
 *
 * Nenhuma das duas lê conversa, mensagem ou contato: só a configuração da
 * conexão (nome interno, telefone do escritório, situação) e os funis.
 *
 * POR QUE FORA DE `allTools`. Ajustar o funil de um número é configuração da
 * agência, não do atendimento: em `allTools` a ferramenta entraria no
 * `/api/mcp` de toda chave comum e na lista oferecida aos agentes de IA — um
 * agente de atendimento desligando o card do próprio número. Aqui ela só existe
 * na porta Admin, que já grava antes e depois na auditoria e avisa o dono.
 */
import { z } from "zod";

import { audit } from "@/lib/audit";
import { gravarFunilDoNumero, numerosComFunil, retratoDoFunilDoNumero } from "@/lib/channels/funil-do-numero";

import type { McpToolDefinition } from "../types";

class FalhaDoNumero extends Error {
  constructor(
    public readonly codigo: string,
    message: string,
  ) {
    super(`${codigo}: ${message}`);
    this.name = "FalhaDoNumero";
  }
}

// ── crm_list_channel_numbers ───────────────────────────────────────────────

const listarShape = {};

export const crmListChannelNumbers: McpToolDefinition<typeof listarShape> = {
  name: "crm_list_channel_numbers",
  description:
    "Lista os números (conexões não arquivadas) da organização com o ajuste de funil de cada um: abre_card " +
    "(se a conversa nova vira card), funil_id/etapa_id escolhidos (null = funil padrão / primeira etapa), " +
    "destino (onde os cards nascem hoje, com nomes) e aviso (ex.: funil escolhido arquivado). Traz também " +
    "a lista de funis abertos com as etapas, para escolher.",
  inputSchema: listarShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => {
    try {
      return await numerosComFunil(ctx.supabase, ctx.organizationId);
    } catch (err) {
      throw new FalhaDoNumero("internal_error", err instanceof Error ? err.message.slice(0, 160) : "falha ao listar");
    }
  },
};

// ── crm_set_channel_entry_funnel ───────────────────────────────────────────

const gravarShape = {
  channel_session_id: z.string().uuid().describe("Id do número, de crm_list_channel_numbers."),
  abre_card: z.boolean().describe("true: conversa nova por este número vira card no funil. false: só a conversa entra."),
  funil_id: z
    .string()
    .uuid()
    .nullable()
    .default(null)
    .describe("Funil de entrada. null = funil padrão da empresa. Precisa ser funil aberto desta organização."),
  etapa_id: z
    .string()
    .uuid()
    .nullable()
    .default(null)
    .describe("Etapa de entrada dentro de funil_id. null = primeira etapa aberta. Só com funil_id."),
};

export const crmSetChannelEntryFunnel: McpToolDefinition<typeof gravarShape> = {
  name: "crm_set_channel_entry_funnel",
  description:
    "Grava o ajuste de funil de UM número: abre_card (sim/não), funil_id e etapa_id (null = padrão). Vale para " +
    "as conversas NOVAS que chegam por ele; cards que já existem não mudam de lugar. Campanha com funil próprio " +
    "e cliente que volta continuam com as regras deles. Devolve o ajuste gravado e onde os cards nascem agora.",
  inputSchema: gravarShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    if (input.etapa_id && !input.funil_id) {
      throw new FalhaDoNumero("validation_failed", "etapa_id só com funil_id.");
    }
    const gravado = await gravarFunilDoNumero(ctx.supabase, ctx.organizationId, input.channel_session_id, {
      abre_card: input.abre_card,
      funil_id: input.funil_id ?? null,
      etapa_id: input.etapa_id ?? null,
    });
    if (!gravado.ok) {
      const codigo =
        gravado.codigo === "nao_encontrado"
          ? "not_found"
          : gravado.codigo === "erro"
            ? "internal_error"
            : "validation_failed";
      throw new FalhaDoNumero(codigo, gravado.mensagem);
    }
    void audit({
      actorUserId: null,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "channel_session",
      resourceId: input.channel_session_id,
      requestId: ctx.requestId,
      action: "channel.entry_funnel_updated",
      metadata: { antes: gravado.antes, depois: gravado.depois, via: "porta_admin_da_agencia" },
    });
    const retrato = await retratoDoFunilDoNumero(ctx.supabase, ctx.organizationId, input.channel_session_id).catch(
      () => null,
    );
    return {
      numero: input.channel_session_id,
      gravado: gravado.depois,
      antes: gravado.antes,
      destino: retrato?.destino ?? null,
      aviso: retrato?.aviso ?? null,
    };
  },
};

/** As ferramentas do funil do número que SÓ a porta Admin registra (não estão em `allTools`). */
export const FERRAMENTAS_DO_NUMERO_NA_PORTA_ADMIN: readonly McpToolDefinition[] = [
  crmListChannelNumbers as unknown as McpToolDefinition,
  crmSetChannelEntryFunnel as unknown as McpToolDefinition,
];
