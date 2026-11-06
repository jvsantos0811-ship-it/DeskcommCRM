/**
 * A rodada do aviso "Ninguém respondeu" com um banco em memória: quem entra, o
 * aviso único por conversa, a memória da leitura curta, a resposta automática
 * do WhatsApp Business e o aviso que se resolve sozinho.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Tirar o filtro de organização ativa: o caso da suspensa acusa.
 * - Não gravar o veredito: o caso "pergunta uma vez só" acusa.
 * - Não resolver quando alguém responde: o caso do "resolve sozinho" acusa.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import type { VereditoDoFim } from "./conferir-fim-da-conversa";
import { rodadaNinguemRespondeu } from "./ninguem-respondeu-rodada";

type Linha = Record<string, unknown>;
type Tabelas = Record<string, Linha[]>;

/** Um supabase-js de mentira, só com o que a rodada usa. */
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
    const linhas = () => (t[tabela] ??= []);
    const resultado = () => {
      if (inserir) {
        const nova: Linha = { id: `id-${++seq}`, created_at: new Date().toISOString(), status: "open", ...inserir };
        if (tabela === "agent_inbox_items") {
          const dup = linhas().some(
            (l) => l.status === "open" && l.organization_id === nova.organization_id && l.kind === nova.kind && l.ref_id === nova.ref_id,
          );
          if (dup) return { data: null, error: { code: "23505", message: "duplicate" } };
        }
        if (tabela === "conferencias_de_fim_da_conversa") {
          const dup = linhas().some(
            (l) => l.organization_id === nova.organization_id && l.conversation_id === nova.conversation_id && l.message_id === nova.message_id,
          );
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
      order: (col: string, o?: { ascending?: boolean }) => ((ordem = { col, asc: o?.ascending !== false }), b),
      limit: (n: number) => ((limite = n), b),
      insert: (row: Linha) => ((inserir = row), b),
      update: (vals: Linha) => ((atualizar = vals), b),
      maybeSingle: () => {
        const r = resultado();
        return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : null, error: r.error });
      },
      then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => Promise.resolve(resultado()).then(ok, erro),
    };
    return b;
  };
  // A contagem da migration 9024, por organização (o SQL é provado em
  // tests/invariants/textos-automaticos-do-celular.test.ts).
  const rpc = (nome: string, args: { p_org: string }) =>
    Promise.resolve(
      nome === "fn_textos_automaticos_do_celular"
        ? { data: ((t.textos_automaticos ?? []) as Linha[]).filter((l) => l.org === args.p_org), error: null }
        : { data: null, error: { message: `rpc desconhecida: ${nome}` } },
    );
  return { from, rpc };
}

const ORG = "org-a";
const OUTRA = "org-b";
const SUSPENSA = "org-c";
const FUNIL = "funil-vendas";
const ETAPA = "etapa-recepcao";
const ligado = { ninguem_respondeu: { ligado: true, ligado_em: "2026-10-27T03:00:00.000Z" } };

function cenario(): Tabelas {
  const conversa = (id: string, org: string, contato: string, inbound: string, outbound: string | null = null) => ({
    id,
    organization_id: org,
    contact_id: contato,
    is_group: false,
    last_inbound_at: inbound,
    last_outbound_at: outbound,
  });
  const m = (id: string, org: string, conv: string, direction: string, created_at: string, over: Linha = {}) => ({
    id,
    organization_id: org,
    conversation_id: conv,
    direction,
    sent_via: direction === "inbound" ? "external_device" : "external_device",
    type: "text",
    body: null,
    media_derived_text: null,
    created_at,
    ...over,
  });
  return {
    organizations: [
      { id: ORG, settings: ligado, timezone: "America/Sao_Paulo", locale: "pt-BR", status: "active" },
      { id: OUTRA, settings: {}, timezone: "America/Sao_Paulo", locale: "pt-BR", status: "active" },
      { id: SUSPENSA, settings: ligado, timezone: "America/Sao_Paulo", locale: "pt-BR", status: "suspended" },
    ],
    crm_pipelines: [
      { id: FUNIL, organization_id: ORG, is_archived: false, is_client_pipeline: false },
      { id: "f-b", organization_id: OUTRA, is_archived: false, is_client_pipeline: false },
      { id: "f-c", organization_id: SUSPENSA, is_archived: false, is_client_pipeline: false },
    ],
    crm_stages: [
      { id: ETAPA, name: "Recepção", is_won: false, is_lost: false, is_archived: false },
      { id: "etapa-ganho", name: "Contratado", is_won: true, is_lost: false, is_archived: false },
    ],
    contacts: [
      { id: "c-espera", organization_id: ORG, is_blocked: false },
      { id: "c-obg", organization_id: ORG, is_blocked: false },
      { id: "c-auto", organization_id: ORG, is_blocked: false },
      { id: "c-ganho", organization_id: ORG, is_blocked: false },
      { id: "c-bloq", organization_id: ORG, is_blocked: true },
      { id: "c-outra", organization_id: OUTRA, is_blocked: false },
      { id: "c-susp", organization_id: SUSPENSA, is_blocked: false },
    ],
    crm_leads: [
      { contact_id: "c-espera", organization_id: ORG, pipeline_id: FUNIL, stage_id: ETAPA, tags: [] },
      { contact_id: "c-obg", organization_id: ORG, pipeline_id: FUNIL, stage_id: ETAPA, tags: [] },
      { contact_id: "c-auto", organization_id: ORG, pipeline_id: FUNIL, stage_id: ETAPA, tags: [] },
      { contact_id: "c-ganho", organization_id: ORG, pipeline_id: FUNIL, stage_id: "etapa-ganho", tags: [] },
      { contact_id: "c-bloq", organization_id: ORG, pipeline_id: FUNIL, stage_id: ETAPA, tags: [] },
      { contact_id: "c-outra", organization_id: OUTRA, pipeline_id: "f-b", stage_id: ETAPA, tags: [] },
      { contact_id: "c-susp", organization_id: SUSPENSA, pipeline_id: "f-c", stage_id: ETAPA, tags: [] },
    ],
    conversations: [
      conversa("v-espera", ORG, "c-espera", "2026-11-05T13:00:00.000Z"),
      conversa("v-obg", ORG, "c-obg", "2026-11-05T13:10:00.000Z", "2026-11-05T13:00:00.000Z"),
      conversa("v-auto", ORG, "c-auto", "2026-11-05T13:00:00.000Z", "2026-11-05T13:00:05.000Z"),
      conversa("v-ganho", ORG, "c-ganho", "2026-11-05T13:00:00.000Z"),
      conversa("v-bloq", ORG, "c-bloq", "2026-11-05T13:00:00.000Z"),
      conversa("v-outra", OUTRA, "c-outra", "2026-11-05T13:00:00.000Z"),
      conversa("v-susp", SUSPENSA, "c-susp", "2026-11-05T13:00:00.000Z"),
    ],
    messages: [
      m("m1", ORG, "v-espera", "inbound", "2026-11-05T13:00:00.000Z", { body: "Preciso de ajuda com meu benefício" }),
      m("m2", ORG, "v-obg", "outbound", "2026-11-05T13:00:00.000Z", { sent_via: "ai", body: "Pronto, anotado." }),
      m("m3", ORG, "v-obg", "inbound", "2026-11-05T13:10:00.000Z", { body: "Obrigado!" }),
      m("m4", ORG, "v-auto", "inbound", "2026-11-05T13:00:00.000Z", { body: "Oi, quero saber do meu caso" }),
      m("m5", ORG, "v-auto", "outbound", "2026-11-05T13:00:05.000Z", { body: "Olá! Sou do escritório. Como posso te chamar?" }),
      m("m6", ORG, "v-ganho", "inbound", "2026-11-05T13:00:00.000Z", { body: "Oi" }),
      m("m7", ORG, "v-bloq", "inbound", "2026-11-05T13:00:00.000Z", { body: "Oi" }),
      m("m8", OUTRA, "v-outra", "inbound", "2026-11-05T13:00:00.000Z", { body: "Oi" }),
      m("m9", SUSPENSA, "v-susp", "inbound", "2026-11-05T13:00:00.000Z", { body: "Oi" }),
    ],
    agent_inbox_items: [],
    conferencias_de_fim_da_conversa: [],
    // A saudação é texto automático NESTA organização: igual em várias conversas, quase sempre na hora.
    textos_automaticos: [{ org: ORG, texto: "olá! sou do escritório. como posso te chamar?", conversas: 40, vezes: 40, no_prazo: 38 }],
  };
}

const AGORA = new Date("2026-11-05T15:00:00.000Z"); // 12h em São Paulo, quinta: 2 h de expediente depois

function rodar(t: Tabelas, conferir = vi.fn<(e: unknown) => Promise<VereditoDoFim>>().mockResolvedValue({ terminou: false, origem: "leitura", modelo: "m" })) {
  return {
    conferir,
    resultado: rodadaNinguemRespondeu(bancoEmMemoria(t) as never, {
      agora: AGORA,
      conferir: conferir as never,
      ehInterno: async () => false,
    }),
  };
}

describe("rodada do aviso Ninguém respondeu", () => {
  it("abre o aviso só para quem ficou esperando, na organização que ligou e está ativa", async () => {
    const t = cenario();
    const { resultado } = rodar(t);
    const r = await resultado;
    const avisos = t.agent_inbox_items!.map((i) => i.ref_id).sort();
    // v-espera: esperou; v-auto: a saudação automática não conta como resposta.
    expect(avisos).toEqual(["v-auto", "v-espera"]);
    expect(r.abertos).toBe(2);
    // Fora: "Obrigado!" (encerrou), ganho, bloqueado, organização sem o aviso, suspensa.
    for (const i of t.agent_inbox_items!) {
      expect(i).toMatchObject({ organization_id: ORG, kind: "ninguem_respondeu", severity: "warn", ref_kind: "conversation", status: "open" });
      expect(String(i.title)).toBe("Um lead escreveu e ninguém respondeu");
      expect(String(i.body)).toContain("Etapa: Recepção.");
    }
  });

  it("um aviso por conversa: rodar de novo não duplica, e a leitura curta é perguntada uma vez só", async () => {
    const t = cenario();
    const primeira = rodar(t);
    await primeira.resultado;
    const chamadas = primeira.conferir.mock.calls.length;
    expect(chamadas).toBe(2);
    expect(t.conferencias_de_fim_da_conversa).toHaveLength(2);
    const segunda = rodar(t);
    await segunda.resultado;
    expect(segunda.conferir).not.toHaveBeenCalled();
    expect(t.agent_inbox_items).toHaveLength(2);
  });

  it("quando a leitura curta diz que terminou, não avisa — e lembra disso", async () => {
    const t = cenario();
    const conferir = vi.fn<(e: unknown) => Promise<VereditoDoFim>>().mockResolvedValue({ terminou: true, origem: "leitura", modelo: "m" });
    await rodar(t, conferir).resultado;
    expect(t.agent_inbox_items).toHaveLength(0);
    expect(t.conferencias_de_fim_da_conversa!.every((c) => c.terminou === true)).toBe(true);
  });

  it("resolve sozinho quando alguém responde", async () => {
    const t = cenario();
    await rodar(t).resultado;
    // A equipe respondeu pelo celular.
    t.messages!.push({
      id: "resp",
      organization_id: ORG,
      conversation_id: "v-espera",
      direction: "outbound",
      sent_via: "external_device",
      type: "text",
      body: "Oi! Vamos ver seu caso.",
      media_derived_text: null,
      created_at: "2026-11-05T15:30:00.000Z",
    });
    const conv = t.conversations!.find((c) => c.id === "v-espera")!;
    conv.last_outbound_at = "2026-11-05T15:30:00.000Z";
    const r = await rodar(t).resultado;
    expect(r.resolvidos).toBe(1);
    const item = t.agent_inbox_items!.find((i) => i.ref_id === "v-espera")!;
    expect(item.status).toBe("resolved");
    expect(item.resolved_at).toBeTruthy();
    // O outro continua aberto.
    expect(t.agent_inbox_items!.find((i) => i.ref_id === "v-auto")!.status).toBe("open");
  });

  it("antes de 1 hora de expediente não avisa", async () => {
    const t = cenario();
    const r = await rodadaNinguemRespondeu(bancoEmMemoria(t) as never, {
      agora: new Date("2026-11-05T13:30:00.000Z"),
      conferir: vi.fn() as never,
      ehInterno: async () => false,
    });
    expect(r.abertos).toBe(0);
  });
});
