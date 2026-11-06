/**
 * Carregar os casos da bateria: os dois formatos do Gestor, a conversa congelada
 * até a data do caso, os inventados com horário, e o que fica de fora (com o motivo).
 *
 * SABOTAGEM:
 * - Não cortar a conversa em `congelar_ate`: o caso "congela" acusa.
 * - Carregar caso de aviso (sem ficha no gabarito): o caso dos ignorados acusa.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { carregarCasos } from "./carregar-casos";

type Linha = Record<string, unknown>;
type Tabelas = Record<string, Linha[]>;

/** Um supabase-js de mentira, só com o que a bateria usa. */
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
        if (tabela === "leitor_bateria_resultados") {
          const dup = linhas().some((l) => l.rodada_id === nova.rodada_id && l.caso_uuid === nova.caso_uuid);
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
      // Só a forma que `pegarRodada` usa: pendente, ou rodando e parada antes do limite.
      or: (expr: string) => {
        const limite = /atualizada_em\.lt\.([^)]+)\)/.exec(expr)?.[1] ?? "";
        filtros.push((l) => l.status === "pendente" || (l.status === "rodando" && String(l.atualizada_em) < limite));
        return b;
      },
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



const ORG = "org-origem";

function cenario(): Tabelas {
  const m = (direction: string, created_at: string, body: string) => ({
    organization_id: ORG,
    conversation_id: "cv-1",
    direction,
    sent_via: direction === "inbound" ? "external_device" : "ai",
    type: "text",
    body,
    media_derived_text: null,
    status: "delivered",
    created_at,
    sent_by_user_id: null,
  });
  return {
    organizations: [{ id: ORG, display_name: "Escritório Origem", timezone: "America/Sao_Paulo", settings: {} }],
    crm_leads: [{ id: "l-1", organization_id: ORG, contact_id: "c-1", created_at: "2026-10-29T02:05:03.943189Z" }],
    conversations: [{ id: "cv-1", organization_id: ORG, contact_id: "c-1", is_group: false }],
    messages: [
      m("inbound", "2026-10-29T13:00:00.000Z", "meu marido caiu do andaime"),
      m("outbound", "2026-10-29T13:01:00.000Z", "Sinto muito. Ele era de carteira?"),
      m("inbound", "2026-11-06T13:00:00.000Z", "mensagem depois do congelamento"),
    ],
    ai_agents: [{ organization_id: ORG, name: "Recepção" }],
    catalog_products: [{ organization_id: ORG, nome: "Auxílio-acidente", requisitos: ["houve acidente"], tipo_de_lead: true, ativo: true }],
    leitor_bateria_casos: [],
  };
}

const REGRA_V2 = {
  relogio_da_regra: "2026-11-05T21:40:00-03:00",
  casos: [
    {
      id: "B01",
      achar_no_crm: { organizacao: "x", lead_criado_em: "2026-10-29T02:05:03.943189Z" },
      congelar_ate: "2026-11-05T21:40:00-03:00",
      ficha: { contato: "lead", contou: "sim", fala: "29/10 10:00", bola: "lead", palavras: true },
    },
    { id: "B02", achar_no_crm: { lead_criado_em: "2026-01-01T00:00:00Z" }, congelar_ate: "2026-11-05T21:40:00-03:00", ficha: { contato: "lead" } },
  ],
};

describe("carregar os casos da bateria", () => {
  it("Regra v2: acha o lead, congela a conversa até a data do caso e guarda o gabarito e o prompt da origem", async () => {
    const t = cenario();
    const r = await carregarCasos(bancoEmMemoria(t) as never, { formato: "regra_v2", origemOrganizationId: ORG, arquivo: REGRA_V2, substituir: false });
    expect(r.criados).toEqual(["B01"]);
    expect(r.ignorados).toEqual([{ id: "B02", motivo: "lead não encontrado na organização de origem" }]);
    const caso = t.leitor_bateria_casos![0]!;
    expect(caso).toMatchObject({ caso_id: "B01", versao: 1, ativo: true, origem_organization_id: ORG, origem_contact_id: "c-1", bloqueia: true });
    expect(String(caso.conversa).split("\n")).toEqual([
      "[2026-10-29T10:00] Contato: meu marido caiu do andaime",
      "[2026-10-29T10:01] Assistente virtual: Sinto muito. Ele era de carteira?",
    ]);
    expect(caso.prompt_variaveis).toMatchObject({ organizacao: "Escritório Origem", agentes: ["Recepção"], tipos: [{ nome: "Auxílio-acidente", requisitos: ["houve acidente"] }] });
    expect(caso.gabarito).toMatchObject({ tipo: "regra_v2", ficha: { contato: "lead", contou_o_caso: "sim" } });
  });

  it("o mesmo caso não entra duas vezes; com substituir, vira a versão 2", async () => {
    const t = cenario();
    const db = bancoEmMemoria(t) as never;
    await carregarCasos(db, { formato: "regra_v2", origemOrganizationId: ORG, arquivo: REGRA_V2, substituir: false });
    const de_novo = await carregarCasos(db, { formato: "regra_v2", origemOrganizationId: ORG, arquivo: REGRA_V2, substituir: false });
    expect(de_novo.ignorados).toContainEqual({ id: "B01", motivo: "já está na bateria" });
    await carregarCasos(db, { formato: "regra_v2", origemOrganizationId: ORG, arquivo: REGRA_V2, substituir: true });
    expect(t.leitor_bateria_casos!.filter((c) => c.caso_id === "B01").map((c) => [c.versao, c.ativo])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it("Casos do Gestor: entra o inventado com ficha (com horário), saem os de aviso e o real sem chave", async () => {
    const t = cenario();
    const arquivo = {
      casos: [
        {
          id: "CL3",
          origem: "inventado",
          organizacao: "Clínica de teste",
          bloqueia: true,
          relogio: ["2026-11-24T06:00-03:00"],
          conversa: [
            ["lead", "posso falar com a dentista? é sobre a minha prótese"],
            ["ia", "Claro, vou pedir para a Dra. Paula te chamar por aqui."],
          ],
          esperado: { ficha: { esperando_a_equipe: { motivo: "lead_pediu_pessoa", desde: "2026-11-19T15:00-03:00" } } },
        },
        { id: "CL5", origem: "inventado", bloqueia: true, conversa: [["lead", "bom dia"]], esperado: { aviso_ninguem_respondeu: true } },
        { id: "EQ1", origem: "real", bloqueia: true, relogio: ["2026-11-06T06:00-03:00"], esperado: { ficha: { contato: "lead" } } },
      ],
    };
    const r = await carregarCasos(bancoEmMemoria(t) as never, { formato: "gestor", origemOrganizationId: ORG, arquivo, substituir: false });
    expect(r.criados).toEqual(["CL3"]);
    expect(r.ignorados.map((x) => x.id)).toEqual(["CL5", "EQ1"]);
    const cl3 = t.leitor_bateria_casos![0]!;
    expect(cl3).toMatchObject({ origem_organization_id: null, origem_contact_id: null, bloqueia: true });
    expect(String(cl3.conversa).split("\n")[0]).toBe("[2026-11-19T15:00] Contato: posso falar com a dentista? é sobre a minha prótese");
    expect(cl3.gabarito).toMatchObject({ tipo: "parcial", ficha: { esperando_a_equipe: { motivo: "lead_pediu_pessoa" } } });
  });

  it("Regra v2 sem organização de origem é recusado", async () => {
    await expect(
      carregarCasos(bancoEmMemoria(cenario()) as never, { formato: "regra_v2", origemOrganizationId: null, arquivo: REGRA_V2, substituir: false }),
    ).rejects.toThrow("origem_obrigatoria");
  });
});
