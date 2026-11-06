/**
 * CONFIGURAÇÕES › VALOR POR TIPO DE LEAD, PELA TELA (v3, seção 1.1, fork).
 *
 * Quem administra cria um tipo de lead com o valor médio, muda o valor, marca
 * "confirmado pelo cliente" e tudo fica depois de recarregar. O atendente vê a
 * mesma lista, mas não muda nada.
 *
 * O efeito no negócio (o valor preenchido pelo interesse, valor de pessoa nunca
 * sobrescrito, a mudança de preço que propaga, o isolamento entre organizações)
 * é provado contra o Postgres em `tests/invariants/valor-por-tipo-de-lead.test.ts`.
 * Capturas em `evidence/tipos-de-lead/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";
import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

const EVIDENCIA = path.join(process.cwd(), "evidence", "tipos-de-lead");
let creds: CredsE2E = lerCreds();
// Nome único por execução: o banco do e2e é compartilhado entre as specs.
const NOME = `Auxílio-acidente E2E ${Date.now().toString(36)}`;

async function loginAtendente(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.agent!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

const linha = (page: Page) => page.locator(`[data-testid="tipo-de-lead-linha"][data-nome="${NOME}"]`);

test.describe("v3 §1.1 — Configurações › Valor por tipo de lead", () => {
  test.describe.configure({ mode: "serial", timeout: 240_000 });

  test("o admin cria um tipo, muda o valor, marca confirmado, e fica depois de recarregar", async ({ page }) => {
    creds = (await loginComoAdmin(page, creds)) as CredsE2E;
    await page.goto("/app/settings/tenant/tipos-de-lead");
    await expect(page.getByRole("heading", { name: "Valor por tipo de lead" })).toBeVisible({ timeout: 30_000 });

    const form = page.getByTestId("novo-tipo-de-lead");
    await form.getByLabel("Tipo de lead").fill(NOME);
    await form.getByLabel("Valor médio").fill("3.000,00");
    await form.getByRole("button", { name: "Adicionar" }).click();
    await expect(page.getByText("Tipo de lead criado.")).toBeVisible({ timeout: 15_000 });
    await expect(linha(page)).toBeVisible();
    await expect(linha(page).getByTestId("tipo-de-lead-valor")).toHaveValue("3000,00");

    await linha(page).getByTestId("tipo-de-lead-valor").fill("3.250,00");
    await linha(page).getByTestId("tipo-de-lead-salvar-valor").click();
    await expect(page.getByText("Tipo de lead salvo.").first()).toBeVisible({ timeout: 15_000 });

    // A caixa muda na hora (otimista); recarregar antes de a gravação voltar
    // mediria a pressa do teste, não a tela. Espera a resposta do PATCH.
    const gravou = page.waitForResponse(
      (r) => r.url().includes("/api/v1/tipos-de-lead/") && r.request().method() === "PATCH",
      { timeout: 15_000 },
    );
    await linha(page).getByTestId("tipo-de-lead-confirmado").check();
    expect((await gravou).status()).toBe(200);
    await expect(linha(page).getByTestId("tipo-de-lead-confirmado")).toBeChecked({ timeout: 15_000 });

    await page.reload();
    await expect(linha(page)).toBeVisible({ timeout: 30_000 });
    await expect(linha(page).getByTestId("tipo-de-lead-valor")).toHaveValue("3250,00");
    await expect(linha(page).getByTestId("tipo-de-lead-confirmado")).toBeChecked();
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCIA, "valor-por-tipo-de-lead-admin.png"), fullPage: true });
  });

  test("o admin escreve o checklist de requisitos mínimos (PM-027) e ele fica depois de recarregar", async ({ page }) => {
    creds = (await loginComoAdmin(page, creds)) as CredsE2E;
    await page.goto("/app/settings/tenant/tipos-de-lead");
    await expect(linha(page)).toBeVisible({ timeout: 30_000 });
    await expect(linha(page).getByTestId("tipo-de-lead-requisitos-resumo")).toHaveText("Nenhum");
    await linha(page).getByTestId("tipo-de-lead-editar-requisitos").click();
    await linha(page).getByTestId("tipo-de-lead-requisitos-texto").fill("houve acidente\n\ncarteira assinada na data\n");
    const gravou = page.waitForResponse(
      (r) => r.url().includes("/api/v1/tipos-de-lead/") && r.request().method() === "PATCH",
      { timeout: 15_000 },
    );
    await linha(page).getByTestId("tipo-de-lead-salvar-requisitos").click();
    expect((await gravou).status()).toBe(200);
    await page.reload();
    await expect(linha(page).getByTestId("tipo-de-lead-requisitos-resumo")).toHaveText("2 requisitos", { timeout: 30_000 });
    await expect(linha(page).getByTestId("tipo-de-lead-requisitos-resumo")).toHaveAttribute(
      "title",
      "houve acidente · carteira assinada na data",
    );
    await page.screenshot({ path: path.join(EVIDENCIA, "valor-por-tipo-de-lead-requisitos.png"), fullPage: true });
  });

  test("o atendente vê a lista, mas não muda", async ({ page }) => {
    await loginAtendente(page);
    await page.goto("/app/settings/tenant/tipos-de-lead");
    await expect(page.getByRole("heading", { name: "Valor por tipo de lead" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Só gerente ou administrador muda os tipos de lead.")).toBeVisible();
    await expect(page.getByTestId("novo-tipo-de-lead")).toHaveCount(0);
    await expect(linha(page)).toBeVisible();
    await expect(linha(page).getByTestId("tipo-de-lead-valor")).toHaveCount(0);
    await expect(linha(page).getByTestId("tipo-de-lead-confirmado")).toBeDisabled();
    await page.screenshot({ path: path.join(EVIDENCIA, "valor-por-tipo-de-lead-atendente.png"), fullPage: true });
  });
});
