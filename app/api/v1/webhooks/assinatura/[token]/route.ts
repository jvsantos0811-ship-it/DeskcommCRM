/**
 * POST /api/v1/webhooks/assinatura/:token — o aviso `contrato.assinado` de um
 * provedor de assinatura eletrônica (PC-003, item 3 (a)).
 *
 * Duas formas de aviso entram aqui. A genérica (integração própria) manda:
 *
 *   POST /api/v1/webhooks/assinatura/<token-da-organização>
 *   x-assinatura-segredo: <segredo da organização>
 *   { "evento": "contrato.assinado", "lead_id": "<uuid>",
 *     "data_assinatura": "AAAA-MM-DD", "provedor": "zapsign", "documento_id": "..." }
 *
 * A organização sai do TOKEN do caminho (nunca do corpo), e o segredo é
 * conferido contra o hash SHA-256 gravado (`assinatura_webhook_chaves`) em
 * tempo constante. Segredo errado, token desconhecido, negócio de outra
 * organização ou evento desconhecido: NADA muda, e a recusa fica registrada
 * (`recusas_da_ia`, tipo `assinatura_recusada`) quando a organização é
 * conhecida. Válido: o MESMO efeito do botão "Assinatura confirmada" da equipe,
 * com origem "provedor".
 *
 * A outra (PC-030) é a do serviço de assinatura eletrônica ligado em
 * Configurações › Assinatura eletrônica: o serviço manda o aviso no formato
 * DELE, num caminho e com um segredo PRÓPRIOS (`assinatura_eletronica_contas.
 * aviso_*`, cadastrados ao salvar a conta) — a porta genérica e a do serviço
 * não dividem segredo, então trocar uma não corta a outra. O corpo só diz QUAL
 * documento mudou; a situação é relida no serviço com a credencial da
 * organização e aplicada por `lib/contratos/acompanhar.ts` (assinado,
 * recusado, expirado, visto). O mesmo aviso repetido não muda nada.
 *
 * PC-046: serviço cujo aviso é cadastrado NO PAINEL dele (Autentique) não
 * aceita cabeçalho nosso. Ali a prova de origem é a assinatura HMAC SHA-256 que
 * o próprio serviço calcula sobre o corpo BRUTO (`x-autentique-signature`),
 * conferida com o segredo do endpoint colado na tela (e, como reserva, com o
 * token da API). Sem assinatura que confira: nada muda, e a recusa fica
 * registrada — igual ao segredo errado das outras portas.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { confirmarAssinatura, dataDeAssinaturaValida } from "@/lib/leads/assinatura-confirmada";
import { registrarRecusaPeloSupabase } from "@/lib/leads/trava-da-ia";
import { HEADER_SEGREDO_DA_ASSINATURA, segredoConfere } from "@/lib/leads/assinatura-webhook";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { aplicarAvisoDoServico } from "@/lib/contratos/acompanhar";
import {
  abrirChave,
  abrirSegredoDoAviso,
  contaDoCaminhoDoAviso,
  type LinhaDaConta,
} from "@/lib/contratos/assinatura/conta";
import { avisoDoPainelConfere, cadastroDoAviso, lerAvisoDoServico } from "@/lib/contratos/assinatura/registro";
import { ErroDoServico } from "@/lib/contratos/assinatura/servico";
import { ehProvedorEletronico } from "@/lib/contratos/vocabulario";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  evento: z.literal("contrato.assinado"),
  lead_id: z.string().uuid(),
  data_assinatura: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  provedor: z.string().trim().min(1).max(60).optional(),
  documento_id: z.string().trim().min(1).max(200).optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    return fail("not_found", "Not found.", 404, { requestId });
  }

  const rl = await checkRateLimit(`webhook_assinatura:${token}`, 60, 60);
  if (!rl.allowed) {
    return fail("rate_limited", "Too many requests.", 429, { requestId, headers: { "Retry-After": "60" } });
  }

  const admin = createAdminClient();
  const { data: chave } = await admin
    .from("assinatura_webhook_chaves")
    .select("organization_id, segredo_sha256, ativo")
    .eq("path_token", token)
    .maybeSingle();
  const c = chave as { organization_id: string; segredo_sha256: string; ativo: boolean } | null;
  if (!c) {
    // PC-030: não é a porta genérica — pode ser a do serviço de assinatura.
    const conta = await contaDoCaminhoDoAviso(admin, token).catch(() => null);
    if (!conta || !conta.ativo || !ehProvedorEletronico(conta.provedor)) {
      return fail("not_found", "Not found.", 404, { requestId });
    }
    // Aviso cadastrado pela API tem o segredo NOSSO; sem ele, a porta não existe.
    if (cadastroDoAviso(conta.provedor) === "pela_api" && !conta.aviso_segredo_sha256) {
      return fail("not_found", "Not found.", 404, { requestId });
    }
    return avisoDoServico(req, admin, conta, requestId);
  }
  if (!c.ativo) return fail("not_found", "Not found.", 404, { requestId });

  const recusar = async (codigo: string, motivo: string, status: number, leadId?: string | null) => {
    await registrarRecusaPeloSupabase(admin, {
      organizationId: c.organization_id,
      tipo: "assinatura_recusada",
      ferramenta: "webhook_assinatura",
      codigo,
      ...(leadId ? { leadId } : {}),
      motivo,
    });
    return fail(codigo, motivo, status, { requestId });
  };

  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_DA_ASSINATURA), c.segredo_sha256)) {
    return recusar("segredo_invalido", "Aviso de assinatura com segredo inválido: ignorado.", 401);
  }

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return recusar("payload_invalido", "Aviso de assinatura com formato inválido: ignorado.", 422);
  }
  const corpo = parsed.data;

  // O negócio tem de ser DESTA organização — a do token. Um id de outra
  // organização é ignorado e registrado, nunca aplicado.
  const { data: lead } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", c.organization_id)
    .eq("id", corpo.lead_id)
    .maybeSingle();
  if (!lead) {
    return recusar("negocio_de_outra_organizacao", "Aviso de assinatura para um negócio que não é desta organização: ignorado.", 404);
  }

  const data = corpo.data_assinatura ?? new Date().toISOString().slice(0, 10);
  if (!dataDeAssinaturaValida(data)) {
    return recusar("data_invalida", "Aviso de assinatura com data inválida ou no futuro: ignorado.", 422, corpo.lead_id);
  }

  try {
    const r = await confirmarAssinatura(
      admin,
      {
        organization_id: c.organization_id,
        actor: { type: "webhook_source", id: "assinatura" },
        requestId,
      },
      {
        leadId: corpo.lead_id,
        dataAssinatura: data,
        origem: "provedor",
        registradoPorUserId: null,
        provedor: corpo.provedor ?? null,
        documentoId: corpo.documento_id ?? null,
      },
    );
    void audit({
      action: "lead.signature_confirmed",
      actorUserId: null,
      organizationId: c.organization_id,
      resourceType: "crm_lead",
      resourceId: corpo.lead_id,
      requestId,
      metadata: { origem: "provedor", data_assinatura: data, provedor: corpo.provedor ?? null, ja_estava: r.jaEstava },
    });
    return ok({ aplicado: true, ja_estava: r.jaEstava }, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      // Ex.: o funil exige campo no ganho. Nada mudou; a equipe vê na aba.
      return recusar(err.code, `Assinatura recebida, mas o negócio não fechou: ${err.message}`, err.status, corpo.lead_id);
    }
    throw err;
  }
}

/**
 * O aviso do SERVIÇO de assinatura ligado na organização (ZapSign…), no
 * caminho próprio dele. Segredo conferido contra o hash da conta, em tempo
 * constante; o corpo só diz QUAL documento mudou, e a situação é relida no
 * serviço com a credencial da organização.
 */
async function avisoDoServico(
  req: NextRequest,
  admin: ReturnType<typeof createAdminClient>,
  conta: LinhaDaConta,
  requestId: string,
): Promise<Response> {
  const recusar = async (codigo: string, motivo: string, status: number) => {
    await registrarRecusaPeloSupabase(admin, {
      organizationId: conta.organization_id,
      tipo: "assinatura_recusada",
      ferramenta: "webhook_assinatura",
      codigo,
      motivo,
    });
    return fail(codigo, motivo, status, { requestId });
  };
  if (!ehProvedorEletronico(conta.provedor)) return fail("not_found", "Not found.", 404, { requestId });
  const provedor = conta.provedor;
  const noPainel = cadastroDoAviso(provedor) === "no_painel";
  // Porta do aviso cadastrado pela API: o segredo NOSSO no cabeçalho, conferido
  // antes de ler o corpo (como sempre foi).
  if (!noPainel && !segredoConfere(req.headers.get(HEADER_SEGREDO_DA_ASSINATURA), conta.aviso_segredo_sha256 ?? "")) {
    return recusar("segredo_invalido", "Aviso do serviço de assinatura com segredo inválido: ignorado.", 401);
  }
  // Aviso é pequeno: teto de 256 KB, pelo cabeçalho antes de ler e pelos bytes depois.
  const TETO = 256 * 1024;
  if (Number(req.headers.get("content-length") ?? 0) > TETO) {
    return recusar("payload_invalido", "Aviso do serviço de assinatura grande demais: ignorado.", 413);
  }
  // Os BYTES que chegaram: o HMAC do serviço é sobre eles, e decodificar ou
  // reserializar o JSON poderia mudá-los.
  const corpoBruto = Buffer.from(await req.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (corpoBruto.length > TETO) {
    return recusar("payload_invalido", "Aviso do serviço de assinatura grande demais: ignorado.", 413);
  }
  if (
    noPainel &&
    !avisoDoPainelConfere(provedor, {
      corpoBruto,
      cabecalhos: req.headers,
      segredos: [abrirSegredoDoAviso(conta), abrirChave(conta)],
    })
  ) {
    return recusar("segredo_invalido", "Aviso do serviço de assinatura com segredo inválido: ignorado.", 401);
  }
  let bruto: unknown = null;
  try {
    bruto = corpoBruto.length > 0 ? (JSON.parse(corpoBruto.toString("utf8")) as unknown) : null;
  } catch {
    bruto = null;
  }
  const aviso = lerAvisoDoServico(provedor, bruto);
  if (!aviso) {
    // Evento autêntico do serviço que não aponta documento (ex.: um evento de
    // membro da conta): não é para nós, e responder erro só faria o serviço
    // reenviar. A origem já foi conferida acima.
    const tipo = (bruto as { event?: { type?: unknown } } | null)?.event?.type;
    if (noPainel && typeof tipo === "string") {
      // Rastro para o teste no sandbox: se os eventos de assinatura não trazem
      // o documento, o "visto" e a recusa só chegam pelo `document.*`.
      logger.info("[assinatura] aviso do painel sem documento", {
        organization_id: conta.organization_id,
        evento: tipo.slice(0, 60),
      });
      return ok({ aplicado: false, motivo: "evento_sem_documento", evento: tipo.slice(0, 60) }, { requestId });
    }
    return recusar("payload_invalido", "Aviso do serviço de assinatura com formato inválido: ignorado.", 422);
  }
  try {
    const desfecho = await aplicarAvisoDoServico(admin, {
      orgId: conta.organization_id,
      documentoId: aviso.documentoId,
      requestId,
    });
    return ok({ evento: aviso.evento, ...desfecho }, { requestId });
  } catch (err) {
    if (err instanceof ErroDoServico && err.codigo === "nao_encontrado") {
      // O serviço não acha mais o documento (apagado lá): tentar de novo não
      // muda nada. O contrato fica como está; a equipe decide pelo card.
      return ok({ evento: aviso.evento, aplicado: false, motivo: "documento_nao_encontrado" }, { requestId });
    }
    if (err instanceof ErroDoServico) {
      // O serviço fora (ou a chave trocada): 503 faz o serviço tentar de novo.
      return fail("servico_indisponivel", "Serviço de assinatura indisponível agora.", 503, { requestId });
    }
    throw err;
  }
}
