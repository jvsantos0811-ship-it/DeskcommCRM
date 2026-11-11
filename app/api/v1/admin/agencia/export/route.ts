/**
 * GET /api/v1/admin/agencia/export?formato=xlsx|csv — a tabela do painel da
 * agência em planilha (PC-028). Só o dono da instalação; só números agregados;
 * cada exportação vai para a auditoria (`agencia.exported`: quem, quando,
 * período, formato e linhas).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { montarPainelDaAgencia } from "@/lib/agencia/ler";
import { periodoDaAgencia } from "@/lib/agencia/periodo-da-agencia";
import { planilhaDaAgencia } from "@/lib/agencia/planilha";
import { csvDaPlanilha } from "@/lib/funil/exportar";
import { gerarXlsx } from "@/lib/planilha/xlsx";
import { createAdminClient } from "@/lib/supabase/admin";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }
  const p = req.nextUrl.searchParams;
  const formato = p.get("formato") === "csv" ? "csv" : "xlsx";
  const { periodo, hoje } = periodoDaAgencia(p);
  const painel = await montarPainelDaAgencia(createAdminClient(), {
    periodo,
    hoje,
    agora: new Date(),
    nomes: nomesDosAtendentes,
  });
  const { cabecalho, linhas } = planilhaDaAgencia(painel.clientes);
  await audit({
    action: "agencia.exported",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    resourceType: "agencia_painel",
    requestId,
    metadata: { formato, de: periodo.de, ate: periodo.ate, linhas: linhas.length },
  });
  const conteudo =
    formato === "xlsx"
      ? gerarXlsx("Agência", cabecalho, linhas)
      : new TextEncoder().encode(csvDaPlanilha(cabecalho, linhas));
  return new Response(conteudo as BodyInit, {
    status: 200,
    headers: {
      "Content-Type":
        formato === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="agencia-${periodo.de}-a-${periodo.ate}.${formato}"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  });
}
