/**
 * Porta ADMIN da agência — MCP multiempresa (migration 9014).
 *
 * Mesmo transporte de `/api/mcp` (Streamable HTTP, stateless). A diferença está
 * na chave e no servidor: `validarChaveDaAgencia` exige o escopo
 * `agencia:admin`, a origem na lista de IPs da chave e o dono da instalação
 * ainda ativo; `createServidorDaAgencia` só registra a lista fechada de
 * `lib/mcp/agencia/porta-admin.ts` (configuração e negócio por id; nada de
 * conversa, contato ou envio) e exige `organization_id` em cada chamada.
 *
 * O `proxy.ts` deixa passar (`/api/mcp(/.*)?` em `lib/auth/public-paths.ts`):
 * a identidade vem só do Bearer.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { atenderPortaDaAgencia } from "@/lib/mcp/agencia/rota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

async function handle(req: NextRequest): Promise<Response> {
  return atenderPortaDaAgencia(req as unknown as Request, "admin", randomUUID());
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function DELETE(req: NextRequest): Promise<Response> {
  return handle(req);
}
