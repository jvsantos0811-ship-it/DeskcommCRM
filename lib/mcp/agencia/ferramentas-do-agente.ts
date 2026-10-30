/**
 * FERRAMENTAS DO PROMPT DO AGENTE — só na porta Admin da agência.
 *
 * PM das duas portas, item 4.1: "publicar prompt em rascunho primeiro: vai ao
 * ar só com confirmação, e a versão anterior fica guardada para voltar com um
 * clique". A confirmação é do dono, na tela (regra do projeto: "o Claude nunca
 * publica sem o OK do dono"), então:
 *
 *   - `crm_list_ai_agents` e `crm_get_ai_agent_prompt` LEEM;
 *   - `crm_save_ai_agent_draft` grava o prompt num RASCUNHO (nunca na versão
 *     publicada, que o banco já trava — `fn_ai_agent_version_content_immutable`);
 *   - `crm_request_ai_agent_publish` NÃO publica: registra o pedido e avisa o
 *     dono, com o link da tela onde ele aperta "Publicar";
 *   - `crm_revert_ai_agent_version` volta a uma versão que JÁ ESTEVE no ar —
 *     copia e publica, exatamente como o botão "Reverter" do Histórico.
 *
 * POR QUE FORA DE `allTools`. Estas ferramentas mexem no prompt do próprio
 * agente. Em `allTools` elas entrariam no `/api/mcp` de toda chave comum e na
 * lista que o runtime oferece aos agentes de atendimento — um agente
 * reescrevendo o próprio prompt. Aqui elas só existem na porta Admin.
 *
 * Toda a lógica é a das telas, reaproveitada: `escolherVersoesDaTela` (qual é o
 * rascunho, qual está no ar), `versionPayloadFrom` (a cópia completa da
 * versão), `validarEscopoDaVersao`, `publishAgentVersion`.
 */
import { z } from "zod";

import { codigoDoEscopo, mensagemDoEscopo, validarEscopoDaVersao } from "@/lib/ai/agents/escopo";
import { versionPayloadFrom } from "@/lib/ai/agents/duplicate";
import { estadoDoAgente } from "@/lib/ai/agents/no-ar";
import { publishAgentVersion } from "@/lib/ai/agents/publish";
import { versionPatchSchema } from "@/lib/ai/agents/validation";
import { escolherVersoesDaTela } from "@/lib/ai/agents/versoes-da-tela";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { lerAmbiente } from "@/lib/instalacao/ambiente";
import { toolIdAceito } from "@/lib/mcp/servidor-externo/ids";
import { VALID_TOOL_IDS } from "@/lib/mcp/tools";

import type { McpContext, McpToolDefinition } from "../types";

class FalhaDoAgente extends Error {
  constructor(
    public readonly codigo: string,
    message: string,
  ) {
    super(`${codigo}: ${message}`);
    this.name = "FalhaDoAgente";
  }
}

const COLUNAS_DA_VERSAO_NA_LISTA = "id, version_number, status, created_at, published_at";

interface VersaoNaLista {
  id: string;
  version_number: number;
  status: string;
  created_at: string;
  published_at: string | null;
}

async function agenteDaOrganizacao(ctx: McpContext, agentId: string) {
  const { data, error } = await ctx.supabase
    .from("ai_agents")
    .select("id, name, archived_at, paused_at, published_version_id")
    .eq("organization_id", ctx.organizationId)
    .eq("id", agentId)
    .maybeSingle();
  if (error) throw new FalhaDoAgente("internal_error", error.message);
  if (!data) throw new FalhaDoAgente("not_found", "Agente não encontrado nesta organização.");
  return data as { id: string; name: string; archived_at: string | null; paused_at: string | null; published_version_id: string | null };
}

async function versoesDoAgente(ctx: McpContext, agentId: string): Promise<VersaoNaLista[]> {
  const { data, error } = await ctx.supabase
    .from("ai_agent_versions")
    .select(COLUNAS_DA_VERSAO_NA_LISTA)
    .eq("organization_id", ctx.organizationId)
    .eq("agent_id", agentId)
    .order("version_number", { ascending: false });
  if (error) throw new FalhaDoAgente("internal_error", error.message);
  return (data ?? []) as VersaoNaLista[];
}

async function versaoCompleta(ctx: McpContext, agentId: string, versionId: string): Promise<Record<string, unknown>> {
  const { data, error } = await ctx.supabase
    .from("ai_agent_versions")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("agent_id", agentId)
    .eq("id", versionId)
    .maybeSingle();
  if (error) throw new FalhaDoAgente("internal_error", error.message);
  if (!data) throw new FalhaDoAgente("version_not_found", "Versão não encontrada neste agente.");
  return data as Record<string, unknown>;
}

/** Grava uma versão nova (rascunho) copiada de `origem`, com o próximo número. */
async function gravarCopiaComoRascunho(
  ctx: McpContext,
  agentId: string,
  origem: Record<string, unknown>,
  sobrescrever: { system_prompt?: string },
): Promise<{ id: string; version_number: number }> {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const { data: maior } = await ctx.supabase
      .from("ai_agent_versions")
      .select("version_number")
      .eq("organization_id", ctx.organizationId)
      .eq("agent_id", agentId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const proximo = ((maior?.version_number as number | undefined) ?? 0) + 1;

    const { data, error } = await ctx.supabase
      .from("ai_agent_versions")
      .insert({
        ...versionPayloadFrom(origem),
        ...sobrescrever,
        organization_id: ctx.organizationId,
        agent_id: agentId,
        version_number: proximo,
        status: "draft",
        created_by: null,
      })
      .select("id, version_number")
      .single();
    if (!error && data) return { id: data.id as string, version_number: data.version_number as number };
    if (error?.code !== "23505") throw new FalhaDoAgente("internal_error", error?.message ?? "insert_failed");
  }
  throw new FalhaDoAgente("internal_error", "Conflito de numeração de versão; tente de novo.");
}

/** As conferências que a tela faz antes de gravar ou publicar uma versão. */
async function conferirVersao(ctx: McpContext, versao: Record<string, unknown>): Promise<void> {
  const provider = String(versao.provider);
  if (versao.credential_id === null && lerAmbiente().chavesDeProvedor[provider] !== true) {
    throw new FalhaDoAgente(
      "credential_required",
      `Esta instalação não tem chave de ${provider} no ambiente; a versão precisa de uma credencial.`,
    );
  }
  const escopo = await validarEscopoDaVersao(ctx.supabase, ctx.organizationId, { provider });
  if (!escopo.ok) throw new FalhaDoAgente(codigoDoEscopo(escopo), mensagemDoEscopo(escopo));
}

function auditoriaDoToken(ctx: McpContext) {
  return {
    actorUserId: null,
    actorApiTokenId: ctx.apiTokenId,
    organizationId: ctx.organizationId,
    resourceType: "ai_agent" as const,
    requestId: ctx.requestId,
  };
}

export function linkDoAgente(agentId: string): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/app/ai/agents/${agentId}`;
}

// ── crm_list_ai_agents ─────────────────────────────────────────────────────

const listarShape = {
  incluir_arquivados: z.boolean().default(false),
};

export const crmListAiAgents: McpToolDefinition<typeof listarShape> = {
  name: "crm_list_ai_agents",
  description:
    "Lista os agentes de IA da organização: id, nome, estado (no_ar, parado, arquivado), número da versão " +
    "publicada, modelo em uso e se há rascunho esperando publicação.",
  inputSchema: listarShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    let q = ctx.supabase
      .from("ai_agents")
      .select(
        "id, name, archived_at, paused_at, published_version_id, " +
          "versao_publicada:ai_agent_versions!ai_agents_published_version_id_fkey(version_number, provider, model)",
      )
      .eq("organization_id", ctx.organizationId)
      .order("created_at", { ascending: false });
    if (!input.incluir_arquivados) q = q.is("archived_at", null);
    const { data, error } = await q;
    if (error) throw new FalhaDoAgente("internal_error", error.message);

    const agentes = await Promise.all(
      ((data ?? []) as unknown as Array<Record<string, unknown>>).map(async (a) => {
        const versoes = await versoesDoAgente(ctx, a.id as string);
        const tela = escolherVersoesDaTela(versoes, (a.published_version_id as string | null) ?? null);
        const pub = (Array.isArray(a.versao_publicada) ? a.versao_publicada[0] : a.versao_publicada) as
          | { version_number: number; provider: string; model: string }
          | null;
        return {
          id: a.id,
          nome: a.name,
          estado: estadoDoAgente({
            archived_at: (a.archived_at as string | null) ?? null,
            paused_at: (a.paused_at as string | null) ?? null,
            published_version_id: (a.published_version_id as string | null) ?? null,
          }),
          versao_publicada: pub?.version_number ?? null,
          modelo: pub ? `${pub.provider}/${pub.model}` : null,
          rascunho: tela.draft ? { id: tela.draft.id, numero: tela.draft.version_number } : null,
        };
      }),
    );
    return { agentes };
  },
};

// ── crm_get_ai_agent_prompt ────────────────────────────────────────────────

const lerShape = {
  agent_id: z.string().uuid(),
};

export const crmGetAiAgentPrompt: McpToolDefinition<typeof lerShape> = {
  name: "crm_get_ai_agent_prompt",
  description:
    "Lê o prompt de um agente: a versão PUBLICADA (no ar) e o RASCUNHO em aberto, se houver, com o texto " +
    "inteiro de cada um, mais o histórico de versões (número, situação, datas) para escolher para onde voltar.",
  inputSchema: lerShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const agente = await agenteDaOrganizacao(ctx, input.agent_id);
    const versoes = await versoesDoAgente(ctx, agente.id);
    const tela = escolherVersoesDaTela(versoes, agente.published_version_id);
    const texto = async (v: VersaoNaLista | null) =>
      v
        ? {
            id: v.id,
            numero: v.version_number,
            system_prompt: (await versaoCompleta(ctx, agente.id, v.id)).system_prompt as string,
          }
        : null;
    return {
      agente: { id: agente.id, nome: agente.name },
      publicada: await texto(tela.published),
      rascunho: await texto(tela.draft),
      rascunho_desatualizado: tela.draftObsoleto
        ? { id: tela.draftObsoleto.id, numero: tela.draftObsoleto.version_number }
        : null,
      historico: versoes.map((v) => ({
        id: v.id,
        numero: v.version_number,
        situacao: v.status,
        criada_em: v.created_at,
        publicada_em: v.published_at,
        pode_voltar_para_ela: v.published_at !== null && v.id !== agente.published_version_id,
      })),
    };
  },
};

// ── crm_save_ai_agent_draft ────────────────────────────────────────────────

const rascunhoShape = {
  agent_id: z.string().uuid(),
  system_prompt: z.string().trim().min(10).max(20_000),
};

export const crmSaveAiAgentDraft: McpToolDefinition<typeof rascunhoShape> = {
  name: "crm_save_ai_agent_draft",
  description:
    "Grava o prompt num RASCUNHO do agente — nunca na versão que está no ar. Se já há rascunho em aberto, " +
    "ele é atualizado; senão nasce um rascunho novo, cópia da versão atual com o prompt novo. O rascunho NÃO " +
    "vai ao ar: depois de gravar, peça a publicação com crm_request_ai_agent_publish (quem publica é o dono, na tela).",
  inputSchema: rascunhoShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const agente = await agenteDaOrganizacao(ctx, input.agent_id);
    if (agente.archived_at) throw new FalhaDoAgente("agent_archived", "Agente arquivado.");
    const versoes = await versoesDoAgente(ctx, agente.id);
    const tela = escolherVersoesDaTela(versoes, agente.published_version_id);

    if (tela.draft) {
      const patch = versionPatchSchema.parse({ system_prompt: input.system_prompt });
      const { error } = await ctx.supabase
        .from("ai_agent_versions")
        .update({ system_prompt: patch.system_prompt })
        .eq("organization_id", ctx.organizationId)
        .eq("agent_id", agente.id)
        .eq("id", tela.draft.id)
        .eq("status", "draft");
      if (error) throw new FalhaDoAgente("internal_error", error.message);
      void audit({
        ...auditoriaDoToken(ctx),
        action: "ai_agent.version_updated",
        resourceId: agente.id,
        metadata: { agent_id: agente.id, version_id: tela.draft.id, fields: ["system_prompt"], via: "porta_admin_da_agencia" },
      });
      return { rascunho: { id: tela.draft.id, numero: tela.draft.version_number }, criado: false, no_ar: false };
    }

    if (!tela.base) throw new FalhaDoAgente("no_version", "O agente não tem versão nenhuma para copiar.");
    const origem = await versaoCompleta(ctx, agente.id, tela.base.id);
    await conferirVersao(ctx, origem);
    const novo = await gravarCopiaComoRascunho(ctx, agente.id, origem, { system_prompt: input.system_prompt });
    void audit({
      ...auditoriaDoToken(ctx),
      action: "ai_agent.version_created",
      resourceId: agente.id,
      metadata: { agent_id: agente.id, version_number: novo.version_number, copiada_de: tela.base.id, via: "porta_admin_da_agencia" },
    });
    return { rascunho: { id: novo.id, numero: novo.version_number }, criado: true, no_ar: false };
  },
};

// ── crm_request_ai_agent_publish ───────────────────────────────────────────

const pedidoShape = {
  agent_id: z.string().uuid(),
  motivo: z.string().trim().min(10).max(1000).describe("O que muda e por quê — vai no aviso ao dono."),
};

export const crmRequestAiAgentPublish: McpToolDefinition<typeof pedidoShape> = {
  name: "crm_request_ai_agent_publish",
  description:
    "Pede ao dono que publique o rascunho em aberto do agente. NÃO publica: registra o pedido e manda ao dono " +
    "um aviso com o link da tela do agente, onde ele confere e aperta Publicar. Exige rascunho em aberto.",
  inputSchema: pedidoShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const agente = await agenteDaOrganizacao(ctx, input.agent_id);
    if (agente.archived_at) throw new FalhaDoAgente("agent_archived", "Agente arquivado.");
    const tela = escolherVersoesDaTela(await versoesDoAgente(ctx, agente.id), agente.published_version_id);
    if (!tela.draft) {
      throw new FalhaDoAgente("no_draft", "Não há rascunho em aberto. Grave o prompt com crm_save_ai_agent_draft antes.");
    }
    const resultado = {
      pedido: "registrado",
      agente: { id: agente.id, nome: agente.name },
      rascunho: { id: tela.draft.id, numero: tela.draft.version_number },
      versao_no_ar: tela.published?.version_number ?? null,
      link_para_publicar: linkDoAgente(agente.id),
      motivo: input.motivo,
    };
    void audit({
      ...auditoriaDoToken(ctx),
      action: "ai_agent.publicacao_pedida",
      resourceId: agente.id,
      metadata: {
        agent_id: agente.id,
        version_id: tela.draft.id,
        version_number: tela.draft.version_number,
        motivo: input.motivo,
        via: "porta_admin_da_agencia",
      },
    });
    return resultado;
  },
};

// ── crm_revert_ai_agent_version ────────────────────────────────────────────

const voltarShape = {
  agent_id: z.string().uuid(),
  version_id: z.string().uuid().describe("Uma versão que JÁ ESTEVE no ar (pode_voltar_para_ela em crm_get_ai_agent_prompt)."),
};

export const crmRevertAiAgentVersion: McpToolDefinition<typeof voltarShape> = {
  name: "crm_revert_ai_agent_version",
  description:
    "Volta o agente para uma versão que já esteve no ar: copia aquela versão como versão nova e a publica — " +
    "o mesmo que o botão Reverter do Histórico. Só aceita versão que já foi publicada antes; rascunho nunca " +
    "publicado não passa por aqui (esse vai pelo pedido de publicação).",
  inputSchema: voltarShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const agente = await agenteDaOrganizacao(ctx, input.agent_id);
    if (agente.archived_at) throw new FalhaDoAgente("agent_archived", "Agente arquivado.");
    const origem = await versaoCompleta(ctx, agente.id, input.version_id);
    if (!origem.published_at) {
      throw new FalhaDoAgente("never_published", "Esta versão nunca esteve no ar; peça a publicação ao dono.");
    }
    if (origem.id === agente.published_version_id) {
      throw new FalhaDoAgente("already_live", "Esta versão já é a que está no ar.");
    }
    const validos = new Set<string>(VALID_TOOL_IDS as readonly string[]);
    const invalidas = ((origem.tool_ids as string[] | null) ?? []).filter((t) => !toolIdAceito(t, validos));
    if (invalidas.length > 0) {
      throw new FalhaDoAgente("tool_id_invalid", `Ferramentas que não existem mais: ${invalidas.join(", ")}`);
    }
    await conferirVersao(ctx, origem);

    const nova = await gravarCopiaComoRascunho(ctx, agente.id, origem, {});
    const publicada = await publishAgentVersion(ctx.supabase, {
      orgId: ctx.organizationId,
      agentId: agente.id,
      versionId: nova.id,
      quemPublicou: { actorApiTokenId: ctx.apiTokenId, requestId: ctx.requestId },
    });
    if (!publicada.ok) {
      await ctx.supabase
        .from("ai_agent_versions")
        .delete()
        .eq("organization_id", ctx.organizationId)
        .eq("id", nova.id)
        .eq("status", "draft");
      throw new FalhaDoAgente(publicada.code, publicada.message);
    }

    void ctx.supabase
      .from("event_log")
      .insert({
        organization_id: ctx.organizationId,
        event_type: "ai_agent.published",
        entity_kind: "ai_agent",
        payload: {
          agent_id: publicada.agent_id,
          version_id: publicada.version_id,
          previous_version_id: publicada.previous_version_id,
          published_at: publicada.published_at,
        },
      })
      .then(() => undefined);
    void audit({
      ...auditoriaDoToken(ctx),
      action: "ai_agent.reverted",
      resourceId: agente.id,
      metadata: {
        from_version_id: input.version_id,
        new_version_id: nova.id,
        new_version_number: nova.version_number,
        previous_version_id: publicada.previous_version_id,
        via: "porta_admin_da_agencia",
      },
    });
    return {
      no_ar: { id: nova.id, numero: nova.version_number, copia_de: input.version_id },
      versao_anterior: publicada.previous_version_id,
    };
  },
};

/** As ferramentas que SÓ a porta Admin registra (não estão em `allTools`). */
export const FERRAMENTAS_EXCLUSIVAS_DA_PORTA_ADMIN: readonly McpToolDefinition[] = [
  crmListAiAgents as unknown as McpToolDefinition,
  crmGetAiAgentPrompt as unknown as McpToolDefinition,
  crmSaveAiAgentDraft as unknown as McpToolDefinition,
  crmRequestAiAgentPublish as unknown as McpToolDefinition,
  crmRevertAiAgentVersion as unknown as McpToolDefinition,
];
