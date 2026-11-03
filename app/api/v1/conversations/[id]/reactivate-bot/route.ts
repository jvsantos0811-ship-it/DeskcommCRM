import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/reactivate-bot
 *
 * Devolve o atendimento ao agente. A REGRA vive em
 * `lib/escalacao/retomada.ts` — esta rota só resolve autenticação, org e a
 * tradução do resultado para HTTP.
 *
 * Ela foi extraída (Decisão 4 do briefing IA 360: a tool é fachada fina sobre a
 * regra que já existe) porque a mesma devolução precisa acontecer por dois
 * caminhos — a pessoa clicando aqui e a capacidade exposta ao agente. Regra
 * duplicada nos dois lados faria o sistema mentir para um deles.
 *
 * Ao extrair, apareceu o defeito: esta rota limpava só `bot_silenced_until` e
 * respondia `{ reactivated: true }` com o agente ainda travado por
 * `contacts.force_human` e por `assignee_kind='user'`. O conserto está na função;
 * o histórico do defeito, no cabeçalho dela.
 *
 * Auth: cookie session, role >= agent. Audit: `ai.reactivated_by_agent`.
 *
 * PC-014 (03/11/2026): num número com roteador (vários agentes), quem devolve
 * escolhe o agente e escreve em uma linha o que fez — corpo
 * `{ agente_id, nota }`. A linha entra no bloco de chegada do agente. Sem
 * roteador, o corpo é opcional e a devolução é o clique de sempre. Audit extra:
 * `conversation.devolvida_ao_agente`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  agentesDoRoteadorDaConversa,
  aplicarAgenteEscolhido,
  validarDevolucao,
} from "@/lib/escalacao/devolucao-com-agente";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/auth/require-role";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const corpoSchema = z
  .object({
    agente_id: z.string().uuid().optional(),
    nota: z.string().max(400).optional(),
  })
  .strict();

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  // O corpo é opcional (o clique de sempre manda `{}`); com roteador, agente e
  // nota são obrigatórios — conferidos ANTES de devolver, para nada mudar se
  // faltar algo.
  const cru = await req.json().catch(() => ({}));
  const corpo = corpoSchema.safeParse(cru ?? {});
  if (!corpo.success) {
    return fail("validation_failed", t("Pedido inválido."), 422, { requestId });
  }
  const admin = createAdminClient();
  const roteador = await agentesDoRoteadorDaConversa(admin, activeOrg.orgId, id);
  const escolha = validarDevolucao(roteador, {
    agenteId: corpo.data.agente_id ?? null,
    nota: corpo.data.nota ?? null,
  });
  if (!escolha.ok) {
    const mensagem =
      escolha.erro === "nota_obrigatoria"
        ? t("Escreva em uma linha o que você fez antes de devolver.")
        : escolha.erro === "agente_fora_do_roteador"
          ? t("Esse agente não atende este número.")
          : t("Escolha para qual agente a conversa volta.");
    return fail("validation_failed", mensagem, 422, { requestId });
  }

  const supabase = await createClient();

  const resultado = await devolverAtendimentoAoAgente(
    {
      supabase,
      organizationId: activeOrg.orgId,
      actor: { type: "user", id: authUser.id, role: activeOrg.role },
      requestId,
    },
    { conversationId: id },
  );

  if (!resultado.ok) {
    if (resultado.erro === "conversation_not_found") {
      return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
    }
    if (resultado.erro === "assignment_conflict") {
      return fail(
        "state_conflict",
        t("Alguém assumiu esta conversa agora — recarregue e tente de novo."),
        409,
        { requestId },
      );
    }
    // #2379: a marca permanente recusou ANTES de qualquer escrita — nada foi
    // devolvido, então a mensagem genérica abaixo ("Atendimento devolvido…")
    // mentiria e convidaria a repetir um gesto que vai recusar de novo.
    if (resultado.erro === "contato_sempre_humano") {
      return fail(
        "state_conflict",
        t("Este contato está marcado como sempre atendimento humano. Para a IA voltar a atendê-lo, remova a marca na ficha do contato."),
        409,
        { requestId },
      );
    }
    if (resultado.erro === "contact_state_unreadable") {
      return fail(
        "internal_error",
        t("Não foi possível conferir o contato desta conversa — nada foi alterado. Tente de novo."),
        500,
        { requestId },
      );
    }
    // A devolução em si já aconteceu; o que falhou foi o sinal que retoma um
    // acompanhamento pausado. Repetir a chamada é seguro (tudo é idempotente).
    return fail(
      "internal_error",
      t("Atendimento devolvido, mas o sinal de retomada do acompanhamento falhou — tente de novo."),
      500,
      { requestId },
    );
  }

  // PC-014: a conversa fica com o agente escolhido, e a linha da pessoa vira a
  // chegada dele. Falha aqui não desfaz a devolução (a IA já voltou); a tela
  // recebe o aviso para tentar de novo.
  if (escolha.agente !== null && roteador.roteadorId !== null && escolha.nota !== null) {
    const aplicado = await aplicarAgenteEscolhido(admin, {
      organizationId: activeOrg.orgId,
      conversationId: id,
      roteadorId: roteador.roteadorId,
      agente: escolha.agente,
      nota: escolha.nota,
      userId: authUser.id,
    });
    if (!aplicado.ok) {
      return fail(
        "internal_error",
        t("Atendimento devolvido, mas não consegui pôr a conversa com o agente escolhido — tente de novo."),
        500,
        { requestId },
      );
    }
    await audit({
      action: "conversation.devolvida_ao_agente",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "conversation",
      resourceId: id,
      requestId,
      metadata: { agente_id: escolha.agente.id, passagem_id: aplicado.passagemId },
    });
  }

  return ok(
    {
      reactivated: true,
      // O que a pessoa fez vai junto: quem chamou consegue mostrar na tela que o
      // agente não voltou cego.
      continuidade: {
        houve_atendimento_humano: resultado.continuidade.houveAtendimentoHumano,
        resumo: resultado.continuidade.resumo,
        decisoes: resultado.continuidade.decisoes.length,
        notas: resultado.continuidade.notas.length,
      },
    },
    { requestId },
  );
}
