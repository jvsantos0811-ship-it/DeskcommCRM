/**
 * A REGRA DA ETAPA "SÓ ATENDIMENTO HUMANO", peça por peça (fork, migration 9005).
 *
 * A prova de ponta a ponta — o turno real, contra o Postgres — é
 * `tests/invariants/etapa-so-humano-cala-a-ia.test.ts`. Aqui fica o que roda no
 * `verify`: a consulta (qual negócio conta), o aviso (idioma e nome da etapa) e
 * a passagem (origem e motivo gravados).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const performHumanHandoff = vi.fn(async () => undefined);
const idiomaDaOrganizacao = vi.fn(async () => "pt-BR");
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ performHumanHandoff, idiomaDaOrganizacao }));

const ORG = "org-1";
const CONTATO = "contato-1";
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

beforeEach(() => {
  performHumanHandoff.mockClear();
  idiomaDaOrganizacao.mockReset();
  idiomaDaOrganizacao.mockResolvedValue("pt-BR");
});

describe("etapaQueExigeHumano — qual negócio conta", () => {
  it("só negócio ABERTO, numa etapa marcada e não arquivada, da organização e do contato", async () => {
    const { etapaQueExigeHumano } = await import("@/lib/agent-engine/agent/etapa-exige-humano");
    const query = vi.fn(async () => ({ rows: [] }));

    expect(await etapaQueExigeHumano({ query } as never, ORG, CONTATO)).toBeNull();

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual([ORG, CONTATO]);
    expect(sql).toMatch(/l\.organization_id = \$1/);
    expect(sql).toMatch(/l\.contact_id = \$2/);
    expect(sql).toMatch(/l\.status = 'open'/);
    expect(sql).toMatch(/s\.requires_human/);
    expect(sql).toMatch(/not s\.is_archived/);
    // A etapa é da MESMA organização do negócio — sem isto, um id de etapa de
    // outro tenant num negócio corrompido decidiria aqui.
    expect(sql).toMatch(/s\.organization_id = l\.organization_id/);
  });

  it("devolve o negócio e a etapa que o aviso vai nomear", async () => {
    const { etapaQueExigeHumano } = await import("@/lib/agent-engine/agent/etapa-exige-humano");
    const query = vi.fn(async () => ({
      rows: [{ negocio_id: "n1", etapa_id: "e1", etapa_nome: "Aguardando assinatura" }],
    }));

    expect(await etapaQueExigeHumano({ query } as never, ORG, CONTATO)).toEqual({
      negocioId: "n1",
      etapaId: "e1",
      etapaNome: "Aguardando assinatura",
    });
  });
});

describe("tituloDoAvisoDaEtapa", () => {
  it("nomeia a etapa e diz como a IA volta, no idioma da organização", async () => {
    const { tituloDoAvisoDaEtapa } = await import("@/lib/agent-engine/agent/etapa-exige-humano");

    const pt = tituloDoAvisoDaEtapa("Análise humana", "pt-BR");
    expect(pt).toContain("«Análise humana»");
    expect(pt).toContain("mova o negócio para outra etapa");

    const es = tituloDoAvisoDaEtapa("Análisis humano", "es");
    expect(es).toContain("«Análisis humano»");
    expect(es).toContain("mueva el negocio a otra etapa");
  });

  it("nome de etapa longo não estoura o título da Central", async () => {
    const { tituloDoAvisoDaEtapa } = await import("@/lib/agent-engine/agent/etapa-exige-humano");
    const titulo = tituloDoAvisoDaEtapa("x".repeat(500), "pt-BR");
    expect(titulo).toContain(`«${"x".repeat(80)}»`);
    expect(titulo).not.toContain("x".repeat(81));
  });
});

describe("passarParaHumanoPelaEtapa — a passagem gravada", () => {
  it("origem etapa_do_funil, motivo critical_stage, aviso com o nome da etapa e no idioma da organização", async () => {
    const { passarParaHumanoPelaEtapa } = await import("@/lib/agent-engine/agent/etapa-exige-humano");
    idiomaDaOrganizacao.mockResolvedValue("es");
    const pool = {} as never;
    const ids = { tenantId: ORG, leadId: CONTATO, conversationId: "conversa-1" };

    await passarParaHumanoPelaEtapa(
      pool,
      ids,
      { negocioId: "n1", etapaId: "e1", etapaNome: "Análisis humano" },
      { checkpoint: null, log },
    );

    expect(performHumanHandoff).toHaveBeenCalledTimes(1);
    const [db, idsUsados, opts] = performHumanHandoff.mock.calls[0] as unknown as [
      unknown,
      unknown,
      {
        reason: string;
        inboxTitle: string;
        passagem: { origem: string; motivoCodigo: string; idioma: string };
      },
    ];
    expect(db).toBe(pool);
    expect(idsUsados).toEqual(ids);
    expect(opts.reason).toBe("critical_stage");
    expect(opts.passagem).toMatchObject({ origem: "etapa_do_funil", motivoCodigo: "critical_stage", idioma: "es" });
    expect(opts.inboxTitle).toContain("«Análisis humano»");
    expect(opts.inboxTitle).toContain("mueva el negocio");
  });
});
