/**
 * Uma rodada da bateria com um banco em memória: lê caso a caso, chama o juiz só
 * na divergência, aplica o efeito da decisão, fecha com o placar e retoma de
 * onde parou.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Chamar o juiz em todo caso: "o juiz só na divergência" acusa.
 * - Não criar a versão nova quando o juiz dá razão ao modelo: o caso do EQ acusa.
 * - Fechar a rodada antes do último caso: o caso do orçamento acusa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/ai/budget/pode-gastar", () => ({ podeGastarComIa: vi.fn(async () => ({ pode: true })) }));
vi.mock("@/lib/ai/cost", () => ({ computeCost: vi.fn(async () => 0.5) }));
const registrar = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/lib/ai/usage/registrar-chamada", () => ({ registrarChamadaDeIa: (...a: unknown[]) => registrar(...a) }));
vi.mock("@/lib/organizacao/operante", () => ({ idsDeOrgsParadas: vi.fn(async () => []) }));

import { daFormaCurta } from "./bateria";
import { gabaritoParaOBanco, passadaDaBateria } from "./bateria-rodada";
import type { FichaDoLeitor } from "@/lib/dados/ficha";

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
const VARIAVEIS = { organizacao: "Escritório", agentes: [], tipos: [], prefixosDeAnuncio: [], termoDoContrato: "contrato" };
const B10 = daFormaCurta(
  { contato: "lead", interesse: "Auxílio-acidente", contou: "sim", requisitos: "atende", negociacao: "contrato_enviado", bola: "lead", fala: "05/11 11:34", palavras: true },
  2026,
);
const vazia = daFormaCurta({ contato: "lead" }, 2026);
const espera = { motivo: "ia_disse_que_equipe_chama" as const, desde: "2026-11-04T08:39-03:00" };

function cenario(): Tabelas {
  const caso = (id: string, caso_id: string, bloqueia: boolean, gabarito: object) => ({
    id,
    caso_id,
    versao: 1,
    ativo: true,
    origem_organization_id: ORG,
    origem_contact_id: `c-${id}`,
    origem_lead_id: null,
    bloqueia,
    relogio: "2026-11-05T21:40:00-03:00",
    conversa: `[2026-11-05T10:00] Contato: conversa do ${caso_id}`,
    prompt_variaveis: VARIAVEIS,
    gabarito,
    criado_em: "2026-11-06T10:00:00Z",
  });
  return {
    leitor_bateria_casos: [
      caso("k1", "B10", true, gabaritoParaOBanco({ tipo: "regra_v2", ficha: B10.ficha, banco: B10.banco })),
      caso("k2", "EQ1", true, gabaritoParaOBanco({ tipo: "parcial", ficha: { esperando_a_equipe: { ...espera, prova: "" } }, banco: vazia.banco })),
      caso("k3", "CL9", false, gabaritoParaOBanco({ tipo: "parcial", ficha: { contato: "cliente" }, banco: vazia.banco })),
    ],
    leitor_bateria_rodadas: [
      {
        id: "r1",
        provider: "anthropic",
        model_id: "claude-haiku-5-5",
        juiz_provider: "anthropic",
        juiz_model_id: "claude-opus-5-5",
        credencial_organization_id: ORG,
        status: "pendente",
        casos: [],
        casos_total: 0,
        casos_feitos: 0,
        criada_em: "2026-11-06T11:00:00Z",
        atualizada_em: "2026-11-06T11:00:00Z",
      },
    ],
    leitor_bateria_resultados: [],
  };
}

/** O modelo testado: acerta o B10, lê a espera do EQ1 meia hora depois e chama de lead o CL9. */
const fichaDoModelo = (conversa: string): FichaDoLeitor => {
  if (conversa.includes("B10")) return B10.ficha;
  if (conversa.includes("EQ1")) return { ...vazia.ficha, esperando_a_equipe: { motivo: espera.motivo, desde: "2026-11-04T09:30", prova: "a equipe vai assumir" } };
  return { ...vazia.ficha, contato: "lead" };
};
const ler = vi.fn(async (_m: unknown, _s: string, conversa: string) => ({ ficha: fichaDoModelo(conversa), promptTokens: 2300, completionTokens: 400 }));
/** O juiz: no EQ1 dá razão ao modelo; no CL9, ao gabarito. Sabe o lado pelo texto da pergunta. */
const julgar = vi.fn(async (_m: unknown, _s: string, pergunta: string) => {
  const ladoDoModelo = /A = \{"motivo":"ia_disse_que_equipe_chama","desde":"2026-11-04T09:30"/.test(pergunta) || /contato: A = lead/.test(pergunta) ? "A" : "B";
  const ladoDoGabarito = ladoDoModelo === "A" ? "B" : "A";
  const decisao = pergunta.includes("EQ1") ? ladoDoModelo : ladoDoGabarito;
  return { decisao: decisao as "A" | "B", motivo: "a mensagem diz isso", trecho: "trecho", promptTokens: 900, completionTokens: 80 };
});
const montar = vi.fn(async (_a: unknown, e: { provider: string; model_id: string }) => ({ model: {} as never, modelId: `${e.provider}/${e.model_id}`, origem: "credencial_da_organizacao" as const }));
const deps = (extra: object = {}) => ({ agora: new Date("2026-11-06T12:00:00Z"), ateMs: Date.now() + 60_000, ler, julgar, montar, ...extra });

beforeEach(() => {
  ler.mockClear();
  julgar.mockClear();
  montar.mockClear();
  registrar.mockClear();
});

describe("uma rodada da bateria", () => {
  it("lê os casos, chama o juiz só na divergência, aplica a decisão e fecha com o placar", async () => {
    const t = cenario();
    const r = await passadaDaBateria(bancoEmMemoria(t) as never, deps());
    expect(r).toMatchObject({ rodada: "r1", feitos: 3, terminou: true, parou: null });
    expect(ler).toHaveBeenCalledTimes(3);
    expect(julgar).toHaveBeenCalledTimes(2); // B10 passou sem juiz
    const porCaso = Object.fromEntries(t.leitor_bateria_resultados!.map((x) => [x.caso_id, x]));
    expect(porCaso.B10).toMatchObject({ passou_sem_juiz: true, acerto: true, juiz_decisao: null });
    expect(porCaso.EQ1).toMatchObject({ passou_sem_juiz: false, acerto: true, revisar: false });
    expect(porCaso.CL9).toMatchObject({ passou_sem_juiz: false, acerto: false, revisar: false });
    // O juiz deu razão ao modelo no EQ1: o gabarito ganhou a versão 2, com o motivo.
    const eq1 = t.leitor_bateria_casos!.filter((c) => c.caso_id === "EQ1");
    expect(eq1.map((c) => [c.versao, c.ativo])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(String(eq1[1]!.motivo_da_versao)).toContain("Corrigido pelo juiz");
    expect((eq1[1]!.gabarito as { ficha: { esperando_a_equipe: { desde: string } } }).ficha.esperando_a_equipe.desde).toBe("2026-11-04T09:30");
    // Placar: os dois que bloqueiam acertaram → aprovado; o CL9 não bloqueia.
    expect(t.leitor_bateria_rodadas![0]).toMatchObject({
      status: "terminada",
      casos_total: 3,
      acertos: 2,
      bloqueantes: 2,
      bloqueantes_acertos: 2,
      regra_v2: 1,
      qualidade_acertos: 1,
      aprovado: true,
    });
    // As chamadas vão para llm_calls sem contato (não entram na estimativa do Leitor).
    expect(registrar.mock.calls.every((c) => (c[1] as { contact_id: unknown }).contact_id === null)).toBe(true);
    expect(registrar.mock.calls.map((c) => (c[1] as { purpose: string }).purpose).sort()).toEqual([
      "juiz_da_bateria",
      "juiz_da_bateria",
      "leitor_da_conversa",
      "leitor_da_conversa",
      "leitor_da_conversa",
    ]);
  });

  it("orçamento acabou: solta a rodada e a passada seguinte continua de onde parou", async () => {
    const t = cenario();
    let chamadas = 0;
    const lento = vi.fn(async (m: unknown, s: string, c: string) => {
      chamadas += 1;
      return ler(m, s, c);
    });
    const db = bancoEmMemoria(t) as never;
    const r1 = await passadaDaBateria(db, deps({ ler: lento, ateMs: Date.now() - 1 }));
    expect(r1).toMatchObject({ feitos: 0, terminou: false });
    expect(t.leitor_bateria_rodadas![0]!.status).toBe("pendente");
    const r2 = await passadaDaBateria(db, deps({ ler: lento }));
    expect(r2).toMatchObject({ feitos: 3, terminou: true });
    expect(chamadas).toBe(3);
  });

  it("sem chave para o modelo testado: a rodada falha e não troca de modelo", async () => {
    const t = cenario();
    const r = await passadaDaBateria(bancoEmMemoria(t) as never, deps({ montar: vi.fn(async () => null) }));
    expect(r.parou).toBe("sem_chave");
    expect(t.leitor_bateria_rodadas![0]).toMatchObject({ status: "falhou", erro: "sem chave para o modelo testado" });
    expect(ler).not.toHaveBeenCalled();
  });

  it("rodada rodando com sinal de vida recente não é pega por outra passada", async () => {
    const t = cenario();
    t.leitor_bateria_rodadas![0]!.status = "rodando";
    t.leitor_bateria_rodadas![0]!.atualizada_em = "2026-11-06T11:59:00Z";
    const r = await passadaDaBateria(bancoEmMemoria(t) as never, deps());
    expect(r.rodada).toBeNull();
  });
});
