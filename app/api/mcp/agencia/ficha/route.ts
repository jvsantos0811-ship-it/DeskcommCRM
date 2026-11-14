/**
 * Porta FICHA da agência — o Leitor da conversa pelo Claude (PC-036, migration 9033).
 *
 * Mesmo transporte de `/api/mcp` (Streamable HTTP, stateless). A diferença está
 * na chave e no servidor: `validarChaveDaAgencia` exige o escopo
 * `agencia:ficha`, a origem na lista de IPs da chave e o dono da instalação
 * ainda ativo; `createServidorDaAgencia` só registra as ferramentas de
 * `lib/mcp/agencia/ferramentas-da-ficha.ts` (quem ler, a conversa já montada
 * para o Leitor, gravar a ficha, fechar a rodada) e exige `organization_id` em
 * cada chamada. Organização fora da escolha `claude` é recusada.
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
  return atenderPortaDaAgencia(req as unknown as Request, "ficha", randomUUID());
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
