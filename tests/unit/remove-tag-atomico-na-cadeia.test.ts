/**
 * O `remove_tag` ATÔMICO NO SCHEMA — migration, apêndice do baseline e a ação
 * que a usa (fork, migration 9006). Espelho de `add-tag-atomico-na-cadeia.test.ts`.
 *
 * Cerca estrutural (só lê o repositório): o self-host aplica SÓ o
 * `supabase/baseline.sql`, e a migration é a fonte da verdade para quem usa o
 * Supabase CLI. O que se prende:
 *
 *   1. a migration se descreve e traz as DUAS funções, uma por tabela;
 *   2. a subtração está DENTRO do `UPDATE`, com `RETURNING tags`;
 *   3. `security definer` com `EXECUTE` só para `service_role`, revogado de
 *      `public`/`anon`/`authenticated` (as duas origens de EXECUTE);
 *   4. o corpo aparece IDÊNTICO e uma vez só no `baseline.sql`;
 *   5. o bloco vem ANTES da VARREDURA anon (0116);
 *   6. a ação usa as funções e não regrava uma lista montada no aplicativo.
 *
 * O comportamento (comparação sem maiúsculas, ordem preservada, outra
 * organização, corrida com o `add_tag`) é medido contra o Postgres em
 * `tests/invariants/remove-tag-atomico.test.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const MIGRATION = "supabase/migrations/20261026210000_9006_remover_etiquetas.sql";
const INICIO_DO_CORPO = "create or replace function public.fn_lead_remover_etiquetas(";
const CABECALHO = "-- ---- o remove_tag subtrai no UPDATE, sob a trava da linha (migration 9006, fork) ----";
const VARREDURA = "-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----";

const lerMigration = () => readFileSync(join(RAIZ, MIGRATION), "utf8");
const lerBaseline = () => readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
const FUNCOES = ["fn_lead_remover_etiquetas", "fn_contato_remover_etiquetas"] as const;

describe("o remove_tag atômico (9006) no schema", () => {
  it("controle: a migration existe, se descreve e traz as duas funções", () => {
    expect(existsSync(join(RAIZ, MIGRATION))).toBe(true);
    const sql = lerMigration();
    expect(sql).toMatch(/^-- manifest: \S/);
    for (const f of FUNCOES) expect(sql).toContain(`create or replace function public.${f}(`);
  });

  it("⭐ a subtração é DENTRO do UPDATE, com RETURNING — não uma lista montada fora", () => {
    const sql = lerMigration();
    expect(sql.match(/set tags = array\(\n\s*select t from unnest\(coalesce\(tags, '\{\}'::text\[\]\)\) with ordinality/g)).toHaveLength(2);
    expect(sql.match(/returning tags into v_depois;/g)).toHaveLength(2);
    expect(sql.match(/where organization_id = p_org and id = p_(lead|contato)\n\s*returning tags/g)).toHaveLength(2);
    // A trava da linha antes de calcular o que sai.
    expect(sql.match(/\n\s*for update;/g)).toHaveLength(2);
  });

  it("⭐ EXECUTE só para service_role, revogado de public/anon/authenticated", () => {
    const sql = lerMigration();
    expect(sql.match(/^security definer$/gm)).toHaveLength(2);
    for (const f of FUNCOES) {
      expect(sql).toContain(`revoke all on function public.${f}(uuid, uuid, text[]) from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${f}(uuid, uuid, text[]) to service_role;`);
    }
  });

  it("⭐ o apêndice do baseline espelha a migration, sem diferença e uma vez só", () => {
    const migration = lerMigration();
    const corpo = migration.slice(migration.indexOf(INICIO_DO_CORPO)).trimEnd();
    expect(corpo.length).toBeGreaterThan(2000);
    const baseline = lerBaseline();
    expect(
      baseline.includes(corpo),
      "o corpo da migration não aparece inteiro no baseline — o self-host ficaria sem o remove_tag",
    ).toBe(true);
    expect(baseline.split(corpo)).toHaveLength(2);
  });

  it("⭐ o bloco vem ANTES da varredura anon — função nova nasce exposta", () => {
    const baseline = lerBaseline();
    const bloco = baseline.indexOf(CABECALHO);
    const varredura = baseline.indexOf(VARREDURA);
    expect(bloco).toBeGreaterThan(-1);
    expect(varredura).toBeGreaterThan(-1);
    expect(bloco).toBeLessThan(varredura);
  });

  it("⭐ a ação usa as duas funções — e não regrava uma lista montada no app", () => {
    const acao = readFileSync(join(RAIZ, "lib", "automation", "actions", "remove-tag.ts"), "utf8");
    for (const f of FUNCOES) expect(acao).toContain(`"${f}"`);
    expect(acao).not.toMatch(/\.from\([^)]*\)\s*\n?\s*\.update\(\{\s*tags/);
  });
});
