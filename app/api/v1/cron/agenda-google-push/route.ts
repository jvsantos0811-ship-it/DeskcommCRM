import { NextResponse, type NextRequest } from "next/server";
import { googlePushCandidates } from "@/lib/agenda/google/candidates";
import { apenasDeMembrosAtivos } from "@/lib/agenda/google/membros";
import { reconcileAppointment } from "@/lib/agenda/google/sync-executor";
import { pintarPresencasPendentes } from "@/lib/agenda/presenca";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";
export const dynamic = "force-dynamic";
async function executar(req: NextRequest) {
  if (!autorizaCron(req))
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "cron secret inválido" } },
      { status: 401 },
    );
  const db = createAdminClient();
  const { data, error } = await googlePushCandidates(db);
  if (error)
    return NextResponse.json(
      { error: { code: "internal_error", message: "Não foi possível ler a pendência Google." } },
      { status: 500 },
    );
  const effects = new Map<string, { processados: number; falhas: number }>();
  const active = await apenasDeMembrosAtivos(db, data ?? []);
  for (const item of active) {
    let result: string;
    try {
      result = await reconcileAppointment(db, item.organization_id, item.id);
    } catch {
      result = "failed";
    }
    if (result === "busy" || result === "unchanged" || result === "terminal") continue;
    const summary = effects.get(item.organization_id) ?? { processados: 0, falhas: 0 };
    if (result === "processed") summary.processados++;
    else summary.falhas++;
    effects.set(item.organization_id, summary);
  }
  for (const [organizationId, summary] of effects) {
    if (summary.processados > 0 || summary.falhas > 0)
      await audit({
        action: "agenda.google.sync_executado",
        organizationId,
        metadata: { direcao: "ida", ...summary },
      });
  }
  // PC-052 — depois de publicar, repinta no Google o que mudou de presença
  // (verde, vermelho, de volta ao amarelo). Fora das projeções do sync: ver
  // `lib/agenda/presenca.ts`. A mudança de presença já foi auditada na escrita.
  const pintura = await pintarPresencasPendentes(db);
  // A rodada que pintou, audita (a que não pintou nada, não).
  for (const [organizationId, pintados] of pintura.porOrganizacao) {
    if (pintados > 0)
      await audit({
        action: "agenda.google.sync_executado",
        organizationId,
        metadata: { direcao: "cor_da_presenca", processados: pintados, falhas: 0 },
      });
  }
  return NextResponse.json({
    data: { candidatos: data?.length ?? 0, organizacoes: effects.size, presencas_pintadas: pintura.pintados },
  });
}
export const GET = executar;
export const POST = executar;
