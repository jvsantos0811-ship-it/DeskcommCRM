/**
 * A PASSAGEM QUE CANCELA AS AGENDADAS, NO SCHEMA — migration e apêndice do
 * baseline (fork, migration 9007).
 *
 * Cerca estrutural (só lê o repositório): o self-host aplica SÓ o
 * `supabase/baseline.sql`, e a migration é a fonte da verdade para quem usa o
 * Supabase CLI. O que se prende:
 *
 *   1. a migration se descreve, cria a função e o gatilho AFTER INSERT em
 *      `passagens_de_atendimento` — a tabela que todo caminho de passagem grava;
 *   2. o cancelamento só alcança `scheduled` da MESMA organização e conversa;
 *   3. a falha do gatilho não sobe (`exception when others` → WARNING);
 *   4. as duas origens de EXECUTE revogadas;
 *   5. o corpo aparece IDÊNTICO e uma vez só no `baseline.sql`, ANTES da
 *      VARREDURA anon (0116).
 *
 * O comportamento (notas, idioma, fuso, `sending` intocada, falha contida) é
 * medido contra o Postgres em `tests/invariants/passagem-cancela-agendadas.test.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const MIGRATION = "supabase/migrations/20261027010000_9007_passagem_cancela_agendadas.sql";
const INICIO_DO_CORPO = "create or replace function public.fn_passagem_cancela_agendadas()";
const CABECALHO =
  "-- ---- a passagem para humano cancela as mensagens agendadas da conversa (migration 9007, fork) ----";
const VARREDURA = "-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----";

const lerMigration = () => readFileSync(join(RAIZ, MIGRATION), "utf8");
const lerBaseline = () => readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

describe("a passagem cancela as agendadas (9007) no schema", () => {
  it("controle: a migration existe, se descreve e cria a função e o gatilho", () => {
    expect(existsSync(join(RAIZ, MIGRATION))).toBe(true);
    const sql = lerMigration();
    expect(sql).toMatch(/^-- manifest: \S/);
    expect(sql).toContain(INICIO_DO_CORPO);
    expect(sql).toMatch(
      /create trigger trg_passagem_cancela_agendadas\n\s*after insert on public\.passagens_de_atendimento\n\s*for each row\n\s*execute function public\.fn_passagem_cancela_agendadas\(\);/,
    );
  });

  it("⭐ só cancela `scheduled` da mesma organização e da mesma conversa", () => {
    const sql = lerMigration();
    expect(sql).toMatch(
      /where s\.organization_id = new\.organization_id\n\s*and s\.conversation_id = new\.conversation_id\n\s*and s\.status = 'scheduled'/,
    );
    // Nada de HTTP no gatilho (anti-pattern 9): só tabelas do próprio banco.
    expect(sql).not.toMatch(/net\.http|http_post|pg_net/);
  });

  it("⭐ a falha do gatilho vira WARNING e não derruba a passagem", () => {
    const sql = lerMigration();
    expect(sql).toMatch(/exception when others then\n\s*raise warning 'fn_passagem_cancela_agendadas:/);
  });

  it("as duas origens de EXECUTE revogadas", () => {
    expect(lerMigration()).toContain(
      "revoke execute on function public.fn_passagem_cancela_agendadas() from public, anon, authenticated;",
    );
  });

  it("⭐ o apêndice do baseline espelha a migration, sem diferença e uma vez só, antes da varredura", () => {
    const migration = lerMigration();
    const corpo = migration.slice(migration.indexOf(INICIO_DO_CORPO)).trimEnd();
    expect(corpo.length).toBeGreaterThan(2000);
    const baseline = lerBaseline();
    expect(
      baseline.includes(corpo),
      "o corpo da migration não aparece inteiro no baseline — o self-host ficaria sem o cancelamento",
    ).toBe(true);
    expect(baseline.split(corpo)).toHaveLength(2);

    const bloco = baseline.indexOf(CABECALHO);
    const varredura = baseline.indexOf(VARREDURA);
    expect(bloco).toBeGreaterThan(-1);
    expect(bloco).toBeLessThan(varredura);
    expect(baseline.indexOf(corpo)).toBeGreaterThan(bloco);
    expect(baseline.indexOf(corpo)).toBeLessThan(varredura);
  });
});
