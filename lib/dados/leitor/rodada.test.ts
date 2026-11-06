/**
 * O Leitor com um banco em memória: a passada numa organização (quem é lido, a
 * ficha gravada, o aviso do lead que voltou, as paradas) e o ciclo das rodadas
 * (a diária das 06:00, o retrato depois dela, o retrato que espera).
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Não gravar `mensagens_ate`: a segunda passada relê e o caso "nada é lido
 *   duas vezes" acusa.
 * - Abrir o aviso sem olhar a regra: o caso do lead que voltou "sem potencial" acusa.
 * - Gerar o retrato antes de a diária terminar: o caso do ciclo acusa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const audit = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
const gerarRetrato = vi.fn(async (..._a: unknown[]) => ({ gravado: true, dia: "2026-11-06", leads: 3, apagados: 0 }));
vi.mock("@/lib/dados/gerar-retrato", () => ({ gerarRetratoDaOrg: (...a: unknown[]) => gerarRetrato(...a) }));

import type { FichaDoLeitor } from "@/lib/dados/ficha";

import type { Leitor, ResultadoDaLeitura } from "./ler-lead";
import { passadaDoLeitor, type OrgDoLeitor } from "./rodada";
import { CHAVE_DO_PADRAO_DO_LEITOR } from "./padrao";
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
    let embed = false;
    let atualizar: Linha | null = null;
    let inserir: Linha | null = null;
    let upsert: { row: Linha; chaves: string[] } | null = null;
    const linhas = () => (t[tabela] ??= []);
    const resultado = () => {
      if (upsert) {
        const { row, chaves } = upsert;
        const existente = linhas().find((l) => chaves.every((c) => l[c] === row[c]));
        if (existente) Object.assign(existente, row);
        else linhas().push({ id: `id-${++seq}`, ...row });
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
          const dup =
            nova.origem === "diaria" &&
            linhas().some((l) => l.organization_id === nova.organization_id && l.dia === nova.dia && l.origem === "diaria");
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
      if (limite !== null) r = r.slice(0, limite);
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
      is: (col: string, v: unknown) => (filtros.push((l) => (l[col] ?? null) === v), b),
      not: (col: string, _op: string, v: unknown) => (filtros.push((l) => (l[col] ?? null) !== v), b),
      order: (col: string, o?: { ascending?: boolean }) => ((ordem = { col, asc: o?.ascending !== false }), b),
      limit: (n: number) => ((limite = n), b),
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
const MODELO = { provider: "anthropic", model_id: "claude-haiku-5-5" };

function org(leitor: Record<string, unknown> = { ligado: true, ligado_em: LIGADO_EM, modelo: MODELO }): OrgDoLeitor {
  return {
    id: ORG,
    settings: { leitor },
    timezone: "America/Sao_Paulo",
    display_name: "Clínica Teste",
    locale: "pt-BR",
    created_at: "2026-09-01T12:00:00.000Z",
  };
}

function ficha(over: Partial<FichaDoLeitor> = {}): FichaDoLeitor {
  return {
    contato: "lead",
    interesse: null,
    interesse_texto: null,
    contou_o_caso: "parcial",
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
    provas: {},
    ...over,
  };
}

/**
 * - c-novo: conversa nova depois de ligar o Leitor (lida: chat novo);
 * - c-parado: só mensagens antes de ligar (NÃO lida — sem carga inicial);
 * - c-voltou: negócio em etapa perdida que escreveu de novo (lido; aviso);
 * - c-bloqueado: escreveu, mas pediu para parar (não lido).
 */
function cenario(): Tabelas {
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
      { id: "c-novo", organization_id: ORG, is_blocked: false },
      { id: "c-parado", organization_id: ORG, is_blocked: false },
      { id: "c-voltou", organization_id: ORG, is_blocked: false },
      { id: "c-bloqueado", organization_id: ORG, is_blocked: true },
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
    agent_inbox_items: [],
    leitor_rodadas: [],
  };
}

const AGORA = new Date("2026-11-06T09:05:00.000Z"); // 06:05 em São Paulo
const sempreLe = (f: FichaDoLeitor = ficha()): Leitor => vi.fn(async () => ({ tipo: "lida", ficha: f, modelo: "claude-haiku-5-5", latenciaMs: 10 }) as ResultadoDaLeitura);
const deps = (ler: Leitor, extra: Record<string, unknown> = {}) => ({
  agora: AGORA,
  ler,
  ateMs: Date.now() + 60_000,
  ehInterno: async () => false,
  ...extra,
});

beforeEach(() => {
  gerarRetrato.mockClear();
  audit.mockClear();
});

describe("uma passada do Leitor", () => {
  it("desligado (ou sem modelo): não lê nada", async () => {
    const t = cenario();
    const ler = sempreLe();
    expect((await passadaDoLeitor(bancoEmMemoria(t) as never, org({ ligado: false }), deps(ler))).parou).toBe("desligado");
    expect(
      (await passadaDoLeitor(bancoEmMemoria(t) as never, org({ escolha: "propria", ligado: true, ligado_em: LIGADO_EM }), deps(ler))).parou,
    ).toBe("sem_modelo");
    // Ligado sem modelo e sem escolha gravada (forma que nenhuma tela grava): segue o padrão — e sem padrão, desligado.
    expect(
      (await passadaDoLeitor(bancoEmMemoria(t) as never, org({ ligado: true, ligado_em: LIGADO_EM }), deps(ler))).parou,
    ).toBe("desligado");
    expect(ler).not.toHaveBeenCalled();
  });

  it("lê o chat novo e o lead que voltou; não lê o parado de antes de ligar nem o bloqueado", async () => {
    const t = cenario();
    const ler = sempreLe();
    const r = await passadaDoLeitor(bancoEmMemoria(t) as never, org(), deps(ler));
    expect(r).toMatchObject({ candidatos: 2, lidos: 2, falhas: 0, restantes: 0, avisos: 1, parou: null });
    const porLead = Object.fromEntries(t.crm_lead_ficha!.map((f) => [f.lead_id, f]));
    expect(Object.keys(porLead).sort()).toEqual(["l-novo", "l-voltou"]);
    expect(porLead["l-novo"]).toMatchObject({ gatilho: "chat_novo", versao_prompt: "pm027-v1", mensagens_ate: "2026-11-05T12:00:00.000Z" });
    expect(porLead["l-voltou"]).toMatchObject({ gatilho: "lead_voltou" });
    expect(t.agent_inbox_items).toHaveLength(1);
    expect(t.agent_inbox_items![0]).toMatchObject({ kind: "lead_voltou", ref_kind: "lead", ref_id: "l-voltou", title: "Um lead perdido voltou a escrever" });
    expect(String(t.agent_inbox_items![0]!.body)).not.toContain("c-voltou");
    // O prompt vem da organização (nome, agente, tipo do catálogo) e a conversa é a transcrita.
    const chamada = vi.mocked(ler).mock.calls[0]![0];
    expect(chamada.sistema).toContain("Clínica Teste");
    expect(chamada.sistema).toContain("Bia");
    expect(chamada.sistema).toContain("- Implante: perdeu o dente");
    expect(chamada.aprovado).toEqual(MODELO);
  });

  it("nada é lido duas vezes: a segunda passada sem mensagem nova não lê nem repete o aviso", async () => {
    const t = cenario();
    await passadaDoLeitor(bancoEmMemoria(t) as never, org(), deps(sempreLe()));
    const ler = sempreLe();
    const r = await passadaDoLeitor(bancoEmMemoria(t) as never, org(), deps(ler));
    expect(r.lidos).toBe(0);
    expect(ler).not.toHaveBeenCalled();
    expect(t.agent_inbox_items).toHaveLength(1);
  });

  it("lead que voltou sem potencial (a ficha diz que recusou) é lido, mas não abre aviso", async () => {
    const t = cenario();
    const r = await passadaDoLeitor(bancoEmMemoria(t) as never, org(), deps(sempreLe(ficha({ recusou: true }))));
    expect(r.avisos).toBe(0);
    expect(t.agent_inbox_items).toHaveLength(0);
  });

  it("LV1: o contato já tem outro card aberto (mais NOVO que o perdido) — a ficha é gravada, o aviso não abre", async () => {
    const t = cenario();
    t.crm_leads!.push({
      id: "l-voltou-aberto",
      organization_id: ORG,
      contact_id: "c-voltou",
      pipeline_id: FUNIL,
      stage_id: ATIVA,
      tags: [],
      created_at: "2026-10-20T12:00:00.000Z",
    });
    const r = await passadaDoLeitor(bancoEmMemoria(t) as never, org(), deps(sempreLe()));
    expect(t.crm_lead_ficha!.some((f) => f.lead_id === "l-voltou")).toBe(true);
    expect(r.avisos).toBe(0);
    expect(t.agent_inbox_items).toHaveLength(0);
  });

  it("modelo diferente do aprovado para a passada inteira, sem gravar ficha", async () => {
    const t = cenario();
    const ler: Leitor = vi.fn(async () => ({ tipo: "modelo_diferente", usado: "anthropic/claude-haiku-4-5", aprovado: "anthropic/claude-haiku-5-5" }) as ResultadoDaLeitura);
    const r = await passadaDoLeitor(bancoEmMemoria(t) as never, org(), deps(ler));
    expect(r.parou).toBe("modelo_diferente");
    expect(ler).toHaveBeenCalledTimes(1);
    expect(t.crm_lead_ficha).toHaveLength(0);
  });

  it("orçamento de uma leitura: o outro fica para a próxima passada", async () => {
    const t = cenario();
    const r = await passadaDoLeitor(bancoEmMemoria(t) as never, org(), deps(sempreLe(), { maxLeituras: 1 }));
    expect(r).toMatchObject({ lidos: 1, restantes: 1 });
  });
});

describe("as rodadas do Leitor", () => {
  const comOrg = (t: Tabelas, o: OrgDoLeitor) => {
    t.organizations = [{ ...o, status: "active" }];
    return t;
  };

  it("às 06:05 abre a diária, lê, fecha e gera o retrato depois", async () => {
    const t = comOrg(cenario(), org());
    const r = await cronDoLeitor(bancoEmMemoria(t) as never, { agora: AGORA, ler: sempreLe(), orcamentoMs: 60_000 });
    expect(r).toMatchObject({ organizacoes: 1, lidos: 2, terminadas: 1, retratos: 1 });
    expect(t.leitor_rodadas).toHaveLength(1);
    expect(t.leitor_rodadas![0]).toMatchObject({ origem: "diaria", dia: "2026-11-06", lidos: 2 });
    expect(t.leitor_rodadas![0]!.terminada_em).toBeTruthy();
    expect(gerarRetrato.mock.calls[0]!.slice(1, 3)).toEqual([ORG, "cron"]);
  });

  it("antes das 06:00 não abre a diária nem lê", async () => {
    const t = comOrg(cenario(), org());
    const ler = sempreLe();
    const r = await cronDoLeitor(bancoEmMemoria(t) as never, { agora: new Date("2026-11-06T08:50:00.000Z"), ler });
    expect(r.lidos).toBe(0);
    expect(t.leitor_rodadas).toHaveLength(0);
    expect(ler).not.toHaveBeenCalled();
  });

  it("o retrato espera a diária aberta, e deixa de esperar quando ela fecha ou passa de 3 horas", async () => {
    const t = cenario();
    const db = bancoEmMemoria(t) as never;
    const o = org();
    // Antes da diária abrir, até as 09:00 locais, espera.
    expect(await retratoEsperaOLeitor(db, o, AGORA, null)).toBe(true);
    t.leitor_rodadas = [
      { organization_id: ORG, origem: "diaria", dia: "2026-11-06", iniciada_em: "2026-11-06T09:00:00.000Z", terminada_em: null },
    ];
    expect(await retratoEsperaOLeitor(db, o, AGORA, null)).toBe(true);
    expect(await retratoEsperaOLeitor(db, o, new Date("2026-11-06T12:30:00.000Z"), null)).toBe(false);
    t.leitor_rodadas[0]!.terminada_em = "2026-11-06T09:10:00.000Z";
    expect(await retratoEsperaOLeitor(db, o, AGORA, null)).toBe(false);
    // Leitor desligado: nunca espera.
    expect(await retratoEsperaOLeitor(db, org({ ligado: false }), AGORA, null)).toBe(false);
  });
});

describe("o modelo padrão da instalação (PM-027: o Leitor ligado em toda empresa)", () => {
  const SONNET = { provider: "anthropic", model_id: "claude-sonnet-5-5" };
  const comPadrao = (t: Tabelas, o: OrgDoLeitor, ativoDesde = LIGADO_EM) => {
    t.organizations = [{ ...o, status: "active" }];
    t.platform_config = [
      {
        chave: CHAVE_DO_PADRAO_DO_LEITOR,
        valor: JSON.stringify({ modelo: MODELO, reserva: null, ativo_desde: ativoDesde, definido_em: ativoDesde }),
      },
    ];
    return t;
  };
  const auditadas = () => audit.mock.calls.map((c) => c[0] as { action: string; organizationId?: string; metadata?: Record<string, unknown> }).filter((a) => a.action === "leitor.ligado_pelo_padrao");

  it("sem padrão, a organização que nunca mexeu não lê", async () => {
    const t = cenario();
    t.organizations = [{ ...org({}), status: "active" }];
    const ler = sempreLe();
    const r = await cronDoLeitor(bancoEmMemoria(t) as never, { agora: AGORA, ler, orcamentoMs: 60_000 });
    expect(r.organizacoes).toBe(0);
    expect(ler).not.toHaveBeenCalled();
  });

  it("com padrão, a que nunca mexeu lê com o modelo padrão, desde que ele passou a valer", async () => {
    const t = comPadrao(cenario(), org({}));
    const ler = sempreLe();
    const r = await cronDoLeitor(bancoEmMemoria(t) as never, { agora: AGORA, ler, orcamentoMs: 60_000 });
    expect(r).toMatchObject({ organizacoes: 1, lidos: 2 });
    expect(vi.mocked(ler).mock.calls[0]![0].aprovado).toEqual(MODELO);
    // Já existia quando o padrão passou a valer: quem registra é a gravação do padrão, não a diária.
    expect(auditadas()).toHaveLength(0);
  });

  it("sem carga inicial: o padrão que passa a valer depois das conversas não lê nada de antes", async () => {
    const t = comPadrao(cenario(), org({}), "2026-11-05T15:00:00.000Z");
    const ler = sempreLe();
    const r = await cronDoLeitor(bancoEmMemoria(t) as never, { agora: AGORA, ler, orcamentoMs: 60_000 });
    expect(r.lidos).toBe(0);
    expect(ler).not.toHaveBeenCalled();
  });

  it("quem desligou continua desligado com o padrão", async () => {
    const t = comPadrao(cenario(), org({ escolha: "desligado", ligado: false, ligado_em: null, modelo: SONNET }));
    const ler = sempreLe();
    const r = await cronDoLeitor(bancoEmMemoria(t) as never, { agora: AGORA, ler, orcamentoMs: 60_000 });
    expect(r.organizacoes).toBe(0);
    expect(ler).not.toHaveBeenCalled();
  });

  it("quem escolheu o seu modelo continua com o dele", async () => {
    const t = comPadrao(cenario(), org({ escolha: "propria", ligado: true, ligado_em: LIGADO_EM, modelo: SONNET }));
    const ler = sempreLe();
    await cronDoLeitor(bancoEmMemoria(t) as never, { agora: AGORA, ler, orcamentoMs: 60_000 });
    expect(vi.mocked(ler).mock.calls[0]![0].aprovado).toEqual(SONNET);
  });

  it("organização nova lê só a partir de quando nasceu, e a primeira diária fica registrada (uma vez)", async () => {
    const nova = { ...org({}), created_at: "2026-11-05T12:30:00.000Z" };
    const t = comPadrao(cenario(), nova);
    const ler = sempreLe();
    const r = await cronDoLeitor(bancoEmMemoria(t) as never, { agora: AGORA, ler, orcamentoMs: 60_000 });
    // O chat novo (12:00) é de antes de ela nascer; o lead que voltou escreveu às 13:00.
    expect(r.lidos).toBe(1);
    expect(t.crm_lead_ficha!.map((f) => f.lead_id)).toEqual(["l-voltou"]);
    expect(auditadas()).toEqual([
      expect.objectContaining({ organizationId: ORG, metadata: expect.objectContaining({ ligado_em: "2026-11-05T12:30:00.000Z", modelo: MODELO }) }),
    ]);
    await cronDoLeitor(bancoEmMemoria(t) as never, { agora: new Date("2026-11-06T10:05:00.000Z"), ler: sempreLe(), orcamentoMs: 60_000 });
    expect(auditadas()).toHaveLength(1);
  });
});
