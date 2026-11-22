/**
 * POST /api/v1/webhooks/channel/[token]/[segredo] — a mesma entrada por token,
 * para o canal que não consegue assinar nem mandar cabeçalho.
 *
 * Há plataforma (a de atendimento em que a IA trabalha por dentro, PC-047) cujo
 * disparo só aceita uma URL: sem assinatura, sem cabeçalho próprio. Para ela, o
 * segredo da conexão viaja no CAMINHO, como segundo segmento, e esta rota o
 * entrega à rota de sempre no cabeçalho que a conferência do canal lê.
 *
 * Nada muda para os outros canais: cada um confere a SUA assinatura, e quem não
 * lê este cabeçalho o ignora. O segmento extra também não vira atalho — a rota
 * de sempre só aceita o que a conferência do canal da sessão aprovar, e
 * qualquer cabeçalho com o mesmo nome que já viesse no pedido é SOBRESCRITO pelo
 * segmento, nunca somado a ele.
 *
 * Por que o caminho e não a query string: query string vaza em log de proxy e de
 * CDN com mais facilidade, e a regra da casa é segredo fora dela. O caminho já
 * carrega o token desde sempre; o segredo vai ao lado dele.
 */
import { NextRequest } from "next/server";

import { HEADER_DO_SEGREDO } from "@/lib/channels/atendimento-externo/entrada";

import { POST as receberPeloToken } from "../route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string; segredo: string }> },
): Promise<Response> {
  const { token, segredo } = await ctx.params;
  const headers = new Headers(req.headers);
  headers.set(HEADER_DO_SEGREDO, segredo ?? "");
  const repassado = new NextRequest(req.url, {
    method: "POST",
    headers,
    body: await req.text(),
  });
  return receberPeloToken(repassado, { params: Promise.resolve({ token }) });
}
