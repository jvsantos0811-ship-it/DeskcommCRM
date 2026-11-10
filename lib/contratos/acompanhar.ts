/**
 * ACOMPANHAR A ASSINATURA (PC-030, item 5) — o que acontece quando o serviço
 * avisa que um contrato mudou.
 *
 * O aviso só diz QUAL documento mudou. A situação é relida no serviço com a
 * credencial da organização (`consultar`) e aplicada aqui, uma transição por
 * vez, sem nunca voltar de um estado final:
 *
 *   visualizado → grava quando o cliente abriu o link (o contrato segue enviado);
 *   assinado    → contrato `assinado`, PDF assinado guardado no card, o negócio
 *                 ganha pelo caminho de sempre (`confirmarAssinatura`: etapa de
 *                 ganho + tag `contrato-assinado`), e abre o caso "Conferir
 *                 processo e advogado pelo CPF antes de dar entrada" (decisão do
 *                 João: a conferência fica depois da assinatura);
 *   recusado    → contrato `recusado` com o motivo do cliente + caso para a
 *                 equipe (a IA não reenvia sozinha);
 *   expirado    → contrato `expirado` + caso;
 *   cancelado   → contrato `cancelado` (alguém excluiu no serviço).
 *
 * O mesmo aviso repetido (o serviço reenvia, ou manda um por signatário) não
 * muda nada: o estado final já está lá. Nunca lança por regra; erro de rede do
 * serviço sobe como `ErroDoServico` para quem chamou decidir (a rota responde
 * 503 e o serviço tenta de novo).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { BUCKET_DOS_CONTRATOS, caminhoDoAssinado } from "@/lib/contratos/arquivo";
import { servicoDaOrganizacao } from "@/lib/contratos/assinatura/conta";
import type { ServicoDeAssinatura, SituacaoNoServico } from "@/lib/contratos/assinatura/servico";
import { abrirCasoDoContrato } from "@/lib/contratos/caso-do-contrato";
import { COLUNAS_DO_CONTRATO, type LinhaDoContrato } from "@/lib/contratos/servidor";
import { ehFinal, ehProvedorEletronico, NOME_DO_PROVEDOR } from "@/lib/contratos/vocabulario";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { confirmarAssinatura } from "@/lib/leads/assinatura-confirmada";
import { logger } from "@/lib/logger";
import { dataIsoNoFuso, fusoDaOrganizacao } from "@/lib/propostas/data-no-fuso";

export const CASO_CONFERIR_PELO_CPF = "Conferir processo e advogado pelo CPF antes de dar entrada";

export type DesfechoDoAviso =
  | { aplicado: false; motivo: "contrato_desconhecido" | "servico_nao_configurado" | "sem_mudanca" | "ja_encerrado" }
  | { aplicado: true; estado: SituacaoNoServico["estado"] };

const ATOR_DO_SERVICO = { type: "webhook_source", id: "assinatura" } as const;

export async function aplicarAvisoDoServico(
  admin: SupabaseClient,
  a: { orgId: string; documentoId: string; requestId: string; servico?: ServicoDeAssinatura },
): Promise<DesfechoDoAviso> {
  const { data } = await admin
    .from("crm_contracts")
    .select(COLUNAS_DO_CONTRATO)
    .eq("organization_id", a.orgId)
    .eq("provedor_documento_id", a.documentoId)
    .maybeSingle();
  const contrato = data as LinhaDoContrato | null;
  if (!contrato || !ehProvedorEletronico(contrato.provedor_assinatura)) {
    return { aplicado: false, motivo: "contrato_desconhecido" };
  }

  let servico = a.servico;
  if (!servico) {
    const s = await servicoDaOrganizacao(admin, a.orgId);
    if (!s.ok || s.valor.conta.provedor !== contrato.provedor_assinatura) {
      return { aplicado: false, motivo: "servico_nao_configurado" };
    }
    servico = s.valor.servico;
  }

  const situacao = await servico.consultar(a.documentoId);
  return aplicarSituacao(admin, { orgId: a.orgId, contrato, situacao, servico, requestId: a.requestId });
}

export async function aplicarSituacao(
  admin: SupabaseClient,
  a: {
    orgId: string;
    contrato: LinhaDoContrato;
    situacao: SituacaoNoServico;
    servico: ServicoDeAssinatura;
    requestId: string;
  },
): Promise<DesfechoDoAviso> {
  const { contrato, situacao } = a;
  const nomeDoServico = NOME_DO_PROVEDOR[contrato.provedor_assinatura];
  const agora = new Date().toISOString();

  // Visto pela primeira vez: a data entra, o status não muda.
  const visto = situacao.visualizadoEm && !contrato.visualizado_em ? situacao.visualizadoEm : null;

  if (situacao.estado === "enviado" || situacao.estado === "visualizado") {
    if (!visto || ehFinal(contrato.status)) return { aplicado: false, motivo: "sem_mudanca" };
    await atualizar(admin, a.orgId, contrato.id, { visualizado_em: visto });
    await linhaDoTempo(admin, a.orgId, contrato, "contract_sent", "O cliente abriu o link de assinatura do contrato");
    return { aplicado: true, estado: "visualizado" };
  }

  if (ehFinal(contrato.status)) return { aplicado: false, motivo: "ja_encerrado" };

  if (situacao.estado === "assinado") {
    // O PDF assinado primeiro: o endereço que o serviço deu vence em 1 hora.
    let assinadoPath: string | null = null;
    if (situacao.arquivoAssinadoUrl) {
      try {
        const bytes = await a.servico.baixarAssinado(situacao.arquivoAssinadoUrl);
        const caminho = caminhoDoAssinado(a.orgId, contrato.id);
        const { error } = await admin.storage
          .from(BUCKET_DOS_CONTRATOS)
          .upload(caminho, bytes, { contentType: "application/pdf", upsert: true });
        if (!error) assinadoPath = caminho;
      } catch (err) {
        logger.warn("[contrato] PDF assinado não guardado — fica para a próxima consulta", {
          organization_id: a.orgId,
          contrato_id: contrato.id,
          detalhe: err instanceof Error ? err.message.slice(0, 120) : "erro",
        });
      }
    }
    await atualizar(admin, a.orgId, contrato.id, {
      status: "assinado",
      decidido_em: situacao.assinadoEm ?? agora,
      decidido_por_user_id: null,
      ...(assinadoPath ? { assinado_path: assinadoPath } : {}),
      ...(visto ? { visualizado_em: visto } : {}),
    });
    await linhaDoTempo(admin, a.orgId, contrato, "contract_signed", `Contrato assinado pelo cliente (${nomeDoServico})`);

    if (contrato.lead_id) {
      const fuso = await fusoDaOrganizacao(admin, a.orgId);
      const dia = dataIsoNoFuso(situacao.assinadoEm ? new Date(situacao.assinadoEm) : new Date(), fuso);
      try {
        await confirmarAssinatura(
          admin,
          { organization_id: a.orgId, actor: ATOR_DO_SERVICO, requestId: a.requestId },
          {
            leadId: contrato.lead_id,
            dataAssinatura: dia,
            origem: "provedor",
            registradoPorUserId: null,
            provedor: contrato.provedor_assinatura,
            documentoId: contrato.provedor_documento_id,
          },
        );
      } catch (err) {
        // Ex.: o funil exige campo no ganho. O contrato está assinado; a equipe
        // fecha o negócio pelo botão — o caso abaixo leva até lá.
        logger.warn("[contrato] assinado, mas o negócio não fechou sozinho", {
          organization_id: a.orgId,
          lead_id: contrato.lead_id,
          detalhe: err instanceof Error ? err.message.slice(0, 160) : "erro",
        });
      }
    }
    await abrirCasoDoContrato(admin, {
      orgId: a.orgId,
      conversationId: contrato.conversation_id,
      leadId: contrato.lead_id,
      contratoId: contrato.id,
      titulo: CASO_CONFERIR_PELO_CPF,
      resumo: `O cliente assinou "${contrato.titulo}" pelo ${nomeDoServico}. Antes de dar entrada, confira pelo CPF se já há processo ou outro advogado no mesmo pedido.`,
      bloqueio: "Conferir processo e advogado pelo CPF do cliente, depois seguir com a entrada.",
    });
    await auditar(a, "assinado");
    return { aplicado: true, estado: "assinado" };
  }

  if (situacao.estado === "recusado" || situacao.estado === "expirado") {
    const recusado = situacao.estado === "recusado";
    await atualizar(admin, a.orgId, contrato.id, {
      status: situacao.estado,
      decidido_em: agora,
      decidido_por_user_id: null,
      ...(recusado && situacao.motivoRecusa ? { motivo: situacao.motivoRecusa.slice(0, 500) } : {}),
      ...(visto ? { visualizado_em: visto } : {}),
    });
    await linhaDoTempo(
      admin,
      a.orgId,
      contrato,
      "contract_declined",
      recusado
        ? `O cliente recusou o contrato no ${nomeDoServico}${situacao.motivoRecusa ? `: "${situacao.motivoRecusa.slice(0, 200)}"` : ""}`
        : `O prazo para assinar o contrato venceu (${nomeDoServico})`,
    );
    await abrirCasoDoContrato(admin, {
      orgId: a.orgId,
      conversationId: contrato.conversation_id,
      leadId: contrato.lead_id,
      contratoId: contrato.id,
      titulo: recusado ? "Cliente recusou o contrato" : "Prazo do contrato venceu sem assinatura",
      resumo: recusado
        ? `O cliente recusou "${contrato.titulo}" no ${nomeDoServico}.${situacao.motivoRecusa ? ` Motivo escrito pelo cliente: "${situacao.motivoRecusa.slice(0, 300)}".` : ""} A IA não reenvia sozinha.`
        : `O pedido de assinatura de "${contrato.titulo}" venceu sem assinatura. A IA não reenvia sozinha.`,
      bloqueio: "Falar com o cliente e decidir: corrigir e enviar de novo pelo card, ou encerrar.",
    });
    await auditar(a, situacao.estado);
    return { aplicado: true, estado: situacao.estado };
  }

  // cancelado: alguém excluiu o documento no serviço.
  await atualizar(admin, a.orgId, contrato.id, { status: "cancelado", decidido_em: agora, decidido_por_user_id: null });
  await linhaDoTempo(admin, a.orgId, contrato, "contract_cancelled", `Pedido de assinatura cancelado no ${nomeDoServico}`);
  await auditar(a, "cancelado");
  return { aplicado: true, estado: "cancelado" };
}

async function atualizar(admin: SupabaseClient, orgId: string, id: string, patch: Record<string, unknown>) {
  const { error } = await admin.from("crm_contracts").update(patch).eq("organization_id", orgId).eq("id", id);
  if (error) throw new Error(`contrato: ${error.message}`);
}

async function linhaDoTempo(
  admin: SupabaseClient,
  orgId: string,
  contrato: LinhaDoContrato,
  tipo: "contract_sent" | "contract_signed" | "contract_declined" | "contract_cancelled",
  frase: string,
) {
  if (!contrato.lead_id) return;
  await emitLeadActivity(admin, {
    organizationId: orgId,
    leadId: contrato.lead_id,
    contactId: contrato.contact_id,
    type: tipo,
    sourceModule: "contracts",
    sourceId: contrato.id,
    actor: ATOR_DO_SERVICO,
    reason: frase,
  });
}

async function auditar(
  a: { orgId: string; contrato: LinhaDoContrato; requestId: string },
  estado: SituacaoNoServico["estado"],
) {
  void audit({
    action: "contract.signature_status_changed",
    actorUserId: null,
    organizationId: a.orgId,
    resourceType: "crm_contracts",
    resourceId: a.contrato.id,
    requestId: a.requestId,
    metadata: { estado, provedor: a.contrato.provedor_assinatura, lead_id: a.contrato.lead_id },
  });
}
