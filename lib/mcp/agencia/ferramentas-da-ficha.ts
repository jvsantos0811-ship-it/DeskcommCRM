/**
 * AS FERRAMENTAS DO LEITOR PELO CLAUDE — PC-036.
 *
 * Porta Ficha (`/api/mcp/agencia/ficha`, escopo `agencia:ficha`): a tarefa
 * agendada do Claude lê a conversa e grava a ficha do lead, sem o CRM chamar
 * modelo nenhum. Quatro ferramentas, na ordem de uso:
 *
 *   1. `crm_leitor_pendentes`      — quem o Leitor leria agora (a mesma seleção);
 *   2. `crm_leitor_conversa`       — o prompt do Leitor já montado, a conversa
 *                                    transcrita, os fatos do banco e a ficha anterior;
 *   3. `crm_gravar_ficha_do_lead`  — valida, grava (a anterior vai ao histórico),
 *                                    calcula a regra fixa e abre `lead_voltou`;
 *   4. `crm_leitor_concluir_rodada` — fecha a rodada do dia.
 *
 * A lógica mora em `lib/dados/leitor/pelo-claude.ts`; aqui só o contrato MCP.
 * Toda ferramenta recusa organização que não esteja na escolha `claude`.
 *
 * E uma de LEITURA, na porta Leitura do Gestor: `crm_ler_fichas` — as fichas
 * gravadas numa janela, com as provas, a origem e a leitura anterior, para a
 * conferência das 17h10 (decisão de 10/11).
 *
 * FORA de `allTools`: nem a chave de integração de um escritório nem os agentes
 * de atendimento alcançam a ficha por aqui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { alcanceDaOrg, funisLidos, posicaoNoAlcance, type FunilDaOrg } from "@/lib/dados/alcance-do-leitor";
import { GATILHOS, lerFicha, type FatosDoBanco } from "@/lib/dados/ficha";
import {
  concluirRodadaPeloClaude,
  entradaDaGravacaoSchema,
  gravarFichaPeloClaude,
  materialDaLeitura,
  ORIGENS_DA_LEITURA_PELO_CLAUDE,
  PENDENTES_POR_CHAMADA,
  pendentesPeloClaude,
} from "@/lib/dados/leitor/pelo-claude";
import { KIND_LEAD_VOLTOU, type LeadRow } from "@/lib/dados/leitor/rodada";
import { classificarFicha } from "@/lib/dados/regra-da-ficha";

import type { McpToolDefinition } from "../types";

// ─── porta Ficha ────────────────────────────────────────────────────────────

const pendentesShape = {
  limite: z
    .number()
    .int()
    .min(1)
    .max(PENDENTES_POR_CHAMADA)
    .optional()
    .describe(`Quantos leads devolver (1 a ${PENDENTES_POR_CHAMADA}; padrão ${PENDENTES_POR_CHAMADA}).`),
};

export const crmLeitorPendentes: McpToolDefinition<typeof pendentesShape> = {
  name: "crm_leitor_pendentes",
  description:
    "Os leads que o Leitor da conversa leria agora nesta organização (a mesma seleção do Leitor do CRM: conversa " +
    "nova, mensagem nova do lead, mensagem da equipe em conversa ativa, lead perdido que voltou a escrever; nada " +
    "anterior ao começo da leitura pelo Claude). Para cada um: lead_id, gatilho (devolva-o ao gravar), posição, " +
    "etapa, última fala do lead e se já tem ficha. Abre a rodada do dia. Só organização com a leitura pelo Claude.",
  inputSchema: pendentesShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => pendentesPeloClaude(ctx.supabase, ctx.organizationId, { agora: new Date(), limite: input.limite }),
};

const conversaShape = {
  lead_id: z.string().uuid().describe("O lead_id que crm_leitor_pendentes devolveu."),
};

export const crmLeitorConversa: McpToolDefinition<typeof conversaShape> = {
  name: "crm_leitor_conversa",
  description:
    "O material para ler um lead, exatamente o que o modelo do Leitor do CRM receberia: `instrucoes` (o prompt do " +
    "Leitor desta organização, com os tipos de lead, os requisitos e os prefixos de anúncio), `conversa` (todas as " +
    "conversas do contato, sem grupo, até 400 mensagens, com data e hora), `formato_da_ficha` (JSON Schema da " +
    "ficha), `mensagens_ate` (devolva ao gravar), os fatos do banco e a ficha anterior. Siga as instruções; não " +
    "invente instrução própria. Só organização com a leitura pelo Claude.",
  inputSchema: conversaShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => materialDaLeitura(ctx.supabase, ctx.organizationId, input.lead_id),
};

const gravarShape = {
  lead_id: z.string().uuid().describe("O lead lido."),
  ficha: z
    .record(z.string(), z.unknown())
    .describe("A ficha, no formato `formato_da_ficha` de crm_leitor_conversa. Campo inválido é recusado com o nome do campo."),
  mensagens_ate: z
    .string()
    .datetime({ offset: true })
    .describe("O `mensagens_ate` que crm_leitor_conversa devolveu (a última mensagem que a leitura viu)."),
  gatilho: z.enum(GATILHOS).describe("O gatilho que crm_leitor_pendentes devolveu para este lead."),
  origem: z
    .enum(ORIGENS_DA_LEITURA_PELO_CLAUDE)
    .describe("`leitor_0530` na leitura diária; `gestor_17h10` na correção do Gestor."),
  modelo: z.string().trim().min(1).max(120).describe('Quem leu, ex.: "claude-sonnet-5-5 (tarefa)".'),
};

export const crmGravarFichaDoLead: McpToolDefinition<typeof gravarShape> = {
  name: "crm_gravar_ficha_do_lead",
  description:
    "Grava a ficha de um lead (só a ficha: não move card, não muda etapa, não mexe em marcador nem fala com " +
    "ninguém). Valida pelo schema central e recusa com o campo errado; recusa leitura mais velha que a ficha " +
    "atual. A ficha anterior vai para o histórico. Devolve a situação, a temperatura, a qualidade, a ação e os " +
    "alertas da regra fixa, se abriu o aviso de lead que voltou, e `conversa_mudou` quando chegou mensagem depois " +
    "de `mensagens_ate` (a próxima seleção pega o lead de novo). Só organização com a leitura pelo Claude.",
  inputSchema: gravarShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  // A ficha tem trecho de conversa (e às vezes fato de saúde): na auditoria só os nomes dos campos.
  redigirParaAuditoria: (args) => {
    const ficha = args.ficha && typeof args.ficha === "object" ? Object.keys(args.ficha as Record<string, unknown>) : [];
    return { ...args, ficha: { campos: ficha } };
  },
  handler: async (input, ctx) =>
    gravarFichaPeloClaude(ctx.supabase, ctx.organizationId, entradaDaGravacaoSchema.parse(input), { agora: new Date() }),
};

const concluirShape = {
  lidos: z.number().int().min(0).max(10_000).describe("Quantos leads a tarefa leu nesta rodada."),
  erros: z.number().int().min(0).max(10_000).describe("Quantos falharam."),
  ultimo_erro: z.string().trim().max(300).optional().describe("O último erro, sem dado de lead (só o código ou a causa)."),
};

export const crmLeitorConcluirRodada: McpToolDefinition<typeof concluirShape> = {
  name: "crm_leitor_concluir_rodada",
  description:
    "Fecha a rodada do dia do Leitor pelo Claude nesta organização: conta no banco as fichas gravadas desde o " +
    "começo da rodada, guarda os erros e, se o retrato do dia do painel Dados ainda não existe, gera. Chame uma " +
    "vez no fim. Só organização com a leitura pelo Claude.",
  inputSchema: concluirShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) =>
    concluirRodadaPeloClaude(
      ctx.supabase,
      ctx.organizationId,
      { lidos: input.lidos, erros: input.erros, ultimo_erro: input.ultimo_erro ?? null },
      { agora: new Date(), requestId: ctx.requestId },
    ),
};

/** As ferramentas da porta Ficha (fora de `allTools`). */
export const FERRAMENTAS_DA_PORTA_FICHA: readonly McpToolDefinition[] = [
  crmLeitorPendentes as unknown as McpToolDefinition,
  crmLeitorConversa as unknown as McpToolDefinition,
  crmGravarFichaDoLead as unknown as McpToolDefinition,
  crmLeitorConcluirRodada as unknown as McpToolDefinition,
];

// ─── porta Leitura: as fichas para a conferência do Gestor ──────────────────

const JANELA_MAXIMA_DIAS = 31;
const FICHAS_POR_PAGINA = 50;

const lerFichasShape = {
  lida_desde: z.string().datetime({ offset: true }).describe("Início da janela de lida_em, ISO 8601 com fuso."),
  lida_ate: z.string().datetime({ offset: true }).optional().describe("Fim da janela (exclusivo). Ausente = agora."),
  lead_id: z.string().uuid().optional().describe("Só a ficha deste lead."),
  pagina: z.number().int().min(0).max(200).optional().describe(`Página de ${FICHAS_POR_PAGINA} fichas, a partir de 0.`),
};

class FalhaDasFichas extends Error {
  constructor(
    public readonly codigo: string,
    message: string,
  ) {
    super(`${codigo}: ${message}`);
    this.name = "FalhaDasFichas";
  }
}

interface FichaRow {
  lead_id: string;
  contact_id: string | null;
  ficha: unknown;
  atendido_por: unknown;
  modelo: string;
  versao_prompt: string;
  gatilho: string;
  lida_em: string;
  mensagens_ate: string | null;
  origem: string | null;
}

/**
 * Os fatos do banco de AGORA, sem ler mensagem: a última fala do lead e "nunca
 * respondido" pelas conversas, "duplicado" pelos outros cards com potencial do
 * contato. É a régua da conferência; a leitura grava os fatos dela.
 */
async function fatosDeAgora(
  db: SupabaseClient,
  orgId: string,
  linhas: FichaRow[],
): Promise<Map<string, FatosDoBanco>> {
  const contatos = [...new Set(linhas.map((l) => l.contact_id).filter((c): c is string => !!c))];
  const fatos = new Map<string, FatosDoBanco>();
  if (contatos.length === 0) return fatos;
  const [orgR, funisR, convR, leadsR] = await Promise.all([
    db.from("organizations").select("settings").eq("id", orgId).maybeSingle(),
    db.from("crm_pipelines").select("id, is_archived, is_client_pipeline").eq("organization_id", orgId),
    db
      .from("conversations")
      .select("contact_id, last_inbound_at, last_outbound_at")
      .eq("organization_id", orgId)
      .eq("is_group", false)
      .in("contact_id", contatos),
    db
      .from("crm_leads")
      .select("id, contact_id, pipeline_id, tags, created_at, etapa:crm_stages!crm_leads_stage_id_fkey(name, is_won, is_lost, is_archived)")
      .eq("organization_id", orgId)
      .in("contact_id", contatos),
  ]);
  for (const r of [orgR, funisR, convR, leadsR]) if (r.error) throw new FalhaDasFichas("internal_error", r.error.message.slice(0, 160));
  const alcance = alcanceDaOrg((orgR.data as { settings?: unknown } | null)?.settings);
  const lidos = funisLidos(alcance, (funisR.data ?? []) as FunilDaOrg[]);
  const porContato = new Map<string, { entrada: string | null; saida: boolean }>();
  for (const c of (convR.data ?? []) as Array<{ contact_id: string; last_inbound_at: string | null; last_outbound_at: string | null }>) {
    const a = porContato.get(c.contact_id) ?? { entrada: null, saida: false };
    porContato.set(c.contact_id, {
      entrada: !a.entrada || (c.last_inbound_at && c.last_inbound_at > a.entrada) ? (c.last_inbound_at ?? a.entrada) : a.entrada,
      saida: a.saida || !!c.last_outbound_at,
    });
  }
  const leads = (leadsR.data ?? []) as unknown as LeadRow[];
  for (const l of linhas) {
    const conv = l.contact_id ? porContato.get(l.contact_id) : undefined;
    const proprio = leads.find((x) => x.id === l.lead_id);
    const abertos = leads.filter(
      (x) =>
        x.contact_id === l.contact_id &&
        x.etapa &&
        posicaoNoAlcance({ pipeline_id: x.pipeline_id, tags: x.tags, etapa: x.etapa }, lidos, alcance) === "com_potencial",
    );
    fatos.set(l.lead_id, {
      ultima_fala_do_lead: conv?.entrada ? new Date(conv.entrada) : null,
      duplicado: !!proprio && abertos.some((o) => o.id !== proprio.id && o.created_at < proprio.created_at),
      nunca_respondido: !!conv?.entrada && !conv.saida,
      midia_nao_entendida: false,
    });
  }
  return fatos;
}

export const crmLerFichas: McpToolDefinition<typeof lerFichasShape> = {
  name: "crm_ler_fichas",
  description:
    "As fichas do lead gravadas numa janela de lida_em (para conferir a leitura contra a conversa): os campos com " +
    "as provas, lida_em, mensagens_ate, modelo, origem (leitor_do_crm, leitor_0530 ou gestor_17h10), gatilho, a " +
    "situação e a temperatura da regra fixa com os fatos do banco de agora, se há aviso de lead que voltou aberto, " +
    `e a leitura anterior (do histórico). Janela de até ${JANELA_MAXIMA_DIAS} dias, ${FICHAS_POR_PAGINA} fichas por página.`,
  inputSchema: lerFichasShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const desde = new Date(input.lida_desde);
    const ate = input.lida_ate ? new Date(input.lida_ate) : new Date();
    if (!(desde.getTime() < ate.getTime())) throw new FalhaDasFichas("validation_failed", "`lida_desde` tem de ser anterior a `lida_ate`.");
    if (ate.getTime() - desde.getTime() > JANELA_MAXIMA_DIAS * 86_400_000) {
      throw new FalhaDasFichas("validation_failed", `Janela de no máximo ${JANELA_MAXIMA_DIAS} dias.`);
    }
    const pagina = input.pagina ?? 0;
    let consulta = ctx.supabase
      .from("crm_lead_ficha")
      .select("lead_id, contact_id, ficha, atendido_por, modelo, versao_prompt, gatilho, lida_em, mensagens_ate, origem")
      .eq("organization_id", ctx.organizationId)
      .gte("lida_em", desde.toISOString())
      .lt("lida_em", ate.toISOString())
      .order("lida_em", { ascending: true })
      .order("lead_id", { ascending: true })
      .range(pagina * FICHAS_POR_PAGINA, pagina * FICHAS_POR_PAGINA + FICHAS_POR_PAGINA);
    if (input.lead_id) consulta = consulta.eq("lead_id", input.lead_id);
    const { data, error } = await consulta;
    if (error) throw new FalhaDasFichas("internal_error", error.message.slice(0, 160));
    const todas = (data ?? []) as FichaRow[];
    const temMais = todas.length > FICHAS_POR_PAGINA;
    const linhas = todas.slice(0, FICHAS_POR_PAGINA);
    const ids = linhas.map((l) => l.lead_id);

    const [histR, avisosR, fatos] = await Promise.all([
      ids.length
        ? ctx.supabase
            .from("crm_lead_ficha_historico")
            .select("lead_id, ficha, modelo, gatilho, lida_em, mensagens_ate, origem, substituida_em")
            .eq("organization_id", ctx.organizationId)
            .in("lead_id", ids)
            .order("substituida_em", { ascending: false })
            .limit(ids.length * 5)
        : Promise.resolve({ data: [], error: null }),
      ids.length
        ? ctx.supabase
            .from("agent_inbox_items")
            .select("ref_id")
            .eq("organization_id", ctx.organizationId)
            .eq("kind", KIND_LEAD_VOLTOU)
            .eq("status", "open")
            .in("ref_id", ids)
        : Promise.resolve({ data: [], error: null }),
      fatosDeAgora(ctx.supabase, ctx.organizationId, linhas),
    ]);
    if (histR.error) throw new FalhaDasFichas("internal_error", histR.error.message.slice(0, 160));
    if (avisosR.error) throw new FalhaDasFichas("internal_error", avisosR.error.message.slice(0, 160));
    const anterior = new Map<string, Record<string, unknown>>();
    for (const h of (histR.data ?? []) as Array<Record<string, unknown>>) {
      const lead = h.lead_id as string;
      if (!anterior.has(lead)) anterior.set(lead, h);
    }
    const comAviso = new Set(((avisosR.data ?? []) as Array<{ ref_id: string }>).map((a) => a.ref_id));
    const agora = new Date();

    return {
      janela: { desde: desde.toISOString(), ate: ate.toISOString() },
      pagina,
      tem_mais: temMais,
      fichas: linhas.map((l) => {
        const ficha = lerFicha(l.ficha);
        const banco = fatos.get(l.lead_id);
        const regra = ficha && banco ? classificarFicha({ ficha, banco }, agora) : null;
        const h = anterior.get(l.lead_id);
        return {
          lead_id: l.lead_id,
          ficha,
          ficha_valida: ficha !== null,
          atendido_por: l.atendido_por,
          modelo: l.modelo,
          versao_prompt: l.versao_prompt,
          origem: l.origem ?? "leitor_do_crm",
          gatilho: l.gatilho,
          lida_em: l.lida_em,
          mensagens_ate: l.mensagens_ate,
          situacao: regra?.situacao ?? null,
          temperatura: regra?.temperatura ?? null,
          aviso_lead_voltou_aberto: comAviso.has(l.lead_id),
          leitura_anterior: h
            ? {
                ficha: lerFicha(h.ficha),
                modelo: h.modelo,
                origem: h.origem ?? "leitor_do_crm",
                gatilho: h.gatilho,
                lida_em: h.lida_em,
                mensagens_ate: h.mensagens_ate,
                substituida_em: h.substituida_em,
              }
            : null,
        };
      }),
    };
  },
};
