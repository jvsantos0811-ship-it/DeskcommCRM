/**
 * POST /api/v1/contracts/[id]/send — uma pessoa da equipe envia o contrato ao
 * cliente pelo WhatsApp. Corpo opcional: `{ mensagem }`, o texto que vai junto
 * com o arquivo. Aceita `Idempotency-Key` (o clique repetido não manda duas
 * vezes).
 *
 * Fork, migration 9008 (item 7 do briefing de 26/10/2026). Decisão do dono:
 * "por enquanto um humano envia o contrato" — rota de SESSÃO, `agent`+, fora de
 * `lib/auth/public-paths.ts`: nenhum agente de IA, ferramenta MCP ou token de
 * integração chega aqui.
 *
 * O caminho:
 *
 *   1. o contrato precisa estar em `rascunho` ou `enviado` (reenviar é pedir
 *      outra via, e o cliente pede);
 *   2. a conversa é a do contato do NEGÓCIO (a mais recente, fora de grupo);
 *   3. o provedor de assinatura prepara o documento — o `manual` não prepara
 *      nada; um serviço eletrônico devolveria o link, que vai na legenda;
 *   4. a cópia do PDF entra na pasta da conversa em `whatsapp-media`, com nome
 *      legível (`lib/contratos/arquivo.ts` explica por que ali);
 *   5. a mensagem sai pelo MESMO handler da Inbox, como envio de uma pessoa.
 *
 * O desfecho é decidido pelo status DEVOLVIDO pela mensagem, nunca pela
 * ausência de exceção (a lição da D3 das propostas): `failed` mantém o estado
 * de antes e grava o motivo no contrato, para a tela mostrar; `queued` (canal
 * fora do ar) já conta como enviado — a mensagem sai quando o canal voltar, e a
 * tela mostra "na fila" lendo a própria mensagem.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { enviarContrato } from "@/lib/contratos/enviar";
import type { ContratoDoNegocio } from "@/lib/contratos/tipos";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const ENDPOINT = "POST /api/v1/contracts/[id]/send";

const corpoSchema = z
  .object({
    mensagem: z.string().trim().max(1000).optional(),
  })
  .strict();

/** A recusa já como a resposta HTTP que ela vira — sai de dentro do efeito. */
class Recusa extends Error {
  constructor(public readonly resposta: Response) {
    super("recusa");
  }
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_contracts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const userId = authz.user.id;
  const idioma = authz.user.idioma;

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("not_found", t("Contrato não encontrado."), 404, { requestId });
  }

  const bruto = await req.json().catch(() => ({}));
  const corpo = corpoSchema.safeParse(bruto ?? {});
  if (!corpo.success) {
    return fail("validation_failed", t("A mensagem do envio tem até 1000 caracteres."), 422, {
      requestId,
      details: corpo.error.flatten(),
    });
  }

  const textoDoEnvio = corpo.data.mensagem ?? "";
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_failed", t("Idempotency-Key deve ser UUID."), 400, { requestId });
  }

  const admin = createAdminClient();

  // O miolo mora em `lib/contratos/enviar.ts` — o mesmo que a IA usa (PC-030).
  async function enviar(): Promise<ContratoDoNegocio> {
    const r = await enviarContrato(admin, {
      orgId,
      contratoId: id,
      actor: { type: "user", id: userId },
      userId,
      mensagem: textoDoEnvio,
      idioma,
      requestId,
      t,
    });
    if (!r.ok) throw new Recusa(fail(r.codigo, r.mensagem, r.status, { requestId }));
    return r.contrato;
  }

  try {
    if (chave === null) return ok(await enviar(), { requestId });

    const supabase = await createClient();
    const desfecho = await comIdempotencia({
      db: supabase,
      organizationId: orgId,
      endpoint: ENDPOINT,
      chave,
      corpo: { contrato_id: id, ...corpo.data },
      executar: async () => ({ resposta: await enviar(), status: 200 }),
    });
    if (desfecho.tipo === "conflito") {
      return fail("idempotency_conflict", t("Esta chave de idempotência já foi usada com outro conteúdo."), 409, {
        requestId,
      });
    }
    if (desfecho.tipo === "em_curso") {
      return fail("idempotency_in_progress", t("O envio deste contrato ainda está em curso. Aguarde um instante."), 409, {
        requestId,
      });
    }
    return ok(desfecho.resposta, { requestId });
  } catch (erro) {
    if (erro instanceof Recusa) return erro.resposta;
    logger.error("contracts.send_unexpected", {
      organizationId: orgId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return fail("internal_error", t("Não foi possível enviar o contrato agora."), 500, { requestId });
  }
}
