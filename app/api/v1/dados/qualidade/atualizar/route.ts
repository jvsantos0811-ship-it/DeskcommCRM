import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/dados/qualidade/atualizar — o botão "Atualizar agora" (v3 §8.3).
 *
 * Gerente e administrador refazem o retrato do dia da PRÓPRIA organização (a da
 * sessão, nunca do corpo), no máximo uma vez a cada 30 minutos. Quem recusa o
 * segundo pedido é o banco (`fn_dados_gravar_retrato`, migration 9020, com trava
 * por organização); a leitura de antes só poupa montar um retrato que seria
 * recusado. A recusa responde 409 com a hora em que dá para atualizar de novo,
 * e fica na auditoria como o sucesso.
 */
import { randomUUID } from "node:crypto";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ErroDoRetrato, gerarRetratoDaOrg } from "@/lib/dados/gerar-retrato";
import { criarLeitor } from "@/lib/dados/leitor/ler-lead";
import { rodadaManualDoLeitor } from "@/lib/dados/leitor/rodadas";
import { proximoAtualizar } from "@/lib/dados/resposta";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_dados_retrato" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const admin = createAdminClient();
  const agora = new Date();

  const recusar = async (geradoEm: string, proximoEm: string) => {
    await audit({
      organizationId: orgId,
      actorUserId: authz.user.id,
      action: "dados.retrato_recusado",
      resourceType: "crm_dados_retrato",
      metadata: { gerado_em: geradoEm, proximo_em: proximoEm },
      requestId,
    });
    // 409, e não 429: o `apiClient` repete o 429 sozinho (e cada repetição
    // seria mais uma recusa na auditoria), e a tela precisa da hora do corpo.
    return fail(
      "retrato_recente",
      t("Os números foram atualizados há menos de 30 minutos. Dá para atualizar de novo depois disso."),
      409,
      { requestId, details: { gerado_em: geradoEm, proximo_em: proximoEm } },
    );
  };

  const { data: ultimo, error: eUltimo } = await admin
    .from("crm_dados_retrato")
    .select("gerado_em")
    .eq("organization_id", orgId)
    .order("gerado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (eUltimo) return fail("internal_error", t("Não foi possível atualizar os números agora."), 500, { requestId });
  const geradoAntes = (ultimo as { gerado_em?: string } | null)?.gerado_em ?? null;
  const proximo = proximoAtualizar(geradoAntes, agora);
  if (geradoAntes && proximo) return recusar(geradoAntes, proximo);

  // PM-027 §3: o Leitor da conversa (se ligado) lê antes do retrato. Passada
  // curta: o que não couber o cron continua. Nunca lança.
  const leitura = await rodadaManualDoLeitor(admin, orgId, { agora, ler: criarLeitor(admin), requestId });

  let resultado;
  try {
    resultado = await gerarRetratoDaOrg(admin, orgId, "manual", { agora });
  } catch (e) {
    logger.error("dados: atualizar agora falhou", {
      requestId,
      organization_id: orgId,
      etapa: e instanceof ErroDoRetrato ? e.etapa : "desconhecida",
      message: e instanceof Error ? e.message : String(e),
    });
    return fail("internal_error", t("Não foi possível atualizar os números agora."), 500, { requestId });
  }

  if (!resultado.gravado) {
    // Outro pedido gravou no meio (dois cliques, duas abas): o banco recusou.
    return recusar(resultado.geradoEm, resultado.proximoEm ?? resultado.geradoEm);
  }

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "dados.retrato_gerado",
    resourceType: "crm_dados_retrato",
    metadata: { origem: "manual", dia: resultado.dia, leads: resultado.leads, apagados: resultado.apagados },
    requestId,
  });

  return ok(
    {
      dia: resultado.dia,
      gerado_em: resultado.geradoEm,
      proximo_atualizar_em: resultado.proximoEm,
      leads: resultado.leads,
      leitor: leitura ? { lidos: leitura.lidos, restantes: leitura.restantes, parou: leitura.parou } : null,
    },
    { requestId },
  );
}
