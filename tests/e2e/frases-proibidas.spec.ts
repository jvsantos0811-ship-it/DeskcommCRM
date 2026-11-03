/**
 * CONFIGURAÇÕES › IA — AS FRASES PROIBIDAS PELA TELA (PC-022, fork).
 *
 * A empresa nasce com a lista padrão (as muletas medidas no atendimento de
 * advocacia: "sem pressa", "Anotado", "Perfeito", "Ótimo"…). Quem administra vê
 * a lista, tira uma frase ("Ótimo"), salva, e a lista fica depois de recarregar
 * — e volta ao padrão com um clique. A pessoa gestora vê a lista, mas não muda.
 *
 * A régua em si (achar sem diferença de acento e pontuação, a muleta isolada
 * que sai, "Perfeito! Em que cidade…" → "Em que cidade…") é provada nos testes
 * puros de `lib/agent-engine/agent/frases-proibidas.test.ts`, e a contagem por
 * semana contra o Postgres em `tests/invariants/frases-proibidas.test.ts`.
 * Capturas em `evidence/pc-022/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";
import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

const EVIDENCIA = path.join(process.cwd(), "evidence", "pc-022");
let creds: CredsE2E = lerCreds();

async function loginGestor(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

const linhas = async (page: Page) =>
  (await page.getByTestId("frases-proibidas-lista").inputValue())
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

test.describe("PC-022 — Configurações › IA: frases proibidas", () => {
  test.describe.configure({ timeout: 240_000 });

  test("nasce com a lista padrão; o admin tira \"Ótimo\", salva, e fica depois de recarregar", async ({ page }) => {
    creds = (await loginComoAdmin(page, creds)) as CredsE2E;
    await page.goto("/app/settings/ia");
    const form = page.getByTestId("form-frases-proibidas");
    await expect(form).toBeVisible({ timeout: 30_000 });
    await expect(form.getByRole("heading", { name: "Frases proibidas" })).toBeVisible();
    expect(await linhas(page)).toEqual(expect.arrayContaining(["sem pressa", "Perfeito", "Ótimo", "Anotado"]));
    await expect(page.getByTestId("frases-proibidas-contagem")).toBeVisible();
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCIA, "frases-proibidas-padrao.png"), fullPage: true });

    const semOtimo = (await linhas(page)).filter((l) => l !== "Ótimo");
    await page.getByTestId("frases-proibidas-lista").fill(semOtimo.join("\n"));
    await page.getByTestId("frases-proibidas-salvar").click();
    await expect(page.getByText("Frases proibidas salvas.")).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByTestId("frases-proibidas-lista")).toBeVisible({ timeout: 30_000 });
    expect(await linhas(page)).not.toContain("Ótimo");
    expect(await linhas(page)).toContain("Perfeito");

    // Volta ao padrão para não deixar a organização de teste diferente.
    await form.getByRole("button", { name: "Voltar ao padrão" }).click();
    await page.getByTestId("frases-proibidas-salvar").click();
    await expect(page.getByText("Frases proibidas salvas.")).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByTestId("frases-proibidas-lista")).toBeVisible({ timeout: 30_000 });
    expect(await linhas(page)).toContain("Ótimo");
  });

  test("a pessoa gestora vê a lista, mas não muda", async ({ page }) => {
    await loginGestor(page);
    await page.goto("/app/settings/ia");
    const lista = page.getByTestId("frases-proibidas-lista");
    await expect(lista).toBeVisible({ timeout: 30_000 });
    await expect(lista).toBeDisabled();
    await expect(page.getByTestId("frases-proibidas-salvar")).toHaveCount(0);
    await expect(page.getByText("Só o administrador da empresa muda esta lista.")).toBeVisible();
  });
});
