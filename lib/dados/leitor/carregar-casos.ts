/**
 * CARREGAR OS CASOS DA BATERIA — o dono da plataforma manda o arquivo do Gestor
 * (PM-027 §9: "as conversas dos casos ficam copiadas e congeladas dentro do
 * CRM"). Dois formatos:
 *
 *   - Regra v2 (`bateria_48.json`): cada caso acha o lead pela data de criação
 *     na organização de ORIGEM, copia a conversa inteira do contato até
 *     `congelar_ate`, e o gabarito é a ficha inteira (forma curta do Gestor);
 *   - Casos do Gestor (`Casos_Novos_Gestor.json`): entram os que têm ficha no
 *     gabarito. Os inventados trazem a conversa escrita no arquivo (sem dado
 *     pessoal, sem origem); os reais só entram com `achar_no_crm.lead_criado_em`
 *     — sem isso não há como achar a conversa, e o caso volta na lista de ignorados.
 *
 * Caso que já está ativo não é carregado de novo (`substituir` troca, com versão
 * nova e o motivo). A conversa congelada é o texto que o modelo lê
 * (`transcreverConversa`), com as variáveis do prompt da origem naquele dia.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { fusoUtilizavel } from "@/lib/tempo/fusos";

import { daFormaCurta, fichaCurtaSchema, type GabaritoDoCaso } from "./bateria";
import { gabaritoParaOBanco } from "./bateria-rodada";
import { configDoLeitor } from "./config";
import { transcreverConversa, type MensagemParaOLeitor, type VariaveisDoPrompt } from "./prompt";
import { mensagensDoContato, variaveisDoPromptDaOrg } from "./rodada";

const regraV2Schema = z.object({
  versao: z.string().optional(),
  relogio_da_regra: z.string(),
  casos: z.array(
    z.object({
      id: z.string().min(1).max(40),
      achar_no_crm: z.object({ lead_criado_em: z.string() }).passthrough(),
      congelar_ate: z.string(),
      ficha: fichaCurtaSchema,
    }).passthrough(),
  ).max(500),
}).passthrough();

const gestorSchema = z.object({
  casos: z.array(
    z.object({
      id: z.string().min(1).max(40),
      origem: z.string(),
      organizacao: z.string().optional(),
      bloqueia: z.boolean(),
      relogio: z.array(z.string()).optional(),
      conversa: z.array(z.tuple([z.string(), z.string()])).optional(),
      achar_no_crm: z.object({ lead_criado_em: z.string() }).partial().passthrough().optional(),
      esperado: z.object({ ficha: z.record(z.string(), z.unknown()).optional(), situacao: z.string().optional(), temperatura: z.string().optional() }).passthrough(),
    }).passthrough(),
  ).max(500),
}).passthrough();

export type FormatoDosCasos = "regra_v2" | "gestor";

export interface ResultadoDaCarga {
  criados: string[];
  ignorados: Array<{ id: string; motivo: string }>;
}

interface NovoCaso {
  caso_id: string;
  origem_organization_id: string | null;
  origem_contact_id: string | null;
  origem_lead_id: string | null;
  bloqueia: boolean;
  relogio: string;
  conversa: string;
  prompt_variaveis: VariaveisDoPrompt;
  gabarito: Record<string, unknown>;
}

async function gravar(admin: SupabaseClient, c: NovoCaso, substituir: boolean, r: ResultadoDaCarga): Promise<void> {
  const { data: ativo } = await admin
    .from("leitor_bateria_casos")
    .select("id, versao")
    .eq("caso_id", c.caso_id)
    .eq("ativo", true)
    .maybeSingle();
  const atual = ativo as { id: string; versao: number } | null;
  if (atual && !substituir) {
    r.ignorados.push({ id: c.caso_id, motivo: "já está na bateria" });
    return;
  }
  const { data: ultima } = await admin
    .from("leitor_bateria_casos")
    .select("versao")
    .eq("caso_id", c.caso_id)
    .order("versao", { ascending: false })
    .limit(1)
    .maybeSingle();
  const versao = ((ultima as { versao?: number } | null)?.versao ?? 0) + 1;
  if (atual) await admin.from("leitor_bateria_casos").update({ ativo: false }).eq("id", atual.id);
  const { error } = await admin.from("leitor_bateria_casos").insert({
    ...c,
    versao,
    ativo: true,
    motivo_da_versao: atual ? "Substituído por um arquivo novo do Gestor" : null,
  });
  if (error) {
    r.ignorados.push({ id: c.caso_id, motivo: `não gravou: ${error.message.slice(0, 120)}` });
    return;
  }
  r.criados.push(c.caso_id);
}

/** Um caso real: acha o lead pela data de criação na origem e congela a conversa. */
async function congelarReal(
  admin: SupabaseClient,
  origem: { id: string; display_name: string | null; timezone: string | null; settings: unknown },
  leadCriadoEm: string,
  ate: Date,
): Promise<{ contato: string; lead: string; conversa: string; variaveis: VariaveisDoPrompt } | { motivo: string }> {
  const { data: leads } = await admin
    .from("crm_leads")
    .select("id, contact_id")
    .eq("organization_id", origem.id)
    .eq("created_at", leadCriadoEm)
    .limit(2);
  const lista = (leads ?? []) as Array<{ id: string; contact_id: string | null }>;
  if (lista.length !== 1) return { motivo: lista.length === 0 ? "lead não encontrado na organização de origem" : "mais de um lead com essa data" };
  const lead = lista[0]!;
  if (!lead.contact_id) return { motivo: "o lead não tem contato" };
  const mensagens = await mensagensDoContato(admin, origem.id, lead.contact_id, ate);
  if (mensagens.length === 0) return { motivo: "a conversa está vazia até a data do caso" };
  const variaveis = await variaveisDoPromptDaOrg(admin, origem, configDoLeitor(origem.settings));
  return { contato: lead.contact_id, lead: lead.id, conversa: transcreverConversa(mensagens, fusoUtilizavel(origem.timezone)), variaveis };
}

/**
 * A conversa escrita no arquivo (caso inventado), com horário: a mensagem que cria a
 * espera cai no "desde" do gabarito; sem ele, a conversa termina 2 horas antes do relógio.
 */
export function conversaInventada(
  falas: Array<[string, string]>,
  relogio: Date,
  desde: string | null,
): MensagemParaOLeitor[] {
  const MIN = 60_000;
  const inicio = desde ? Date.parse(desde) : relogio.getTime() - 2 * 3_600_000 - (falas.length - 1) * MIN;
  return falas.map(([quem, texto], i) => ({
    direction: quem === "lead" ? "inbound" : "outbound",
    sent_via: quem === "lead" ? "external_device" : quem === "ia" ? "ai" : "external_device",
    type: "text",
    body: texto,
    media_derived_text: null,
    status: quem === "lead" ? "received" : "delivered",
    created_at: new Date(inicio + i * MIN).toISOString(),
  }));
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export async function carregarCasos(
  admin: SupabaseClient,
  entrada: { formato: FormatoDosCasos; origemOrganizationId: string | null; arquivo: unknown; substituir: boolean },
): Promise<ResultadoDaCarga> {
  const r: ResultadoDaCarga = { criados: [], ignorados: [] };
  type Origem = { id: string; display_name: string | null; timezone: string | null; settings: unknown };
  let origem: Origem | null = null;
  if (entrada.origemOrganizationId) {
    const { data } = await admin
      .from("organizations")
      .select("id, display_name, timezone, settings")
      .eq("id", entrada.origemOrganizationId)
      .maybeSingle();
    origem = (data as Origem | null) ?? null;
  }

  if (entrada.formato === "regra_v2") {
    const arq = regraV2Schema.parse(entrada.arquivo);
    if (!origem) throw new Error("origem_obrigatoria");
    const ano = new Date(arq.relogio_da_regra).getUTCFullYear();
    for (const c of arq.casos) {
      const ate = new Date(c.congelar_ate);
      const real = await congelarReal(admin, origem, c.achar_no_crm.lead_criado_em, ate);
      if ("motivo" in real) {
        r.ignorados.push({ id: c.id, motivo: real.motivo });
        continue;
      }
      const { ficha, banco } = daFormaCurta(c.ficha, ano);
      const gabarito: GabaritoDoCaso = { tipo: "regra_v2", ficha, banco };
      await gravar(
        admin,
        {
          caso_id: c.id,
          origem_organization_id: origem.id,
          origem_contact_id: real.contato,
          origem_lead_id: real.lead,
          bloqueia: true,
          relogio: ate.toISOString(),
          conversa: real.conversa,
          prompt_variaveis: real.variaveis,
          gabarito: gabaritoParaOBanco(gabarito),
        },
        entrada.substituir,
        r,
      );
    }
    return r;
  }

  const arq = gestorSchema.parse(entrada.arquivo);
  // Os tipos de lead dos casos inventados de uma mesma "organização" do arquivo.
  const tiposPorOrg = new Map<string, Set<string>>();
  for (const c of arq.casos) {
    const interesse = c.esperado.ficha?.interesse;
    if (c.origem === "inventado" && typeof interesse === "string") {
      const k = c.organizacao ?? "";
      tiposPorOrg.set(k, (tiposPorOrg.get(k) ?? new Set()).add(interesse));
    }
  }
  for (const c of arq.casos) {
    const fichaEsperada = c.esperado.ficha;
    if (!fichaEsperada || Object.keys(fichaEsperada).length === 0) {
      r.ignorados.push({ id: c.id, motivo: "não testa a ficha (é caso de aviso, painel ou gatilho)" });
      continue;
    }
    const relogioIso = (c.relogio ?? []).find((x) => ISO.test(x));
    const relogio = relogioIso ? new Date(relogioIso) : new Date();
    const gabarito: GabaritoDoCaso = {
      tipo: "parcial",
      ficha: fichaEsperada as GabaritoDoCaso["ficha"],
      banco: { ultima_fala_do_lead: null, duplicado: false, nunca_respondido: false, midia_nao_entendida: false },
      ...(c.esperado.situacao ? { situacao: c.esperado.situacao } : {}),
      ...(c.esperado.temperatura ? { temperatura: c.esperado.temperatura } : {}),
    };
    if (c.origem === "inventado" && c.conversa) {
      const espera = (fichaEsperada.esperando_a_equipe ?? null) as { desde?: string } | null;
      const msgs = conversaInventada(c.conversa, relogio, espera?.desde ?? null);
      gabarito.banco.ultima_fala_do_lead = new Date(
        Math.max(...msgs.filter((m) => m.direction === "inbound").map((m) => Date.parse(m.created_at)), 0) || relogio.getTime(),
      );
      await gravar(
        admin,
        {
          caso_id: c.id,
          origem_organization_id: null,
          origem_contact_id: null,
          origem_lead_id: null,
          bloqueia: c.bloqueia,
          relogio: relogio.toISOString(),
          conversa: transcreverConversa(msgs, "America/Sao_Paulo"),
          prompt_variaveis: {
            organizacao: c.organizacao ?? "Empresa de teste",
            agentes: ["Assistente"],
            tipos: [...(tiposPorOrg.get(c.organizacao ?? "") ?? [])].map((nome) => ({ nome, requisitos: [] })),
            prefixosDeAnuncio: [],
            termoDoContrato: "contrato",
          },
          gabarito: gabaritoParaOBanco(gabarito),
        },
        entrada.substituir,
        r,
      );
      continue;
    }
    const criadoEm = c.achar_no_crm?.lead_criado_em;
    if (!criadoEm || !origem) {
      r.ignorados.push({ id: c.id, motivo: "caso real sem achar_no_crm.lead_criado_em (ou sem organização de origem)" });
      continue;
    }
    const real = await congelarReal(admin, origem, criadoEm, relogio);
    if ("motivo" in real) {
      r.ignorados.push({ id: c.id, motivo: real.motivo });
      continue;
    }
    await gravar(
      admin,
      {
        caso_id: c.id,
        origem_organization_id: origem.id,
        origem_contact_id: real.contato,
        origem_lead_id: real.lead,
        bloqueia: c.bloqueia,
        relogio: relogio.toISOString(),
        conversa: real.conversa,
        prompt_variaveis: real.variaveis,
        gabarito: gabaritoParaOBanco(gabarito),
      },
      entrada.substituir,
      r,
    );
  }
  return r;
}
