/**
 * O LEITOR PELO CLAUDE (PC-036) com um banco em memória: quem a porta Ficha
 * manda ler (a MESMA seleção do Leitor do CRM), o material da leitura, a
 * gravação da ficha (validação, histórico com a origem, regra fixa, aviso do
 * lead que voltou, nada além da ficha) e o fechamento da rodada.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Tirar `origem === "claude"` de `configEfetivaDoLeitor`: o caso "o cron do
 *   CRM nunca chama modelo" acusa (a organização volta a ser candidata).
 * - Tirar a checagem da escolha em `orgPeloClaude`: o caso da recusa acusa.
 * - Gravar sem `fichaDoLeitorSchema`: o caso da ficha inválida acusa.
 * - Trocar `selecionarParaLeitura` por outra seleção: o caso "o mesmo conjunto
 *   do Leitor do CRM" acusa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const audit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
const gerarRetrato = vi.fn(async (..._a: unknown[]) => ({ gravado: true, dia: "2026-11-06", leads: 3, apagados: 0 }));
vi.mock("@/lib/dados/gerar-retrato", () => ({ gerarRetratoDaOrg: (...a: unknown[]) => gerarRetrato(...a) }));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({ ehContatoDoNumeroInterno: async () => false }));

import type { FichaDoLeitor } from "@/lib/dados/ficha";

import { configDoLeitor, configEfetivaDoLeitor, leitorPeloClaude } from "./config";
import type { Leitor, ResultadoDaLeitura } from "./ler-lead";
import {
  concluirRodadaPeloClaude,
  gravarFichaPeloClaude,
  materialDaLeitura,
  pendentesPeloClaude,
  RecusaDoLeitorPeloClaude,
} from "./pelo-claude";
import { CHAVE_DO_PADRAO_DO_LEITOR } from "./padrao";
import { passadaDoLeitor, type OrgDoLeitor } from "./rodada";
import { crmLerFichas } from "@/lib/mcp/agencia/ferramentas-da-ficha";
import { cronDoLeitor, retratoEsperaOLeitor } from "./rodadas";

type Linha = Record<string, unknown>;
type Tabelas = Record<string, Linha[]>;

/** Um supabase-js de mentira, só com o que o Leitor usa. */
function bancoEmMemoria(t: Tabelas) {
  let seq = 0;
  const valor = (l: Linha, col: string): unknown => {
    if (!col.includes("->")) return l[col];
    const partes = col.split(/->>?/);
    let v: unknown = l[partes[0]!];
    for (const p of partes.slice(1)) v = v && typeof v === "object" ? (v as Linha)[p] : undefined;
    return col.includes("->>") && v !== undefined && v !== null ? String(v) : v;
  };
  const from = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let ordem: { col: string; asc: boolean } | null = null;
    let limite: number | null = null;
    let pular = 0;
    let embed = false;
    let atualizar: Linha | null = null;
    let inserir: Linha | null = null;
    let upsert: { row: Linha; chaves: string[] } | null = null;
    const linhas = () => (t[tabela] ??= []);
    const resultado = () => {
      if (upsert) {
        const { row, chaves } = upsert;
        const existente = linhas().find((l) => chaves.every((c) => l[c] === row[c]));
        if (existente && tabela === "crm_lead_ficha" && existente.lida_em !== row.lida_em) {
          // o gatilho do banco (9022/9033): a leitura substituída vai para o histórico, com a origem
          (t.crm_lead_ficha_historico ??= []).push({ ...existente, origem: existente.origem ?? "leitor_do_crm", substituida_em: new Date().toISOString() });
        }
        if (existente) Object.assign(existente, row);
        else linhas().push({ id: `id-${++seq}`, ...(tabela === "crm_lead_ficha" ? { origem: "leitor_do_crm" } : {}), ...row });
        return { data: [row], error: null };
      }
      if (inserir) {
        const nova: Linha = { id: `id-${++seq}`, created_at: new Date().toISOString(), ...inserir };
        if (tabela === "agent_inbox_items") {
          nova.status ??= "open";
          const dup = linhas().some((l) => l.status === "open" && l.kind === nova.kind && l.ref_id === nova.ref_id);
          if (dup) return { data: null, error: { code: "23505", message: "duplicate" } };
        }
        if (tabela === "leitor_rodadas") {
          nova.iniciada_em ??= new Date().toISOString();
          nova.terminada_em ??= null;
          nova.lidos ??= 0;
          nova.falhas ??= 0;
          nova.origem ??= "diaria";
          const dup =
            (nova.origem === "diaria" || nova.origem === "claude") &&
            linhas().some((l) => l.organization_id === nova.organization_id && l.dia === nova.dia && l.origem === nova.origem);
          if (dup) return { data: null, error: { code: "23505", message: "duplicate" } };
        }
        linhas().push(nova);
        return { data: [nova], error: null };
      }
      let r = linhas().filter((l) => filtros.every((f) => f(l)));
      if (atualizar) {
        for (const l of r) Object.assign(l, atualizar);
        return { data: r, error: null };
      }
      if (ordem) {
        const { col, asc } = ordem;
        r = [...r].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      if (limite !== null) r = r.slice(pular, pular + limite);
      if (embed && tabela === "crm_leads") {
        r = r.map((l) => ({ ...l, etapa: (t.crm_stages ?? []).find((s) => s.id === l.stage_id) ?? null }));
      }
      return { data: r, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: (cols?: string) => {
        if (cols?.includes("crm_stages!")) embed = true;
        return b;
      },
      eq: (col: string, v: unknown) => (filtros.push((l) => valor(l, col) === v), b),
      in: (col: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[col])), b),
      gte: (col: string, v: string) => (filtros.push((l) => String(l[col] ?? "") >= v), b),
      lte: (col: string, v: string) => (filtros.push((l) => String(l[col] ?? "") <= v), b),
      gt: (col: string, v: string) => (filtros.push((l) => l[col] != null && String(l[col]) > v), b),
      lt: (col: string, v: string) => (filtros.push((l) => l[col] != null && String(l[col]) < v), b),
      is: (col: string, v: unknown) => (filtros.push((l) => (l[col] ?? null) === v), b),
      not: (col: string, _op: string, v: unknown) => (filtros.push((l) => (l[col] ?? null) !== v), b),
      order: (col: string, o?: { ascending?: boolean }) => ((ordem = { col, asc: o?.ascending !== false }), b),
      limit: (n: number) => ((limite = n), b),
      range: (de: number, ate: number) => ((pular = de), (limite = ate - de + 1), b),
      insert: (row: Linha) => ((inserir = row), b),
      update: (vals: Linha) => ((atualizar = vals), b),
      upsert: (row: Linha, o: { onConflict: string }) => ((upsert = { row, chaves: o.onConflict.split(",") }), b),
      maybeSingle: () => {
        const r = resultado();
        return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : null, error: r.error });
      },
      then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => Promise.resolve(resultado()).then(ok, erro),
    };
    return b;
  };
  return { from };
}


const ORG = "org-a";
const FUNIL = "funil-vendas";
const ATIVA = "etapa-recepcao";
const PERDIDA = "etapa-perdida";
const LIGADO_EM = "2026-11-02T09:00:00.000Z";
const AGORA = new Date("2026-11-06T09:05:00.000Z"); // 06:05 em São Paulo
const PELO_CLAUDE = { escolha: "claude", ligado: false, ligado_em: LIGADO_EM };

function orgRow(leitor: Record<string, unknown> = PELO_CLAUDE) {
  return {
    id: ORG,
    settings: { leitor },
    timezone: "America/Sao_Paulo",
    display_name: "Clínica Teste",
    locale: "pt-BR",
    created_at: "2026-09-01T12:00:00.000Z",
    status: "active",
  };
}

function ficha(over: Partial<FichaDoLeitor> = {}): FichaDoLeitor {
  return {
    contato: "lead",
    interesse: "Implante",
    interesse_texto: null,
    contou_o_caso: "sim",
    requisitos: "a_confirmar",
    requisitos_faltando: [],
    requisito_em_risco: false,
    negociacao: "nenhuma",
    objecao: "nenhuma",
    fora_da_area: false,
    sem_caso: false,
    recusou: false,
    ja_atendido_por_outro: false,
    confirmar_assinatura: false,
    midia_nao_entendida: false,
    aguardando: null,
    proximo_passo_com: "lead",
    palavras_proprias: true,
    esperando_a_equipe: null,
    provas: { interesse: "quero saber do implante" },
    ...over,
  };
}

/** O cenário do Leitor do CRM (rodada.test.ts), com a organização lida pelo Claude. */
function cenario(leitor: Record<string, unknown> = PELO_CLAUDE): Tabelas {
  const conversa = (id: string, contato: string, criada: string, entrada: string | null, saida: string | null = null) => ({
    id,
    organization_id: ORG,
    contact_id: contato,
    is_group: false,
    created_at: criada,
    last_inbound_at: entrada,
    last_outbound_at: saida,
    last_message_at: [entrada, saida].filter(Boolean).sort().at(-1),
  });
  const lead = (id: string, contato: string, etapa: string, criado: string) => ({
    id,
    organization_id: ORG,
    contact_id: contato,
    pipeline_id: FUNIL,
    stage_id: etapa,
    tags: [],
    created_at: criado,
  });
  const m = (conv: string, direction: string, created_at: string, body: string, sent_via = "external_device") => ({
    organization_id: ORG,
    conversation_id: conv,
    direction,
    sent_via,
    type: "text",
    body,
    media_derived_text: null,
    status: direction === "inbound" ? "received" : "delivered",
    created_at,
    sent_by_user_id: null,
  });
  return {
    organizations: [orgRow(leitor)],
    crm_pipelines: [{ id: FUNIL, organization_id: ORG, is_archived: false, is_client_pipeline: false }],
    crm_stages: [
      { id: ATIVA, name: "Recepção", is_won: false, is_lost: false, is_archived: false },
      { id: PERDIDA, name: "Perdido", is_won: false, is_lost: true, is_archived: false },
    ],
    conversations: [
      conversa("cv-novo", "c-novo", "2026-11-05T12:00:00.000Z", "2026-11-05T12:00:00.000Z"),
      conversa("cv-parado", "c-parado", "2026-10-20T12:00:00.000Z", "2026-10-30T12:00:00.000Z", "2026-10-30T12:05:00.000Z"),
      conversa("cv-voltou", "c-voltou", "2026-10-01T12:00:00.000Z", "2026-11-05T13:00:00.000Z", "2026-10-03T12:00:00.000Z"),
      conversa("cv-bloq", "c-bloqueado", "2026-11-04T12:00:00.000Z", "2026-11-05T14:00:00.000Z"),
    ],
    contacts: [
      { id: "c-novo", organization_id: ORG, is_blocked: false, is_anonymized: false },
      { id: "c-parado", organization_id: ORG, is_blocked: false, is_anonymized: false },
      { id: "c-voltou", organization_id: ORG, is_blocked: false, is_anonymized: false },
      { id: "c-bloqueado", organization_id: ORG, is_blocked: true, is_anonymized: false },
    ],
    crm_leads: [
      lead("l-novo", "c-novo", ATIVA, "2026-11-05T12:00:00.000Z"),
      lead("l-parado", "c-parado", ATIVA, "2026-10-20T12:00:00.000Z"),
      lead("l-voltou", "c-voltou", PERDIDA, "2026-10-01T12:00:00.000Z"),
      lead("l-bloq", "c-bloqueado", ATIVA, "2026-11-04T12:00:00.000Z"),
    ],
    messages: [
      m("cv-novo", "inbound", "2026-11-05T12:00:00.000Z", "quero saber do implante"),
      m("cv-parado", "inbound", "2026-10-30T12:00:00.000Z", "vou pensar"),
      m("cv-voltou", "outbound", "2026-10-03T12:00:00.000Z", "Qualquer coisa estamos aqui", "ai"),
      m("cv-voltou", "inbound", "2026-11-05T13:00:00.000Z", "voltei, agora quero fazer"),
      m("cv-bloq", "inbound", "2026-11-05T14:00:00.000Z", "oi"),
    ],
    ai_agents: [{ id: "ag-1", organization_id: ORG, name: "Bia" }],
    catalog_products: [{ organization_id: ORG, nome: "Implante", requisitos: ["perdeu o dente"], tipo_de_lead: true, ativo: true }],
    llm_calls: [],
    crm_lead_ficha: [],
    crm_lead_ficha_historico: [],
    agent_inbox_items: [],
    leitor_rodadas: [],
  };
}

const db = (t: Tabelas) => bancoEmMemoria(t) as never;
const opcoes = { agora: AGORA, ehInterno: async () => false };
const gravar = (over: Record<string, unknown> = {}) => ({
  lead_id: "l-novo",
  ficha: ficha(),
  mensagens_ate: "2026-11-05T12:00:00.000Z",
  gatilho: "chat_novo" as const,
  origem: "leitor_0530" as const,
  modelo: "claude-sonnet-5-5 (tarefa)",
  ...over,
});

async function recusa(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RecusaDoLeitorPeloClaude) return e.codigo;
    throw e;
  }
  throw new Error("esperava recusa");
}

beforeEach(() => {
  gerarRetrato.mockClear();
  audit.mockClear();
});

describe("a escolha `claude` na configuração", () => {
  it("sai DESLIGADA para o cron do CRM e guarda o marco só para o Claude", () => {
    const efetiva = configEfetivaDoLeitor(configDoLeitor({ leitor: PELO_CLAUDE }), null, {
      modelo: { provider: "anthropic", model_id: "claude-haiku-5-5" },
      reserva: null,
      ativo_desde: "2026-10-01T00:00:00.000Z",
      definido_em: "2026-10-01T00:00:00.000Z",
    });
    expect(efetiva).toMatchObject({ origem: "claude", ligado: false, modelo: null, ligado_em: LIGADO_EM });
    expect(leitorPeloClaude(efetiva)?.ligadoEm.toISOString()).toBe(LIGADO_EM);
    expect(leitorPeloClaude(configEfetivaDoLeitor(configDoLeitor({ leitor: { ligado: false } }), null, null))).toBeNull();
  });

  it("o cron do CRM nunca chama modelo numa organização lida pelo Claude (nem com padrão da instalação)", async () => {
    const t = cenario();
    t.platform_config = [
      {
        chave: CHAVE_DO_PADRAO_DO_LEITOR,
        valor: JSON.stringify({
          modelo: { provider: "anthropic", model_id: "claude-haiku-5-5" },
          reserva: null,
          ativo_desde: "2026-10-01T00:00:00.000Z",
          definido_em: "2026-10-01T00:00:00.000Z",
        }),
      },
    ];
    const ler: Leitor = vi.fn(async () => ({ tipo: "lida", ficha: ficha(), modelo: "x", latenciaMs: 1 }) as ResultadoDaLeitura);
    // Controle: a mesma organização seguindo o padrão É lida — o padrão foi visto pelo cron.
    const controle = { ...t, organizations: [orgRow({ escolha: "padrao", ligado_em: LIGADO_EM })], leitor_rodadas: [] as Linha[], crm_lead_ficha: [] as Linha[] };
    const lerControle: Leitor = vi.fn(async () => ({ tipo: "lida", ficha: ficha(), modelo: "claude-haiku-5-5", latenciaMs: 1 }) as ResultadoDaLeitura);
    await cronDoLeitor(db(controle), { agora: AGORA, ler: lerControle });
    expect(lerControle).toHaveBeenCalled();
    const r = await cronDoLeitor(db(t), { agora: AGORA, ler });
    expect(ler).not.toHaveBeenCalled();
    expect(r.lidos).toBe(0);
    expect(t.leitor_rodadas).toHaveLength(0);
    const p = await passadaDoLeitor(db(t), orgRow() as OrgDoLeitor, { agora: AGORA, ler, ateMs: Date.now() + 60_000 });
    expect(p.parou).toBe("desligado");
  });
});

describe("crm_leitor_pendentes", () => {
  it("recusa organização que não é lida pelo Claude", async () => {
    const t = cenario({ ligado: true, ligado_em: LIGADO_EM, modelo: { provider: "anthropic", model_id: "claude-haiku-5-5" } });
    expect(await recusa(pendentesPeloClaude(db(t), ORG, opcoes))).toBe("leitor_nao_e_pelo_claude");
    expect(t.leitor_rodadas).toHaveLength(0);
  });

  it("o mesmo conjunto do Leitor do CRM: o chat novo e o lead que voltou; nem o parado de antes nem o bloqueado", async () => {
    const t = cenario();
    const r = await pendentesPeloClaude(db(t), ORG, opcoes);
    expect(r.leads.map((l) => [l.lead_id, l.gatilho, l.posicao])).toEqual([
      ["l-voltou", "lead_voltou", "pode_voltar"],
      ["l-novo", "chat_novo", "com_potencial"],
    ]);
    expect(r).toMatchObject({ total: 2, restantes: 0, dia: "2026-11-06", lido_desde: LIGADO_EM });
    // Abre a rodada do dia uma vez só.
    await pendentesPeloClaude(db(t), ORG, opcoes);
    expect(t.leitor_rodadas!.filter((x) => x.origem === "claude")).toHaveLength(1);
  });

  it("respeita o limite e diz quantos ficaram", async () => {
    const r = await pendentesPeloClaude(db(cenario()), ORG, { ...opcoes, limite: 1 });
    expect(r.leads).toHaveLength(1);
    expect(r.restantes).toBe(1);
  });
});

describe("crm_leitor_conversa", () => {
  it("devolve o prompt do Leitor da organização, a conversa transcrita, o formato e o mensagens_ate", async () => {
    const r = await materialDaLeitura(db(cenario()), ORG, "l-novo");
    expect(r.instrucoes).toContain("Clínica Teste");
    expect(r.instrucoes).toContain("- Implante: perdeu o dente");
    expect(r.conversa).toContain("quero saber do implante");
    expect(r.mensagens_ate).toBe("2026-11-05T12:00:00.000Z");
    expect(r.versao_prompt).toBe("pm027-v1");
    expect(Object.keys((r.formato_da_ficha as { properties: Record<string, unknown> }).properties)).toContain("contou_o_caso");
    expect(r.ficha_anterior).toBeNull();
    expect(r.fatos_do_banco).toMatchObject({ duplicado: false, nunca_respondido: true });
  });

  it("recusa contato bloqueado e lead de outra organização", async () => {
    const t = cenario();
    expect(await recusa(materialDaLeitura(db(t), ORG, "l-bloq"))).toBe("contato_fora_da_leitura");
    t.crm_leads!.push({ id: "l-outra", organization_id: "org-b", contact_id: "c-novo", pipeline_id: FUNIL, stage_id: ATIVA, tags: [] });
    expect(await recusa(materialDaLeitura(db(t), ORG, "l-outra"))).toBe("lead_nao_encontrado");
  });
});

describe("crm_gravar_ficha_do_lead", () => {
  it("grava só a ficha, com a origem e o mensagens_ate da leitura, e devolve a regra fixa", async () => {
    const t = cenario();
    const antes = JSON.stringify({ leads: t.crm_leads, contacts: t.contacts, messages: t.messages, conversations: t.conversations });
    const r = await gravarFichaPeloClaude(db(t), ORG, gravar(), { agora: AGORA });
    expect(r).toMatchObject({ gravada: true, lead_id: "l-novo", mensagens_ate: "2026-11-05T12:00:00.000Z", conversa_mudou: false });
    expect(r.situacao).toBeTruthy();
    expect(t.crm_lead_ficha).toHaveLength(1);
    expect(t.crm_lead_ficha![0]).toMatchObject({
      lead_id: "l-novo",
      origem: "leitor_0530",
      modelo: "claude-sonnet-5-5 (tarefa)",
      gatilho: "chat_novo",
      versao_prompt: "pm027-v1",
      mensagens_ate: "2026-11-05T12:00:00.000Z",
    });
    // Nada além da ficha: card, contato, mensagens e conversas iguais; nenhuma chamada de IA.
    expect(JSON.stringify({ leads: t.crm_leads, contacts: t.contacts, messages: t.messages, conversations: t.conversations })).toBe(antes);
    expect(t.llm_calls).toHaveLength(0);
    expect(t.agent_inbox_items).toHaveLength(0);
  });

  it("ficha fora do schema é recusada com o nome do campo", async () => {
    const t = cenario();
    try {
      await gravarFichaPeloClaude(db(t), ORG, gravar({ ficha: { ...ficha(), contou_o_caso: "talvez" } }), { agora: AGORA });
      throw new Error("esperava recusa");
    } catch (e) {
      expect(e).toBeInstanceOf(RecusaDoLeitorPeloClaude);
      expect((e as RecusaDoLeitorPeloClaude).codigo).toBe("ficha_invalida");
      expect((e as Error).message).toContain("contou_o_caso");
    }
    expect(t.crm_lead_ficha).toHaveLength(0);
  });

  it("a leitura nova guarda a anterior no histórico; leitura mais velha que a atual é recusada", async () => {
    const t = cenario();
    await gravarFichaPeloClaude(db(t), ORG, gravar(), { agora: AGORA });
    t.messages!.push({
      organization_id: ORG,
      conversation_id: "cv-novo",
      direction: "inbound",
      sent_via: "external_device",
      type: "text",
      body: "perdi o dente no ano passado",
      media_derived_text: null,
      status: "received",
      created_at: "2026-11-06T08:00:00.000Z",
      sent_by_user_id: null,
    });
    await new Promise((ok) => setTimeout(ok, 5));
    await gravarFichaPeloClaude(db(t), ORG, gravar({ mensagens_ate: "2026-11-06T08:00:00.000Z", gatilho: "mensagem_do_lead", origem: "gestor_17h10" }), {
      agora: AGORA,
    });
    expect(t.crm_lead_ficha_historico).toHaveLength(1);
    expect(t.crm_lead_ficha_historico![0]).toMatchObject({ origem: "leitor_0530", mensagens_ate: "2026-11-05T12:00:00.000Z" });
    expect(t.crm_lead_ficha![0]).toMatchObject({ origem: "gestor_17h10", mensagens_ate: "2026-11-06T08:00:00.000Z" });
    expect(await recusa(gravarFichaPeloClaude(db(t), ORG, gravar(), { agora: AGORA }))).toBe("leitura_mais_velha_que_a_atual");
  });

  it("mensagens_ate no futuro é recusado; mensagem depois dele avisa que a conversa mudou", async () => {
    const t = cenario();
    expect(await recusa(gravarFichaPeloClaude(db(t), ORG, gravar({ mensagens_ate: "2026-11-07T12:00:00.000Z" }), { agora: AGORA }))).toBe(
      "mensagens_ate_invalida",
    );
    t.conversations![0]!.last_message_at = "2026-11-06T08:30:00.000Z";
    const r = await gravarFichaPeloClaude(db(t), ORG, gravar(), { agora: AGORA });
    expect(r.conversa_mudou).toBe(true);
  });

  it("o lead que voltou com potencial abre o aviso na Central, uma vez", async () => {
    const t = cenario();
    const g = gravar({ lead_id: "l-voltou", gatilho: "lead_voltou", mensagens_ate: "2026-11-05T13:00:00.000Z" });
    const r = await gravarFichaPeloClaude(db(t), ORG, g, { agora: AGORA });
    expect(r.aviso_lead_voltou).toBe(true);
    expect(t.agent_inbox_items).toHaveLength(1);
    expect(t.agent_inbox_items![0]).toMatchObject({ kind: "lead_voltou", ref_id: "l-voltou" });
  });

  it("recusa organização que não é lida pelo Claude", async () => {
    const t = cenario({ escolha: "desligado" });
    expect(await recusa(gravarFichaPeloClaude(db(t), ORG, gravar(), { agora: AGORA }))).toBe("leitor_nao_e_pelo_claude");
    expect(t.crm_lead_ficha).toHaveLength(0);
  });
});

describe("crm_leitor_concluir_rodada e o retrato", () => {
  it("o retrato espera a rodada do Claude que abriu; fechada ou nem aberta, não espera", async () => {
    const t = cenario();
    const org = orgRow() as OrgDoLeitor;
    expect(await retratoEsperaOLeitor(db(t), org, AGORA, null)).toBe(false);
    await pendentesPeloClaude(db(t), ORG, opcoes);
    expect(await retratoEsperaOLeitor(db(t), org, AGORA, null)).toBe(true);
    await gravarFichaPeloClaude(db(t), ORG, gravar(), { agora: AGORA });
    const r = await concluirRodadaPeloClaude(db(t), ORG, { lidos: 2, erros: 1, ultimo_erro: "ficha_invalida" }, { agora: AGORA });
    expect(r).toMatchObject({ dia: "2026-11-06", gravadas: 1, lidos_informados: 2, erros: 1, retrato_gerado: true });
    expect(t.leitor_rodadas!.find((x) => x.origem === "claude")).toMatchObject({ lidos: 1, falhas: 1, ultimo_erro: "ficha_invalida" });
    expect(await retratoEsperaOLeitor(db(t), org, AGORA, null)).toBe(false);
    expect(gerarRetrato).toHaveBeenCalledWith(expect.anything(), ORG, "cron", expect.objectContaining({ soSeFaltar: true }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "leitor.rodada", metadata: expect.objectContaining({ origem: "claude" }) }));
  });
});

describe("crm_ler_fichas (porta Leitura) — a conferência do Gestor", () => {
  it("devolve as fichas da janela com a origem, a regra fixa e a leitura anterior", async () => {
    const t = cenario();
    await gravarFichaPeloClaude(db(t), ORG, gravar(), { agora: AGORA });
    await new Promise((ok) => setTimeout(ok, 5));
    await gravarFichaPeloClaude(db(t), ORG, gravar({ origem: "gestor_17h10", ficha: ficha({ contou_o_caso: "parcial" }) }), {
      agora: AGORA,
    });
    const ctx = { supabase: db(t), organizationId: ORG } as never;
    const r = (await crmLerFichas.handler(
      { lida_desde: "2026-11-01T00:00:00.000Z", lida_ate: new Date(Date.now() + 60_000).toISOString() },
      ctx,
    )) as { fichas: Array<Record<string, unknown>>; tem_mais: boolean };
    expect(r.tem_mais).toBe(false);
    expect(r.fichas).toHaveLength(1);
    expect(r.fichas[0]).toMatchObject({
      lead_id: "l-novo",
      origem: "gestor_17h10",
      ficha_valida: true,
      aviso_lead_voltou_aberto: false,
      leitura_anterior: expect.objectContaining({ origem: "leitor_0530" }),
    });
    expect(r.fichas[0]!.situacao).toBeTruthy();
    expect(r.fichas[0]!.temperatura).toBeTruthy();
  });

  it("recusa janela invertida ou maior que 31 dias", async () => {
    const ctx = { supabase: db(cenario()), organizationId: ORG } as never;
    await expect(crmLerFichas.handler({ lida_desde: "2026-11-06T00:00:00Z", lida_ate: "2026-11-01T00:00:00Z" }, ctx)).rejects.toThrow(
      /validation_failed/,
    );
    await expect(crmLerFichas.handler({ lida_desde: "2026-09-01T00:00:00Z", lida_ate: "2026-11-01T00:00:00Z" }, ctx)).rejects.toThrow(
      /31 dias/,
    );
  });
});
