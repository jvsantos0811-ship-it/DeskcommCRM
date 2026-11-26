import { beforeEach, describe, expect, it, vi } from "vitest";

const chamadas: Array<Record<string, unknown>> = [];
let respostaDoHandler: { registrado: boolean } = { registrado: true };

vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  registrarDesfechoPeloGoogleHandler: vi.fn(async (_db: unknown, ctx: Record<string, unknown>, input: Record<string, unknown>) => {
    chamadas.push({ ctx, input });
    return respostaDoHandler;
  }),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { aplicarDesfechoDoEvento } from "./desfecho-do-evento";

const ORG = "org-1";
const AGORA = new Date("2026-11-27T15:00:00Z");

function db(linhas: { compromisso?: Record<string, unknown> | null; tipo?: Record<string, unknown> | null }) {
  const lidas: string[] = [];
  const filtros: Array<[string, string, unknown]> = [];
  const from = (tabela: string) => {
    lidas.push(tabela);
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => {
        filtros.push([tabela, c, v]);
        return q;
      },
      maybeSingle: async () => ({
        data: tabela === "calendar_appointments" ? (linhas.compromisso ?? null) : (linhas.tipo ?? null),
        error: null,
      }),
    };
    return q;
  };
  return { cliente: { from } as never, lidas, filtros };
}

const compromisso = { id: "ap-1", status: "confirmed", starts_at: "2026-11-27T13:20:00Z", event_type_id: "tipo-1" };
const tipo = { outcome_color_completed: "9", outcome_color_no_show: "8" };

beforeEach(() => {
  chamadas.length = 0;
  respostaDoHandler = { registrado: true };
});

describe("aplicarDesfechoDoEvento (PC-062)", () => {
  it("a cor de Realizado depois do início registra pelo handler, com a organização de quem chama", async () => {
    const d = db({ compromisso, tipo });
    expect(await aplicarDesfechoDoEvento(d.cliente, ORG, "ap-1", "9", AGORA)).toBe("registrado");
    expect(chamadas).toEqual([
      expect.objectContaining({
        ctx: expect.objectContaining({ organization_id: ORG }),
        input: { id: "ap-1", status: "completed", cor: "9" },
      }),
    ]);
    expect(d.filtros).toContainEqual(["calendar_appointments", "organization_id", ORG]);
    expect(d.filtros).toContainEqual(["calendar_event_types", "organization_id", ORG]);
  });

  it("evento sem cor: nem lê o banco", async () => {
    const d = db({ compromisso, tipo });
    expect(await aplicarDesfechoDoEvento(d.cliente, ORG, "ap-1", undefined, AGORA)).toBe("nada");
    expect(d.lidas).toHaveLength(0);
  });

  it("cor da presença, outra cor, tipo desligado ou antes do início: nada", async () => {
    expect(await aplicarDesfechoDoEvento(db({ compromisso, tipo }).cliente, ORG, "ap-1", "10", AGORA)).toBe("nada");
    expect(await aplicarDesfechoDoEvento(db({ compromisso, tipo }).cliente, ORG, "ap-1", "7", AGORA)).toBe("nada");
    expect(
      await aplicarDesfechoDoEvento(
        db({ compromisso, tipo: { outcome_color_completed: null, outcome_color_no_show: null } }).cliente,
        ORG,
        "ap-1",
        "9",
        AGORA,
      ),
    ).toBe("nada");
    expect(
      await aplicarDesfechoDoEvento(
        db({ compromisso: { ...compromisso, starts_at: "2026-11-27T18:00:00Z" }, tipo }).cliente,
        ORG,
        "ap-1",
        "8",
        AGORA,
      ),
    ).toBe("nada");
    expect(chamadas).toHaveLength(0);
  });

  it("falha no handler nunca derruba o sync", async () => {
    const { registrarDesfechoPeloGoogleHandler } = await import("@/app/api/v1/agenda/agendamentos/_handler");
    vi.mocked(registrarDesfechoPeloGoogleHandler).mockRejectedValueOnce(new Error("boom"));
    expect(await aplicarDesfechoDoEvento(db({ compromisso, tipo }).cliente, ORG, "ap-1", "8", AGORA)).toBe("nada");
  });
});
