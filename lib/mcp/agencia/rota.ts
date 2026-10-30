/**
 * O atendimento HTTP comum às duas portas da agência. A rota de cada porta só
 * diz qual porta é; o resto (chave, IP, transporte, erro no envelope JSON-RPC)
 * mora aqui, para as duas portas não divergirem.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { modulosLigados } from "@/lib/instalacao/modulos";
import { McpAuthError } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

import { validarChaveDaAgencia } from "./auth";
import type { PortaDaAgencia } from "./portas";
import { createServidorDaAgencia } from "./server";

function jsonRpcError(code: number, message: string, status: number, requestId: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", "X-Request-Id": requestId },
  });
}

export async function atenderPortaDaAgencia(
  req: Request,
  porta: PortaDaAgencia,
  requestId: string,
): Promise<Response> {
  let chave;
  try {
    chave = await validarChaveDaAgencia(req.headers, porta, ipDoCliente(req.headers));
  } catch (err) {
    if (err instanceof McpAuthError) return jsonRpcError(err.mcpCode, err.message, err.httpStatus, requestId);
    return jsonRpcError(-32603, "auth_failed", 500, requestId);
  }

  const transport = new WebStandardStreamableHTTPServerTransport({});
  const server = createServidorDaAgencia(chave, requestId, await modulosLigados(createAdminClient()));
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(req);
    response.headers.set("X-Request-Id", requestId);
    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "transport_error";
    return jsonRpcError(-32603, msg, 500, requestId);
  }
}
