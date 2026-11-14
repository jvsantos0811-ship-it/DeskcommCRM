/**
 * "ESPERANDO A EQUIPE" DE UMA ORGANIZAÇÃO — PM-027 §6. Lê as quatro fontes no
 * banco e passa cada lead pela regra pura (`lib/dados/esperando-a-equipe.ts`).
 *
 * Quem entra: o lead com potencial (`lib/dados/alcance-do-leitor.ts`) e o que
 * voltou a escrever com o aviso `lead_voltou` aberto. Fora: contato bloqueado
 * (opt-out), o número interno de aviso e conversa de grupo.
 *
 * As fontes:
 *   1. a última ficha do Leitor (`crm_lead_ficha.ficha.esperando_a_equipe`) —
 *      vale mesmo depois que o Leitor para de ler: o painel usa a última ficha
 *      mais o relógio;
 *   2. a passagem para humano (`conversations.last_handoff_at`; o motivo
 *      "Atendimento manual pelo canal" quer dizer que uma pessoa já respondeu)
 *      e o caso humano aberto (`agent_cases.status = 'awaiting_human'`, o mesmo
 *      que gera `case_stale` na Central);
 *   3. a etapa com `requires_human`, desde `crm_leads.stage_changed_at`.
 *
 * Roda com o cliente de serviço e filtra a organização à mão em toda consulta;
 * quem chama decide quem pode ver (a rota exige ver a organização inteira).
 * Nunca depende de nome de funil, etapa ou cliente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { alcanceDaOrg, funisLidos, posicaoNoAlcance, type FunilDaOrg } from "@/lib/dados/alcance-do-leitor";
import {
  avaliarEspera,
  marcarRespostasAutomaticas,
  type FalaDaConversa,
  type FontesDaEspera,
  type MotivoDaEspera,
  type QuemFalouPorUltimo,
} from "@/lib/dados/esperando-a-equipe";
import { expedienteDaOrg } from "@/lib/dados/expediente";
import { lerFicha } from "@/lib/dados/ficha";
import { configDoLeitor, configEfetivaDoLeitor, leitorPeloClaude } from "@/lib/dados/leitor/config";
import { lerPadraoDoLeitor } from "@/lib/dados/leitor/padrao";
import { MOTIVO_ATENDIMENTO_MANUAL } from "@/lib/escalacao/atendimento-manual";
import { ehContatoDoNumeroInterno } from "@/lib/escalacao/numero-interno-de-aviso";
import { lerTextosAutomaticos } from "@/lib/messaging/textos-automaticos";
import { buscaEmLotes } from "@/lib/supabase/em-lotes";

/** Teto de mensagens de um contato lidas desde o começo da espera. */
export const MENSAGENS_POR_CONTATO = 1_000;
const PAGINA = 1_000;
const CONTATOS_EM_PARALELO = 8;

export interface LeadEsperandoAEquipe {
  lead_id: string;
  pipeline_id: string;
  contact_id: string;
  motivo: MotivoDaEspera;
  desde: string;
  /** Dias úteis esperando, com uma casa. */
  dias_uteis: number;
  quem_falou_por_ultimo: QuemFalouPorUltimo;
}

export interface EsperandoAEquipeDaOrg {
  /** O Leitor está ligado na organização (o painel só existe com ele). */
  ligado: boolean;
  /** Só os que passaram de 2 dias úteis, do que espera há mais tempo ao mais recente. */
  leads: LeadEsperandoAEquipe[];
  /** Quantos leads de algum funil o painel não conseguiu avaliar (a consulta falhou). */
  falhas: number;
}

interface LeadRow {
  id: string;
  contact_id: string | null;
  pipeline_id: string;
  tags: string[] | null;
  stage_changed_at: string | null;
  etapa: { is_won: boolean; is_lost: boolean; is_archived: boolean; requires_human: boolean | null } | null;
}

interface ConversaRow {
  id: string;
  contact_id: string | null;
  last_handoff_at: string | null;
  last_handoff_reason: string | null;
}

interface MensagemRow extends FalaDaConversa {
  body: string | null;
}

function data(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function todasAsPaginas<T>(
  pagina: (de: number, ate: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  teto = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  const out: T[] = [];
  for (let de = 0; de < teto; de += PAGINA) {
    const { data: linhas, error } = await pagina(de, Math.min(de + PAGINA, teto) - 1);
    if (error) throw new Error(error.message);
    out.push(...(linhas ?? []));
    if ((linhas ?? []).length < PAGINA) break;
  }
  return out;
}

async function emParalelo<T, R>(itens: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(itens.length);
  let i = 0;
  const trabalhador = async () => {
    while (i < itens.length) {
      const k = i++;
      out[k] = await f(itens[k]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, trabalhador));
  return out;
}

export async function esperandoAEquipeDaOrg(
  admin: SupabaseClient,
  orgId: string,
  agora: Date,
  opcoes: { pipelineId?: string } = {},
): Promise<EsperandoAEquipeDaOrg> {
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("settings, timezone, created_at")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr) throw new Error(`organizacao: ${orgErr.message}`);
  const settings = (org as { settings: unknown } | null)?.settings ?? null;
  // "Ligado" é o da configuração EFETIVA: quem nunca mexeu segue o modelo padrão da instalação.
  const criadaEm = (org as { created_at?: string | null } | null)?.created_at ?? null;
  const efetiva = configEfetivaDoLeitor(configDoLeitor(settings), criadaEm, await lerPadraoDoLeitor(admin));
  // PC-036: a organização lida pelo Claude tem ficha, embora o Leitor do CRM esteja desligado nela.
  if (!efetiva.ligado && !leitorPeloClaude(efetiva)) {
    return { ligado: false, leads: [], falhas: 0 };
  }
  const expediente = expedienteDaOrg(settings, (org as { timezone: string | null } | null)?.timezone ?? null);
  const alcance = alcanceDaOrg(settings);

  const { data: funisData, error: funisErr } = await admin
    .from("crm_pipelines")
    .select("id, is_archived, is_client_pipeline")
    .eq("organization_id", orgId);
  if (funisErr) throw new Error(`funis: ${funisErr.message}`);
  const lidos = funisLidos(alcance, (funisData ?? []) as FunilDaOrg[]);
  const funis = [...lidos].filter((id) => !opcoes.pipelineId || id === opcoes.pipelineId);
  if (funis.length === 0) return { ligado: true, leads: [], falhas: 0 };

  // 1. Os leads com potencial, e os que voltaram com o aviso aberto.
  const leads = await todasAsPaginas<LeadRow>((de, ate) =>
    admin
      .from("crm_leads")
      .select(
        "id, contact_id, pipeline_id, tags, stage_changed_at, etapa:crm_stages!crm_leads_stage_id_fkey(is_won, is_lost, is_archived, requires_human)",
      )
      .eq("organization_id", orgId)
      .in("pipeline_id", funis)
      .order("id")
      .range(de, ate) as unknown as PromiseLike<{ data: LeadRow[] | null; error: { message: string } | null }>,
  );
  const podeVoltar: LeadRow[] = [];
  const noAlcance: LeadRow[] = [];
  for (const l of leads) {
    if (!l.contact_id || !l.etapa) continue;
    const p = posicaoNoAlcance({ pipeline_id: l.pipeline_id, tags: l.tags, etapa: l.etapa }, lidos, alcance);
    if (p === "com_potencial") noAlcance.push(l);
    else if (p === "pode_voltar") podeVoltar.push(l);
  }
  if (podeVoltar.length > 0) {
    const { data: avisos, error } = await buscaEmLotes(
      podeVoltar.map((l) => l.id),
      (lote) =>
        admin
          .from("agent_inbox_items")
          .select("ref_id")
          .eq("organization_id", orgId)
          .eq("kind", "lead_voltou")
          .eq("status", "open")
          .in("ref_id", lote) as unknown as PromiseLike<{ data: Array<{ ref_id: string }> | null; error: { message: string } | null }>,
    );
    if (error) throw new Error(`avisos: ${error.message}`);
    const voltou = new Set(avisos.map((a) => a.ref_id));
    for (const l of podeVoltar) if (voltou.has(l.id)) noAlcance.push(l);
  }
  if (noAlcance.length === 0) return { ligado: true, leads: [], falhas: 0 };

  // 2. Contatos bloqueados ficam de fora.
  const contatos = [...new Set(noAlcance.map((l) => l.contact_id!))];
  const { data: cs, error: cErr } = await buscaEmLotes(contatos, (lote) =>
    admin.from("contacts").select("id, is_blocked").eq("organization_id", orgId).in("id", lote) as unknown as PromiseLike<{
      data: Array<{ id: string; is_blocked: boolean | null }> | null;
      error: { message: string } | null;
    }>,
  );
  if (cErr) throw new Error(`contatos: ${cErr.message}`);
  const bloqueado = new Set(cs.filter((c) => c.is_blocked).map((c) => c.id));
  const vivos = noAlcance.filter((l) => !bloqueado.has(l.contact_id!));

  // 3. As fontes: ficha, passagem, caso humano aberto.
  const { data: fichas, error: fErr } = await buscaEmLotes(
    vivos.map((l) => l.id),
    (lote) =>
      admin.from("crm_lead_ficha").select("lead_id, ficha").eq("organization_id", orgId).in("lead_id", lote) as unknown as PromiseLike<{
        data: Array<{ lead_id: string; ficha: unknown }> | null;
        error: { message: string } | null;
      }>,
  );
  if (fErr) throw new Error(`fichas: ${fErr.message}`);
  const esperaDaFicha = new Map<string, NonNullable<FontesDaEspera["ficha"]>>();
  for (const f of fichas) {
    const e = lerFicha(f.ficha)?.esperando_a_equipe;
    const desde = data(e?.desde);
    if (e && desde) esperaDaFicha.set(f.lead_id, { motivo: e.motivo, desde });
  }

  const { data: convs, error: convErr } = await buscaEmLotes(
    [...new Set(vivos.map((l) => l.contact_id!))],
    (lote) =>
      admin
        .from("conversations")
        .select("id, contact_id, last_handoff_at, last_handoff_reason")
        .eq("organization_id", orgId)
        .eq("is_group", false)
        .in("contact_id", lote) as unknown as PromiseLike<{ data: ConversaRow[] | null; error: { message: string } | null }>,
  );
  if (convErr) throw new Error(`conversas: ${convErr.message}`);
  const conversasDoContato = new Map<string, string[]>();
  const contatoDaConversa = new Map<string, string>();
  const passagemDoContato = new Map<string, NonNullable<FontesDaEspera["passagem"]>>();
  for (const c of convs) {
    if (!c.contact_id) continue;
    conversasDoContato.set(c.contact_id, [...(conversasDoContato.get(c.contact_id) ?? []), c.id]);
    contatoDaConversa.set(c.id, c.contact_id);
    const em = data(c.last_handoff_at);
    const atual = passagemDoContato.get(c.contact_id);
    if (em && (!atual || em > atual.em)) {
      passagemDoContato.set(c.contact_id, { em, manualPeloCanal: c.last_handoff_reason === MOTIVO_ATENDIMENTO_MANUAL });
    }
  }

  const { data: casos, error: casoErr } = await buscaEmLotes([...contatoDaConversa.keys()], (lote) =>
    admin
      .from("agent_cases")
      .select("lead_id, conversation_id, opened_at")
      .eq("organization_id", orgId)
      .eq("status", "awaiting_human")
      .in("conversation_id", lote) as unknown as PromiseLike<{
      data: Array<{ lead_id: string | null; conversation_id: string; opened_at: string }> | null;
      error: { message: string } | null;
    }>,
  );
  if (casoErr) throw new Error(`casos: ${casoErr.message}`);
  const casoDoLead = new Map<string, Date>();
  const casoDoContato = new Map<string, Date>();
  for (const c of casos) {
    const desde = data(c.opened_at);
    if (!desde) continue;
    const alvo = c.lead_id ? casoDoLead : casoDoContato;
    const chave = c.lead_id ?? contatoDaConversa.get(c.conversation_id);
    if (!chave) continue;
    const antes = alvo.get(chave);
    if (!antes || desde < antes) alvo.set(chave, desde);
  }

  const fontes = new Map<string, FontesDaEspera>();
  for (const l of vivos) {
    const contato = l.contact_id!;
    const caso = casoDoLead.get(l.id) ?? casoDoContato.get(contato) ?? null;
    const etapaDesde = l.etapa?.requires_human ? data(l.stage_changed_at) : null;
    const f: FontesDaEspera = {
      ficha: esperaDaFicha.get(l.id) ?? null,
      passagem: passagemDoContato.get(contato) ?? null,
      casoAberto: caso ? { desde: caso } : null,
      etapaSoHumano: etapaDesde ? { desde: etapaDesde } : null,
    };
    if (f.ficha || f.passagem || f.casoAberto || f.etapaSoHumano) fontes.set(l.id, f);
  }
  if (fontes.size === 0) return { ligado: true, leads: [], falhas: 0 };

  // 4. Os textos que a organização usa como mensagem automática do celular.
  const automaticos = await lerTextosAutomaticos(admin, orgId, agora);

  // 5. Cada lead com fonte: as mensagens do contato desde a fonte mais antiga.
  const comFonte = vivos.filter((l) => fontes.has(l.id));
  const porContato = new Map<string, LeadRow[]>();
  for (const l of comFonte) porContato.set(l.contact_id!, [...(porContato.get(l.contact_id!) ?? []), l]);
  const ehInterno = new Map<string, boolean>();
  let falhas = 0;
  const resultado: LeadEsperandoAEquipe[] = [];

  await emParalelo([...porContato], CONTATOS_EM_PARALELO, async ([contato, doContato]) => {
    try {
      if (!ehInterno.has(contato)) ehInterno.set(contato, await ehContatoDoNumeroInterno(admin, orgId, contato));
      if (ehInterno.get(contato)) return;
      const ids = conversasDoContato.get(contato) ?? [];
      const inicios = doContato.flatMap((l) => {
        const f = fontes.get(l.id)!;
        return [f.ficha?.desde, f.passagem?.em, f.casoAberto?.desde, f.etapaSoHumano?.desde].filter((x): x is Date => !!x);
      });
      const desde = new Date(Math.min(...inicios.map((d) => d.getTime())) - 60_000);
      let mensagens: MensagemRow[] = [];
      if (ids.length > 0) {
        const { data: depois, error } = await admin
          .from("messages")
          .select("direction, sent_via, status, created_at, body")
          .eq("organization_id", orgId)
          .in("conversation_id", ids)
          .gte("created_at", desde.toISOString())
          .order("created_at", { ascending: true })
          .limit(MENSAGENS_POR_CONTATO);
        if (error) throw new Error(error.message);
        mensagens = (depois ?? []) as MensagemRow[];
        if (mensagens.length === 0) {
          // Sem mensagem depois do começo: a última de antes diz quem falou por último.
          const { data: ultima, error: uErr } = await admin
            .from("messages")
            .select("direction, sent_via, status, created_at, body")
            .eq("organization_id", orgId)
            .in("conversation_id", ids)
            .order("created_at", { ascending: false })
            .limit(1);
          if (uErr) throw new Error(uErr.message);
          mensagens = (ultima ?? []) as MensagemRow[];
        }
      }
      const falas = marcarRespostasAutomaticas(mensagens, automaticos);
      for (const l of doContato) {
        const r = avaliarEspera(fontes.get(l.id)!, falas, agora, expediente);
        if (!r.esperando || !r.noPainel) continue;
        resultado.push({
          lead_id: l.id,
          pipeline_id: l.pipeline_id,
          contact_id: contato,
          motivo: r.motivo,
          desde: r.desde.toISOString(),
          dias_uteis: Math.ceil(r.diasUteis * 10) / 10,
          quem_falou_por_ultimo: r.quemFalouPorUltimo,
        });
      }
    } catch {
      falhas += doContato.length;
    }
  });

  resultado.sort((a, b) => Date.parse(a.desde) - Date.parse(b.desde));
  return { ligado: true, leads: resultado, falhas };
}
