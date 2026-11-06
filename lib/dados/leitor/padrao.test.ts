/**
 * O MODELO PADRÃO DO LEITOR, DA INSTALAÇÃO (PM-027; decisão do dono de 06/11: o
 * Leitor liga sozinho nas organizações que existem e nas novas).
 *
 * A configuração EFETIVA de cada organização: quem nunca mexeu segue o padrão;
 * quem escolheu o seu modelo fica com ele; quem desligou fica desligado. O marco
 * (`ligado_em`) de quem segue o padrão é o mais tarde entre o padrão passar a
 * valer, a organização nascer e o admin ter voltado ao padrão.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Tratar "desligado" como "nunca mexeu": o caso "desligou de propósito" acusa.
 * - Usar o `ativo_desde` para a organização nova: o caso "nasce ligada desde que
 *   nasceu" acusa.
 * - Trocar `ativo_desde` ao trocar de modelo: o caso "trocar o modelo não relê
 *   nada" acusa.
 * - Aceitar modelo não aprovado como padrão: o caso da régua acusa.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { configDoLeitor, configEfetivaDoLeitor, escolhaDaOrg, lerValorDoPadrao, type PadraoDoLeitor } from "./config";
import {
  CHAVE_DO_PADRAO_DO_LEITOR,
  gravarPadraoDoLeitor,
  lerPadraoDoLeitor,
  organizacoesQueSeguemOPadrao,
  recusaDoPadrao,
  situacaoDasOrganizacoes,
} from "./padrao";

const HAIKU = { provider: "anthropic", model_id: "claude-haiku-5-5" };
const SONNET = { provider: "anthropic", model_id: "claude-sonnet-5-5" };
const ATIVO = "2026-11-06T17:00:00.000Z";
const PADRAO: PadraoDoLeitor = { modelo: HAIKU, reserva: SONNET, ativo_desde: ATIVO, definido_em: ATIVO };
const ANTIGA = "2026-09-01T12:00:00.000Z";

const comLeitor = (leitor: Record<string, unknown>) => configDoLeitor({ leitor });

describe("a configuração efetiva do Leitor", () => {
  it("nunca mexeu + padrão: ligado com o modelo e a reserva padrão, desde que o padrão passou a valer", () => {
    const c = configEfetivaDoLeitor(comLeitor({}), ANTIGA, PADRAO);
    expect(c).toMatchObject({ origem: "padrao", ligado: true, ligado_em: ATIVO, modelo: HAIKU, reserva: SONNET });
  });

  it("organização sem nenhum settings também segue o padrão", () => {
    expect(configEfetivaDoLeitor(configDoLeitor(null), ANTIGA, PADRAO)).toMatchObject({ origem: "padrao", ligado: true });
  });

  it("organização nova nasce ligada, desde que nasceu (nada de antes é lido)", () => {
    const nasceu = "2026-11-20T10:00:00.000Z";
    expect(configEfetivaDoLeitor(comLeitor({}), nasceu, PADRAO)).toMatchObject({ ligado: true, ligado_em: nasceu });
  });

  it("sem padrão na instalação: nada liga", () => {
    expect(configEfetivaDoLeitor(comLeitor({}), ANTIGA, null)).toMatchObject({ origem: "padrao", ligado: false, ligado_em: null, modelo: null });
  });

  it("quem desligou de propósito fica desligado, com padrão ou sem", () => {
    const desligada = comLeitor({ escolha: "desligado", ligado: false, modelo: SONNET });
    expect(configEfetivaDoLeitor(desligada, ANTIGA, PADRAO)).toMatchObject({ origem: "desligado", ligado: false, ligado_em: null });
    // O último modelo próprio fica guardado (o cartão o oferece de novo).
    expect(configEfetivaDoLeitor(desligada, ANTIGA, PADRAO).modelo).toEqual(SONNET);
  });

  it("quem escolheu o seu modelo continua com o dele", () => {
    const propria = comLeitor({ escolha: "propria", ligado: true, ligado_em: ANTIGA, modelo: SONNET, reserva: null });
    expect(configEfetivaDoLeitor(propria, ANTIGA, PADRAO)).toMatchObject({ origem: "propria", ligado: true, ligado_em: ANTIGA, modelo: SONNET });
  });

  it("quem ligou pelo cartão antes de existir o padrão (sem escolha gravada) é escolha própria", () => {
    const antiga = comLeitor({ ligado: true, ligado_em: ANTIGA, modelo: SONNET });
    expect(escolhaDaOrg(antiga)).toBe("propria");
    expect(configEfetivaDoLeitor(antiga, ANTIGA, PADRAO).modelo).toEqual(SONNET);
    // E quem nunca ligou, ou só desligou antes do padrão existir, segue o padrão.
    expect(escolhaDaOrg(comLeitor({ ligado: false, modelo: SONNET }))).toBe("padrao");
  });

  it("quem voltou ao padrão lê desde que voltou (se o padrão já valia antes)", () => {
    const voltou = "2026-11-25T08:00:00.000Z";
    const c = configEfetivaDoLeitor(comLeitor({ escolha: "padrao", ligado: false, ligado_em: voltou }), ANTIGA, PADRAO);
    expect(c).toMatchObject({ ligado: true, ligado_em: voltou, modelo: HAIKU });
  });

  it("padrão guardado inválido vale como sem padrão (nenhuma empresa liga por engano)", () => {
    expect(lerValorDoPadrao("{não é json")).toBeNull();
    expect(lerValorDoPadrao(JSON.stringify({ modelo: HAIKU }))).toBeNull();
    expect(lerValorDoPadrao(null)).toBeNull();
    expect(lerValorDoPadrao(JSON.stringify(PADRAO))).toEqual(PADRAO);
  });
});

describe("a régua do padrão é a do cartão da empresa", () => {
  const rodadas = new Map([
    ["anthropic/claude-haiku-5-5", { aprovado: true }],
    ["anthropic/claude-sonnet-5-5", { aprovado: true }],
    ["openai/gpt-6-luna", { aprovado: false }],
  ]);
  it("só modelo aprovado na bateria pode ser o padrão, e a reserva também", () => {
    expect(recusaDoPadrao(rodadas, HAIKU, SONNET)).toBeNull();
    expect(recusaDoPadrao(rodadas, HAIKU, null)).toBeNull();
    expect(recusaDoPadrao(rodadas, { provider: "openai", model_id: "gpt-6-luna" }, null)).toBe("modelo_nao_aprovado");
    expect(recusaDoPadrao(rodadas, { provider: "google", model_id: "gemini-4-argon" }, null)).toBe("modelo_nao_aprovado");
    expect(recusaDoPadrao(rodadas, HAIKU, { provider: "openai", model_id: "gpt-6-luna" })).toBe("reserva_nao_aprovada");
    expect(recusaDoPadrao(rodadas, HAIKU, HAIKU)).toBe("reserva_igual");
  });
});

describe("gravar e ler o padrão (platform_config)", () => {
  function banco() {
    const linhas = new Map<string, Record<string, unknown>>();
    const from = (tabela: string) => {
      expect(tabela).toBe("platform_config");
      let chave: string | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select: () => b,
        eq: (_c: string, v: string) => ((chave = v), b),
        maybeSingle: async () => ({ data: chave ? (linhas.get(chave) ?? null) : null, error: null }),
        upsert: async (row: Record<string, unknown>) => (linhas.set(String(row.chave), row), { error: null }),
        delete: () => ({ eq: async (_c: string, v: string) => (linhas.delete(v), { error: null }) }),
      };
      return b;
    };
    return { from, linhas };
  }

  it("a primeira gravação marca quando o padrão passou a valer; trocar o modelo não muda esse marco", async () => {
    const db = banco();
    const primeira = await gravarPadraoDoLeitor(db as never, { modelo: HAIKU, reserva: null }, new Date(ATIVO), "dono");
    expect(primeira.antes).toBeNull();
    expect(primeira.depois).toMatchObject({ modelo: HAIKU, ativo_desde: ATIVO });
    expect(db.linhas.get(CHAVE_DO_PADRAO_DO_LEITOR)).toMatchObject({ eh_segredo: false, semeado_do_env: false, updated_by: "dono" });

    const depois = "2026-11-10T12:00:00.000Z";
    const troca = await gravarPadraoDoLeitor(db as never, { modelo: SONNET, reserva: HAIKU }, new Date(depois), "dono");
    expect(troca.antes).toMatchObject({ modelo: HAIKU });
    expect(troca.depois).toMatchObject({ modelo: SONNET, reserva: HAIKU, ativo_desde: ATIVO, definido_em: depois });
    expect(await lerPadraoDoLeitor(db as never)).toEqual(troca.depois);
  });

  it("tirar o padrão apaga a linha; pôr de novo começa um marco novo", async () => {
    const db = banco();
    await gravarPadraoDoLeitor(db as never, { modelo: HAIKU, reserva: null }, new Date(ATIVO), "dono");
    const tirou = await gravarPadraoDoLeitor(db as never, { modelo: null, reserva: null }, new Date("2026-11-07T00:00:00.000Z"), "dono");
    expect(tirou.depois).toBeNull();
    expect(await lerPadraoDoLeitor(db as never)).toBeNull();
    const deNovo = await gravarPadraoDoLeitor(db as never, { modelo: HAIKU, reserva: null }, new Date("2026-11-08T00:00:00.000Z"), "dono");
    expect(deNovo.depois?.ativo_desde).toBe("2026-11-08T00:00:00.000Z");
  });

  it("banco que não respondeu = sem padrão (falha fechada)", async () => {
    const quebrado = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "caiu" } }) }) }) }) };
    expect(await lerPadraoDoLeitor(quebrado as never)).toBeNull();
    const lanca = { from: () => { throw new Error("sem tabela"); } };
    expect(await lerPadraoDoLeitor(lanca as never)).toBeNull();
  });
});

describe("como cada empresa fica diante do padrão (a página do dono)", () => {
  const tabelas: Record<string, Array<Record<string, unknown>>> = {
    organizations: [
      { id: "o-nunca", display_name: "Nunca mexeu", settings: {}, created_at: ANTIGA, status: "active" },
      { id: "o-desligou", display_name: "Desligou", settings: { leitor: { escolha: "desligado" } }, created_at: ANTIGA, status: "active" },
      {
        id: "o-propria",
        display_name: "Própria",
        settings: { leitor: { escolha: "propria", ligado: true, ligado_em: ANTIGA, modelo: SONNET } },
        created_at: ANTIGA,
        status: "active",
      },
      { id: "o-escolheu-funis", display_name: "Escolheu funis", settings: { leitor: { funis: ["3b3b3b3b-0000-4000-8000-000000000003"] } }, created_at: ANTIGA, status: "suspended" },
    ],
    crm_pipelines: [
      { id: "f-1", name: "Vendas", organization_id: "o-nunca", is_archived: false, is_client_pipeline: false },
      { id: "f-2", name: "Clientes", organization_id: "o-nunca", is_archived: false, is_client_pipeline: true },
      { id: "f-3", name: "Operacional", organization_id: "o-escolheu-funis", is_archived: false, is_client_pipeline: false },
      { id: "3b3b3b3b-0000-4000-8000-000000000003", name: "Vendas", organization_id: "o-escolheu-funis", is_archived: false, is_client_pipeline: false },
    ],
  };
  const db = {
    from: (t: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = { select: () => b, order: () => b, then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: tabelas[t] ?? [], error: null }).then(ok) };
      return b;
    },
  };

  it("diz a escolha, se lê e desde quando, e os funis lidos (o de clientes marcado fica de fora)", async () => {
    const lista = await situacaoDasOrganizacoes(db as never, PADRAO);
    const por = Object.fromEntries(lista.map((o) => [o.id, o]));
    expect(por["o-nunca"]).toMatchObject({ escolha: "padrao", ligado_em: ATIVO, funis_lidos: ["Vendas"] });
    expect(por["o-desligou"]).toMatchObject({ escolha: "desligado", ligado_em: null });
    expect(por["o-propria"]).toMatchObject({ escolha: "propria", ligado_em: ANTIGA });
    expect(por["o-escolheu-funis"]).toMatchObject({ escolha: "padrao", operando: false, funis_lidos: ["Vendas"] });
  });

  it("quem passa a ler pelo padrão: só quem o segue", async () => {
    const seguem = await organizacoesQueSeguemOPadrao(db as never, PADRAO);
    expect(seguem.map((o) => o.id).sort()).toEqual(["o-escolheu-funis", "o-nunca"]);
  });
});
