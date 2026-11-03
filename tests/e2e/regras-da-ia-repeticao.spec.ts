/**
 * CONFIGURAÇÕES › IA — A TRAVA DE REPETIÇÃO PELA TELA (PC-018, fork).
 *
 * A trava nasce LIGADA em toda organização, com o padrão (10 mensagens ou 72 h,
 * semelhança 0,8). A pessoa gestora vê isso na tela, ajusta, salva, e o ajuste
 * fica depois de recarregar — e volta ao padrão com um clique.
 *
 * A régua em si (pergunta respondida, régua de follow-up, "repete") é provada
 * contra o Postgres do baseline em `tests/invariants/repeticao-entre-respostas.test.ts`.
 * Capturas em `evidence/pc-018/`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "pc-018");

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

test.describe("PC-018 — Configurações › IA: não repetir pergunta nem mensagem", () => {
  test("nasce ligada com o padrão; o ajuste salvo fica depois de recarregar", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await page.goto("/app/settings/ia");
    const form = page.getByTestId("form-repeticao");
    await expect(form).toBeVisible({ timeout: 30_000 });
    await expect(form.getByRole("heading", { name: "Não repetir pergunta nem mensagem" })).toBeVisible();

    const ligada = form.getByTestId("repeticao-ligada");
    await expect(ligada).toHaveAttribute("data-state", "checked");
    await expect(form.getByTestId("repeticao-mensagens")).toHaveValue("10");
    await expect(form.getByTestId("repeticao-horas")).toHaveValue("72");
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCIA, "configuracoes-ia-padrao.png") });

    await form.getByTestId("repeticao-mensagens").fill("6");
    await form.getByTestId("repeticao-salvar").click();
    await expect(page.getByText("Regras de repetição salvas.")).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByTestId("repeticao-mensagens")).toHaveValue("6", { timeout: 30_000 });

    // Volta ao padrão para não deixar a organização de teste diferente.
    // Escopo no formulário da repetição: a tela tem outros "Voltar ao padrão"
    // (frases proibidas, PC-022, para quem administra).
    await page.getByTestId("form-repeticao").getByRole("button", { name: "Voltar ao padrão" }).click();
    await page.getByTestId("repeticao-salvar").click();
    await expect(page.getByText("Regras de repetição salvas.")).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByTestId("repeticao-mensagens")).toHaveValue("10", { timeout: 30_000 });
  });
});
