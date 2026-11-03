import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  acharFrasesProibidas,
  contarFrasesProibidas,
  FRASES_PADRAO,
  frasesDaOrganizacao,
} from "@/lib/agent-engine/agent/frases-proibidas";

/**
 * PC-022 — FRASES PROIBIDAS, contra o Postgres do baseline: a lista em vigor
 * lida do `settings` da organização (ausente = a padrão; a gravada pelo admin
 * vale) e a contagem por frase e semana que a tela mostra.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });

const ORG = "9022aaaa-0000-4000-8000-000000000001";

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1,'pc022','PC022','PC022') on conflict (id) do nothing`,
    [ORG],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("PC-022 — frases proibidas por organização", () => {
  it("sem lista gravada vale a padrão; a lista do admin (sem \"Ótimo\") passa a valer", async () => {
    expect(await frasesDaOrganizacao(pool, ORG)).toEqual([...FRASES_PADRAO]);
    const semOtimo = FRASES_PADRAO.filter((f) => f !== "Ótimo");
    await pool.query(
      `update organizations set settings = jsonb_build_object('conversa', jsonb_build_object('frases_proibidas', jsonb_build_object('lista', $2::jsonb))) where id = $1`,
      [ORG, JSON.stringify(semOtimo)],
    );
    const lista = await frasesDaOrganizacao(pool, ORG);
    expect(lista).not.toContain("Ótimo");
    expect(acharFrasesProibidas("Ótimo! Vamos seguir.", lista)).toEqual([]);
    expect(acharFrasesProibidas("Perfeito! Em que cidade você mora?", lista)).toEqual(["Perfeito"]);
  });

  it("a contagem soma por frase e semana, separando barrada, removida e enviada", async () => {
    await contarFrasesProibidas(pool, { organizationId: ORG, frases: ["sem pressa"], desfecho: "barrada", fuso: "America/Sao_Paulo" });
    await contarFrasesProibidas(pool, { organizationId: ORG, frases: ["sem pressa"], desfecho: "barrada", fuso: "America/Sao_Paulo" });
    await contarFrasesProibidas(pool, { organizationId: ORG, frases: ["sem pressa", "Perfeito"], desfecho: "removida", fuso: "America/Sao_Paulo" });
    await contarFrasesProibidas(pool, { organizationId: ORG, frases: ["Perfeito"], desfecho: "enviada", fuso: "America/Sao_Paulo" });
    const { rows } = await pool.query(
      `select frase, extract(isodow from semana)::int as dia, barradas, removidas, enviadas
         from frases_proibidas_na_semana where organization_id = $1 order by frase`,
      [ORG],
    );
    expect(rows).toEqual([
      { frase: "Perfeito", dia: 1, barradas: 0, removidas: 1, enviadas: 1 },
      { frase: "sem pressa", dia: 1, barradas: 2, removidas: 1, enviadas: 0 },
    ]);
  });
});
