/**
 * CONFIGURAÇÕES › IA — "REAPROVEITAR O HISTÓRICO ENTRE RESPOSTAS" PELA TELA
 * (PC-035, fork).
 *
 * A chave nasce DESLIGADA em toda organização. Quem administra a empresa a vê
 * na tela, liga, salva, e a escolha fica depois de recarregar — e volta a
 * desligar. A pessoa gestora vê a chave, mas não a muda.
 *
 * O que a chave faz no turno (a ordem da abertura, o histórico em blocos, o fim
 * do laço) é provado sem tela em `lib/agent-engine/agent/abertura/duas-partes.test.ts`
 * e `lib/agent-engine/agent/sem-passada-final.test.ts`. Capturas em `evidence/pc-035/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "./helpers/test";

import { lerCreds, loginComoDono } from "./helpers/login-admin";

const EVIDENCIA = path.join(process.cwd(), "evidence", "pc-035");

test.describe("PC-035 — Configurações › IA: reaproveitar o histórico entre respostas", () => {
  test("nasce desligada; quem administra liga, e a escolha fica depois de recarregar", async ({ page }) => {
    test.setTimeout(180_000);
    await loginComoDono(page, lerCreds());
    await page.goto("/app/settings/ia");
    const form = page.getByTestId("form-abertura-em-duas-partes");
    await expect(form).toBeVisible({ timeout: 30_000 });
    await expect(form.getByRole("heading", { name: "Reaproveitar o histórico entre respostas" })).toBeVisible();
    const chave = form.getByTestId("abertura-em-duas-partes-ligada");
    await expect(chave).not.toBeChecked();
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await form.screenshot({ path: path.join(EVIDENCIA, "configuracoes-ia-chave-desligada.png") });

    await chave.check();
    await form.getByTestId("abertura-em-duas-partes-salvar").click();
    await expect(page.getByText("Economia de leitura salva.")).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByTestId("abertura-em-duas-partes-ligada")).toBeChecked({ timeout: 30_000 });
    await page
      .getByTestId("form-abertura-em-duas-partes")
      .screenshot({ path: path.join(EVIDENCIA, "configuracoes-ia-chave-ligada.png") });

    // Volta a desligar para não deixar a organização de teste diferente.
    await page.getByTestId("abertura-em-duas-partes-ligada").uncheck();
    await page.getByTestId("abertura-em-duas-partes-salvar").click();
    await expect(page.getByText("Economia de leitura salva.")).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByTestId("abertura-em-duas-partes-ligada")).not.toBeChecked({ timeout: 30_000 });
  });
});
