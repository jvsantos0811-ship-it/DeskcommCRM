/**
 * CONFIGURAÇÕES › IA — "SEM FONTE, NÃO AFIRMA" PELA TELA (PC-020, fork).
 *
 * A conferência nasce em "Barrar e reescrever" em toda organização. A pessoa
 * gestora vê isso na tela, troca para "Só registrar", salva, e a escolha fica
 * depois de recarregar — e volta ao recomendado.
 *
 * A conferência em si (regra contra a base ativa, fala contra o que o cliente
 * disse) é provada contra o Postgres do baseline em
 * `tests/invariants/sem-fonte.test.ts`, e os critérios do pedido em
 * `lib/agent-engine/guardrails/sem-fonte.test.ts`. Capturas em `evidence/pc-020/`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "pc-020");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string; id: string }>;
}

function loadCreds(): Creds {
  const precisaSemear = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager || !c.org_id;
  };
  if (precisaSemear()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

test.describe("PC-020 — Configurações › IA: sem fonte, não afirma", () => {
  test("nasce em barrar e reescrever; a troca salva fica depois de recarregar", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await page.goto("/app/settings/ia");
    const form = page.getByTestId("form-sem-fonte");
    await expect(form).toBeVisible({ timeout: 30_000 });
    await expect(form.getByRole("heading", { name: "Sem fonte, não afirma" })).toBeVisible();
    await expect(form.getByTestId("sem-fonte-decidindo")).toBeChecked();
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await form.screenshot({ path: path.join(EVIDENCIA, "configuracoes-ia-sem-fonte-padrao.png") });

    await form.getByTestId("sem-fonte-observando").check();
    await form.getByTestId("sem-fonte-salvar").click();
    await expect(page.getByText("Conferência de fonte salva.")).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByTestId("sem-fonte-observando")).toBeChecked({ timeout: 30_000 });
    await page.getByTestId("form-sem-fonte").screenshot({ path: path.join(EVIDENCIA, "configuracoes-ia-sem-fonte-observando.png") });

    // Volta ao recomendado para não deixar a organização de teste diferente.
    await page.getByTestId("sem-fonte-decidindo").check();
    await page.getByTestId("sem-fonte-salvar").click();
    await expect(page.getByText("Conferência de fonte salva.")).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByTestId("sem-fonte-decidindo")).toBeChecked({ timeout: 30_000 });
  });
});
