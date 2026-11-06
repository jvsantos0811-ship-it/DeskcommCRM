/**
 * CONFIGURAÇÕES › DISTRIBUIÇÃO DE ATENDIMENTO — O AVISO "NINGUÉM RESPONDEU"
 * PELA TELA (PM-025 §2 e §7, fork).
 *
 * Quem administra liga o aviso, escolhe o funil e os marcadores que tiram o lead
 * da conta, salva, e tudo fica depois de recarregar — com a data em que o aviso
 * foi ligado (sem retroativo: só conta o que chega depois). Desliga no fim, para
 * não deixar a organização de teste diferente.
 *
 * A regra (1 hora de expediente, a resposta automática do WhatsApp Business, o
 * "Obg👍" que encerra, o "Bom dia" que pede resposta, as 9 conversas da Bórbora
 * que dão 8 avisos) é provada em `lib/escalacao/ninguem-respondeu.test.ts`; a
 * rodada em `lib/escalacao/ninguem-respondeu-rodada.test.ts`; o banco em
 * `tests/invariants/aviso-ninguem-respondeu.test.ts`. Capturas em
 * `evidence/pm-025-ninguem-respondeu/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "./helpers/test";
import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

const EVIDENCIA = path.join(process.cwd(), "evidence", "pm-025-ninguem-respondeu");
let creds: CredsE2E = lerCreds();

test.describe("PM-025 — aviso Ninguém respondeu", () => {
  test.describe.configure({ timeout: 240_000 });

  test("o admin liga o aviso, escolhe funil e marcadores, e tudo fica depois de recarregar", async ({ page }) => {
    creds = (await loginComoAdmin(page, creds)) as CredsE2E;
    await page.goto("/app/settings/atendimento");
    const form = page.getByTestId("form-ninguem-respondeu");
    await expect(form).toBeVisible({ timeout: 30_000 });
    await expect(form.getByRole("heading", { name: "Avisar quando ninguém responder" })).toBeVisible();
    await form.scrollIntoViewIfNeeded();
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await form.screenshot({ path: path.join(EVIDENCIA, "1-antes.png") });

    const ligado = page.getByTestId("ninguem-respondeu-ligado");
    if (await ligado.isChecked()) await ligado.uncheck();
    await ligado.check();
    await page.getByTestId("alcance-todos-os-funis").uncheck();
    const funis = page.getByTestId("alcance-funis").locator("input[type=checkbox]");
    await expect(funis.first()).toBeVisible();
    // Deixa só o primeiro funil marcado.
    const total = await funis.count();
    for (let i = 0; i < total; i += 1) {
      if (i === 0) await funis.nth(i).check();
      else await funis.nth(i).uncheck();
    }
    await page.getByTestId("alcance-marcadores").fill("ja-cliente, nao-e-lead");
    await page.getByTestId("salvar-ninguem-respondeu").click();
    await expect(page.getByText("Aviso e alcance salvos.")).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(page.getByTestId("form-ninguem-respondeu")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("ninguem-respondeu-ligado")).toBeChecked();
    await expect(page.getByText(/Ligado desde .*Só contam as mensagens que chegaram depois disso\./)).toBeVisible();
    await expect(page.getByTestId("alcance-todos-os-funis")).not.toBeChecked();
    await expect(page.getByTestId("alcance-funis").locator("input[type=checkbox]").first()).toBeChecked();
    await expect(page.getByTestId("alcance-marcadores")).toHaveValue("ja-cliente, nao-e-lead");
    await page.getByTestId("form-ninguem-respondeu").screenshot({ path: path.join(EVIDENCIA, "2-ligado.png") });

    // Desliga e volta ao padrão.
    await page.getByTestId("ninguem-respondeu-ligado").uncheck();
    await page.getByTestId("alcance-todos-os-funis").check();
    await page.getByTestId("alcance-marcadores").fill("");
    await page.getByTestId("salvar-ninguem-respondeu").click();
    await expect(page.getByText("Aviso e alcance salvos.")).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByTestId("ninguem-respondeu-ligado")).not.toBeChecked({ timeout: 30_000 });
    await expect(page.getByTestId("alcance-todos-os-funis")).toBeChecked();
  });
});
