/**
 * POST /api/v1/pipelines/[id]/export — a planilha do funil (PC-024, item 4).
 *
 * ─── Quem pode ───────────────────────────────────────────────────────────────
 *
 * Só gerente ou dono (`manager`+), a mesma régua do export de contatos: levar a
 * lista do funil embora é vazamento de base, não rotina de atendimento. O
 * suporte somente leitura não exporta (`requireSupportWrite`).
 *
 * ─── O que sai ───────────────────────────────────────────────────────────────
 *
 * Os cards que o QUADRO mostra com os filtros ligados — a tela manda os ids que
 * ela já filtrou (busca, etiqueta, responsável, situação, qualidade…), porque a
 * regra desses filtros mora no navegador (`applyFilters`) e reescrevê-la aqui
 * seria uma segunda resposta para a mesma pergunta. Por cima, a etapa e o
 * período de criação escolhidos no diálogo. O servidor só aceita id DESTE funil
 * e DESTA organização (RLS do usuário + filtros explícitos): um id de fora
 * simplesmente não volta.
 *
 * NUNCA sai texto de conversa, nota, cartão de passagem, anexo nem a descrição
 * do negócio. Campos sensíveis (saúde, documento, marcados) só com a marca
 * explícita de quem exporta (`sensiveis_marcados`), e ficam na auditoria.
 *
 * ─── Auditoria ───────────────────────────────────────────────────────────────
 *
 * `pipeline.exported`: quem, quando, formato, linhas, os filtros que valiam
 * (nunca o TEXTO da busca — é dado de quem foi buscado), os campos e quais
 * sensíveis saíram.
 *
 * ─── Tamanho ─────────────────────────────────────────────────────────────────
 *
 * Até `TETO_DE_LINHAS` por arquivo, montado em memória num pedido só (alguns
 * segundos no pior caso). A tela não trava: o pedido roda enquanto a pessoa
 * continua no quadro, e o aviso diz quando o arquivo está pronto.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { buscaEmLotes } from "@/lib/supabase/em-lotes";
import { fusoDaOrganizacao } from "@/lib/propostas/data-no-fuso";
import { diaLocalISO } from "@/lib/agenda/fuso";
import { periodoNoFuso } from "@/lib/datas/periodo-no-fuso";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { lerAnuncioDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";
import { gerarXlsx } from "@/lib/planilha/xlsx";
import {
  FORMATOS_DA_PLANILHA,
  TETO_DE_LINHAS,
  campoSensivel,
  csvDaPlanilha,
  montarPlanilha,
  nomeDoArquivo,
  type CampoDoFunil,
  type CardParaPlanilha,
} from "@/lib/funil/exportar";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const corpoSchema = z.object({
  formato: z.enum(FORMATOS_DA_PLANILHA),
  lead_ids: z.array(z.string().uuid()).min(1).max(TETO_DE_LINHAS),
  etapa_id: z.string().uuid().nullable().optional(),
  criado_de: dia.nullable().optional(),
  criado_ate: dia.nullable().optional(),
  campos: z.array(z.string().min(1).max(200)).max(200).default([]),
  /** Os campos sensíveis que a pessoa marcou DE PROPÓSITO. Sem esta marca, ficam fora. */
  sensiveis_marcados: z.array(z.string().min(1).max(200)).max(200).default([]),
  /** O FORMATO dos filtros do quadro, para a auditoria — nunca o texto da busca. */
  filtros: z
    .object({
      busca: z.boolean().default(false),
      etiquetas: z.number().int().min(0).max(1000).default(0),
      responsavel: z.boolean().default(false),
      situacao: z.string().max(40).nullable().default(null),
      outros: z.array(z.string().max(40)).max(30).default([]),
    })
    .default({ busca: false, etiquetas: 0, responsavel: false, situacao: null, outros: [] }),
});

interface LinhaDoLead {
  id: string;
  title: string;
  contact_id: string | null;
  stage_id: string | null;
  status: string;
  lost_reason: string | null;
  tags: string[] | null;
  owner_user_id: string | null;
  source: string | null;
  created_at: string;
  stage_changed_at: string | null;
  custom_fields: Record<string, unknown> | null;
  position_in_stage: number | string | null;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: pipelineId } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  let corpo: z.infer<typeof corpoSchema>;
  try {
    const parsed = corpoSchema.safeParse(await req.json());
    if (!parsed.success) {
      return fail("validation_failed", t("Pedido de exportação inválido."), 422, {
        details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
        requestId,
      });
    }
    corpo = parsed.data;
  } catch {
    return fail("validation_failed", t("Pedido de exportação inválido."), 422, { requestId });
  }

  const supabase = await createClient();
  const { data: pipeline, error: pipelineErr } = await supabase
    .from("crm_pipelines")
    .select("id, name, settings")
    .eq("id", pipelineId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (pipelineErr) return fail("internal_error", pipelineErr.message, 500, { requestId });
  if (!pipeline) return fail("resource_not_found", t("Pipeline não encontrado."), 404, { requestId });

  // Os campos do funil: só os que existem nele; sensível só com a marca explícita.
  const definidos = (
    ((pipeline.settings as { fields?: unknown } | null)?.fields ?? []) as CampoDoFunil[]
  ).filter((c) => c && typeof c.key === "string");
  const marcados = new Set(corpo.sensiveis_marcados);
  const pedidos = new Set(corpo.campos);
  const campos = definidos.filter(
    (c) => pedidos.has(c.key) && (!campoSensivel(c) || marcados.has(c.key)),
  );
  const sensiveisQueSairam = campos.filter((c) => campoSensivel(c)).map((c) => c.key);

  const ids = [...new Set(corpo.lead_ids)];
  const { data: lidos, error: leadsErr } = await buscaEmLotes<LinhaDoLead>(ids, (lote) =>
    supabase
      .from("crm_leads")
      .select(
        "id, title, contact_id, stage_id, status, lost_reason, tags, owner_user_id, source, created_at, stage_changed_at, custom_fields, position_in_stage",
      )
      .eq("organization_id", orgId)
      .eq("pipeline_id", pipelineId)
      .neq("status", "archived")
      .in("id", lote),
  );
  if (leadsErr) return fail("internal_error", leadsErr.message, 500, { requestId });

  const fuso = await fusoDaOrganizacao(supabase, orgId);
  const { inicio, fimExclusivo } = periodoNoFuso(corpo.criado_de, corpo.criado_ate, fuso);
  const leads = lidos.filter((l) => {
    if (corpo.etapa_id && l.stage_id !== corpo.etapa_id) return false;
    const criado = new Date(l.created_at).getTime();
    if (inicio && criado < inicio.getTime()) return false;
    if (fimExclusivo && criado >= fimExclusivo.getTime()) return false;
    return true;
  });

  const { data: etapas } = await supabase
    .from("crm_stages")
    .select("id, name, position")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId);
  const etapaPorId = new Map(
    ((etapas ?? []) as Array<{ id: string; name: string; position: number }>).map((e) => [e.id, e]),
  );
  // A ordem do QUADRO: etapa, depois a posição dentro dela.
  leads.sort((a, b) => {
    const pa = etapaPorId.get(a.stage_id ?? "")?.position ?? 0;
    const pb = etapaPorId.get(b.stage_id ?? "")?.position ?? 0;
    if (pa !== pb) return pa - pb;
    return Number(a.position_in_stage ?? 0) - Number(b.position_in_stage ?? 0);
  });

  const contactIds = [...new Set(leads.map((l) => l.contact_id).filter((c): c is string => !!c))];
  const [contatos, conversas, nomes] = await Promise.all([
    buscaEmLotes<{
      id: string;
      name: string | null;
      display_name: string | null;
      phone_number: string | null;
      is_anonymized: boolean | null;
      source_metadata: unknown;
    }>(contactIds, (lote) =>
      supabase
        .from("contacts")
        .select("id, name, display_name, phone_number, is_anonymized, source_metadata")
        .eq("organization_id", orgId)
        .in("id", lote),
    ),
    buscaEmLotes<{
      contact_id: string;
      last_inbound_at: string | null;
      last_outbound_at: string | null;
      active_ai_agent_id: string | null;
      last_message_at: string | null;
    }>(contactIds, (lote) =>
      supabase
        .from("conversations")
        .select("contact_id, last_inbound_at, last_outbound_at, active_ai_agent_id, last_message_at")
        .eq("organization_id", orgId)
        .eq("is_group", false)
        .in("contact_id", lote),
    ),
    nomesDosAtendentes(leads.map((l) => l.owner_user_id)),
  ]);
  if (contatos.error) return fail("internal_error", contatos.error.message, 500, { requestId });
  if (conversas.error) return fail("internal_error", conversas.error.message, 500, { requestId });

  const contatoPorId = new Map(contatos.data.map((c) => [c.id, c]));
  // Por contato: a última do cliente e a última enviada, entre TODAS as
  // conversas dele; o agente de IA é o da conversa mais recente.
  const conversaPorContato = new Map<
    string,
    { ultimaDoCliente: string | null; ultimaEnviada: string | null; agente: string | null; recente: string }
  >();
  const maior = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
  for (const c of conversas.data) {
    const atual = conversaPorContato.get(c.contact_id);
    const recente = c.last_message_at ?? "";
    conversaPorContato.set(c.contact_id, {
      ultimaDoCliente: maior(atual?.ultimaDoCliente ?? null, c.last_inbound_at),
      ultimaEnviada: maior(atual?.ultimaEnviada ?? null, c.last_outbound_at),
      agente: !atual || recente > atual.recente ? c.active_ai_agent_id : atual.agente,
      recente: !atual || recente > atual.recente ? recente : atual.recente,
    });
  }
  const agenteIds = [
    ...new Set([...conversaPorContato.values()].map((v) => v.agente).filter((a): a is string => !!a)),
  ];
  const { data: agentes } = agenteIds.length
    ? await supabase.from("ai_agents").select("id, name").eq("organization_id", orgId).in("id", agenteIds)
    : { data: [] as Array<{ id: string; name: string }> };
  const agentePorId = new Map(((agentes ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));

  const cards: CardParaPlanilha[] = leads.map((l) => {
    const contato = l.contact_id ? contatoPorId.get(l.contact_id) : undefined;
    const anonimizado = contato?.is_anonymized === true;
    const conversa = l.contact_id ? conversaPorContato.get(l.contact_id) : undefined;
    const anuncio = contato && !anonimizado ? lerAnuncioDoContato(contato.source_metadata) : null;
    const tituloDoAnuncio = anuncio?.titulo ?? anuncio?.ad_id ?? null;
    return {
      titulo: l.title,
      contato: contato ? (nomeDoContato(contato) ?? "") : "",
      telefone: contato && !anonimizado ? phoneForDisplay(contato.phone_number) : "",
      etapa: etapaPorId.get(l.stage_id ?? "")?.name ?? "",
      status: l.status,
      motivoDePerda: l.lost_reason,
      etiquetas: l.tags ?? [],
      responsavel: l.owner_user_id ? (nomes.get(l.owner_user_id) ?? t("Atendente")) : "",
      agenteDeIa: conversa?.agente ? (agentePorId.get(conversa.agente) ?? "") : "",
      origem: [l.source, tituloDoAnuncio ? `${t("Anúncio")}: ${tituloDoAnuncio}` : null]
        .filter(Boolean)
        .join(" · "),
      criadoEm: l.created_at,
      entrouNaEtapaEm: l.stage_changed_at ?? l.created_at,
      ultimaDoCliente: conversa?.ultimaDoCliente ?? null,
      ultimaEnviada: conversa?.ultimaEnviada ?? null,
      camposPersonalizados: anonimizado ? {} : (l.custom_fields ?? {}),
    };
  });

  const locale = authz.user.idioma === "pt-BR" ? "pt-BR" : authz.user.idioma;
  const { cabecalho, linhas } = montarPlanilha({ cards, campos, fuso, locale, t });
  const hoje = diaLocalISO(new Date(), fuso);
  const nome = nomeDoArquivo((pipeline as { name: string }).name, hoje, corpo.formato);

  await audit({
    action: "pipeline.exported",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "pipeline",
    resourceId: pipelineId,
    requestId,
    metadata: {
      actor_type: "user",
      formato: corpo.formato,
      linhas: cards.length,
      pedidas: ids.length,
      filtros: {
        ...corpo.filtros,
        etapa: corpo.etapa_id ?? null,
        criado_de: corpo.criado_de ?? null,
        criado_ate: corpo.criado_ate ?? null,
      },
      campos: campos.map((c) => c.key),
      sensiveis_incluidos: sensiveisQueSairam,
    },
  });

  const conteudo =
    corpo.formato === "xlsx"
      ? gerarXlsx((pipeline as { name: string }).name, cabecalho, linhas)
      : new TextEncoder().encode(csvDaPlanilha(cabecalho, linhas));

  return new Response(conteudo as BodyInit, {
    status: 200,
    headers: {
      "Content-Type":
        corpo.formato === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nome}"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
      "X-Export-Linhas": String(cards.length),
    },
  });
}
