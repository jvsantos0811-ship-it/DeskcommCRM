/**
 * Servidor MCP das portas da agência (multiempresa).
 *
 * Diferença para `lib/mcp/server.ts` (uma chave = uma organização): aqui a
 * organização vem POR CHAMADA, no argumento `organization_id`, e é conferida
 * contra o banco antes de qualquer coisa. Regras da PM aprovada em 30/10/2026:
 *
 *   - `crm_list_organizations` diz quais organizações existem (id + nome);
 *   - toda outra ferramenta EXIGE `organization_id` — sem ele, erro de validação;
 *     nada de "aplicar em todas" numa chamada só;
 *   - toda resposta traz `organizacao: { id, nome }`, para nenhum número sair
 *     sem origem.
 *
 * O handler de cada ferramenta é o MESMO da rota de sempre, com o `ctx` da
 * organização pedida: o filtro por `organization_id` que todo handler já faz é
 * o que isola uma organização da outra também aqui.
 *
 * Quais ferramentas cada porta vê sai de `ferramentasDaPorta` — a Leitura só
 * recebe as de categoria `read` (nenhuma de escrita é sequer registrada); a
 * Admin recebe a lista fechada de `porta-admin.ts`, com máscara na saída, foto
 * de antes e depois na auditoria e aviso ao dono a cada alteração em empresa
 * cliente.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ModuloOpcional } from "@/lib/instalacao/modulos";
import { capacidadesDaOrganizacao } from "@/lib/organizacao/capacidades";
import { ehOperante } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

import { auditMcpToolCall } from "../audit";
import { McpAuthError, ensureRole, ensureScope, type McpAuthResult } from "../auth";
import { verificarTetoMcp } from "../rate-limit";
import { tamanhoDoResultado } from "../resultado-bytes";
import { allTools } from "../tools";
import { deCapacidadeDesligada, deModuloDesligado } from "../tools/catalog";
import type { McpContext, McpToolDefinition } from "../types";
import { higienizarUuidsDeAterro } from "../uuid-de-aterro";

import { avisarDonoDaAlteracao, enviarAvisoAoDono, resumirAlteracao } from "./alerta";
import { PAPEL_DA_PORTA, type ChaveDaAgenciaValidada } from "./auth";
import { FERRAMENTAS_EXCLUSIVAS_DA_PORTA_ADMIN } from "./ferramentas-do-agente";
import { NUNCA_NA_PORTA_ADMIN, aplicarMascara, regraDaPortaAdmin } from "./porta-admin";
import type { PortaDaAgencia } from "./portas";

const SERVER_NAME = "crm-agencia";
const SERVER_VERSION = "0.1.0";

/** Estados de organização que a agência ainda enxerga (anonimizada e arquivada saem). */
const STATUS_VISIVEIS = ["active", "suspended"] as const;

export const ORGANIZATION_ID_DESCRICAO =
  "Id da organização (escritório) em que esta chamada age. Obrigatório. Pegue em crm_list_organizations.";

/** As ferramentas que a porta registra. Exportada para o teste conferir a fronteira. */
export function ferramentasDaPorta(
  porta: PortaDaAgencia,
  ferramentas: readonly McpToolDefinition[] = allTools,
  exclusivasDaAdmin: readonly McpToolDefinition[] = FERRAMENTAS_EXCLUSIVAS_DA_PORTA_ADMIN,
): McpToolDefinition[] {
  if (porta === "leitura") return ferramentas.filter((t) => t.category === "read");
  // Admin: lista fechada (`porta-admin.ts`) e, por cima, a lista do nunca. As
  // exclusivas (prompt do agente) só existem aqui — não estão em `allTools`.
  const nunca = new Set<string>(NUNCA_NA_PORTA_ADMIN);
  return [...ferramentas, ...exclusivasDaAdmin].filter(
    (t) => regraDaPortaAdmin(t.name) !== null && !nunca.has(t.name),
  );
}

interface OrganizacaoAlvo {
  id: string;
  nome: string;
  operante: boolean;
}

async function organizacaoAlvo(
  db: ReturnType<typeof createAdminClient>,
  id: string,
): Promise<OrganizacaoAlvo> {
  const { data, error } = await db
    .from("organizations")
    .select("id, display_name, status")
    .eq("id", id)
    .in("status", [...STATUS_VISIVEIS])
    .maybeSingle();
  if (error) throw new McpAuthError(-32603, 500, "Organization lookup failed.");
  if (!data) {
    throw new McpAuthError(
      -32602,
      404,
      "Organization not found. Call crm_list_organizations to get a valid organization_id.",
      "organizacao_nao_encontrada",
    );
  }
  return { id: data.id as string, nome: data.display_name as string, operante: ehOperante(data.status as string) };
}

export function createServidorDaAgencia(
  chave: ChaveDaAgenciaValidada,
  requestId: string,
  modulosLigados: readonly ModuloOpcional[] = [],
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const supabase = createAdminClient();
  const papel = PAPEL_DA_PORTA[chave.porta];
  const escoposDaChamada = chave.porta === "leitura" ? ["mcp:read"] : ["mcp:read", "mcp:write"];

  function authDaOrganizacao(organizationId: string): McpAuthResult {
    return {
      organizationId,
      role: papel,
      actor: { type: "api_token", id: chave.apiTokenId, role: papel },
      apiTokenId: chave.apiTokenId,
      scopes: escoposDaChamada,
    };
  }

  function ctxDe(auth: McpAuthResult): McpContext {
    return {
      organizationId: auth.organizationId,
      role: auth.role,
      actor: auth.actor,
      apiTokenId: auth.apiTokenId,
      requestId,
      supabase,
    };
  }

  // ── crm_list_organizations ──────────────────────────────────────────────
  server.registerTool(
    "crm_list_organizations",
    {
      description:
        "Lista as organizações (escritórios) que esta chave alcança: id, nome e se está operando. " +
        "Use o id como organization_id em todas as outras ferramentas.",
      inputSchema: {},
    },
    async () => {
      const startedAt = Date.now();
      const { data, error } = await supabase
        .from("organizations")
        .select("id, display_name, status")
        .in("status", [...STATUS_VISIVEIS])
        .order("display_name", { ascending: true });
      const resultado = error
        ? null
        : {
            organizacoes: (data ?? []).map((o) => ({
              id: o.id as string,
              nome: o.display_name as string,
              operando: ehOperante(o.status as string),
            })),
          };
      // A auditoria precisa de uma organização: a da própria chave.
      await auditMcpToolCall({
        ctx: ctxDe(authDaOrganizacao(chave.organizacaoDaChave)),
        toolName: "crm_list_organizations",
        args: {},
        durationMs: Date.now() - startedAt,
        success: !error,
        portaDaAgencia: chave.porta,
        ...(error ? { errorMessage: error.message } : {}),
        ...(resultado ? { resultSummary: `${resultado.organizacoes.length} organizations` } : {}),
      });
      if (!resultado) return { isError: true, content: [{ type: "text" as const, text: "Organization list failed." }] };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(resultado) }],
        structuredContent: resultado,
      };
    },
  );

  // ── as ferramentas do CRM, com organization_id obrigatório ───────────────
  for (const tool of ferramentasDaPorta(chave.porta)) {
    if (deModuloDesligado(tool.name, modulosLigados)) continue;
    const shape = {
      organization_id: z.string().uuid().describe(ORGANIZATION_ID_DESCRICAO),
      ...tool.inputSchema,
    };
    server.registerTool(
      tool.name,
      { description: `${tool.description}\n\nPorta da agência: informe organization_id.`, inputSchema: shape },
      async (rawArgs) => {
        const startedAt = Date.now();
        const { organization_id: organizationId, ...resto } = (rawArgs ?? {}) as Record<string, unknown>;
        const higiene = higienizarUuidsDeAterro(tool.inputSchema as Record<string, z.ZodTypeAny>, resto);
        const args = higiene.limpos;
        const argsAudit = tool.redigirParaAuditoria ? tool.redigirParaAuditoria(args) : args;
        const auth = authDaOrganizacao(String(organizationId));
        const ctx = ctxDe(auth);
        // Até a organização ser conferida, a auditoria vai na organização da
        // chave: um id que não existe estouraria a FK de `api_audit_log` e a
        // tentativa ficaria sem rastro.
        let ctxDaAuditoria = ctxDe(authDaOrganizacao(chave.organizacaoDaChave));

        try {
          await verificarTetoMcp(auth, tool.category);
          const org = await organizacaoAlvo(supabase, auth.organizationId);
          ctxDaAuditoria = ctx;
          if (!org.operante && !tool.permiteOrgSuspensa) {
            throw new McpAuthError(
              -32002,
              403,
              "Organization suspended: only privacy (LGPD) tools answer until the account is reactivated.",
              "org_suspended",
            );
          }
          if (deCapacidadeDesligada(tool.name, await capacidadesDaOrganizacao(supabase, org.id))) {
            throw new McpAuthError(-32002, 403, "This capability is turned off in this organization.");
          }
          ensureScope(auth.scopes, tool.requiresScope);
          ensureRole(auth.role, tool.requiresRole);

          // Porta Admin: foto do alvo antes, máscara na saída, foto depois.
          const regra = chave.porta === "admin" ? regraDaPortaAdmin(tool.name) : null;
          const ehEscrita = tool.category !== "read";
          const antes = regra?.foto && ehEscrita ? await regra.foto(supabase, org.id, args) : undefined;

          const bruto = await tool.handler(args as never, ctx);
          const motivoDoVazio = tool.motivoDoVazio?.(bruto) ?? null;
          const result = regra?.projetar ? aplicarMascara(bruto, regra.projetar) : bruto;
          const resposta = { organizacao: { id: org.id, nome: org.nome }, resultado: result };
          const depois = regra?.foto && ehEscrita ? await regra.foto(supabase, org.id, args) : undefined;

          await auditMcpToolCall({
            ctx,
            toolName: tool.name,
            args: argsAudit,
            durationMs: Date.now() - startedAt,
            success: motivoDoVazio === null,
            resultBytes: tamanhoDoResultado(resposta),
            portaDaAgencia: chave.porta,
            ...(regra && ehEscrita ? { antesEDepois: { antes, depois } } : {}),
            ...(motivoDoVazio === null ? {} : { desfecho: "sem_resultado" as const, motivo: motivoDoVazio }),
          });

          // Aviso próprio da ferramenta (pedido de publicação): sempre.
          // Senão, alteração em empresa CLIENTE (não a da agência): aviso genérico.
          if (regra?.aviso) {
            void enviarAvisoAoDono(supabase, chave.criadaPor, regra.aviso({ id: org.id, nome: org.nome }, bruto));
          } else if (chave.porta === "admin" && ehEscrita && org.id !== chave.organizacaoDaChave) {
            void avisarDonoDaAlteracao(supabase, {
              criadaPor: chave.criadaPor,
              organizacao: { id: org.id, nome: org.nome },
              resumo: resumirAlteracao(tool.name, args),
              requestId,
            });
          }

          return {
            content: [{ type: "text" as const, text: JSON.stringify(resposta) }],
            structuredContent: resposta as Record<string, unknown>,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "unknown_error";
          await auditMcpToolCall({
            ctx: ctxDaAuditoria,
            toolName: tool.name,
            args: { organization_id: organizationId, ...argsAudit },
            durationMs: Date.now() - startedAt,
            success: false,
            errorMessage: message,
            portaDaAgencia: chave.porta,
          });
          return { isError: true, content: [{ type: "text" as const, text: message }] };
        }
      },
    );
  }

  return server;
}
