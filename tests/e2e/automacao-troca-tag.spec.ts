/**
 * A AUTOMAÇÃO QUE TROCA A TAG, provada pela tela (fork, migration 9006).
 *
 * Do jeito que um gerente montaria a régua da gestante: no designer de
 * automações, "Remover tag" (`1o-trimestre`) e depois "Adicionar tag"
 * (`2o-trimestre`). A prova mede o que sai da tela e o que volta:
 *
 *   1. a paleta oferece "Remover tag", e o formulário diz o que acontece;
 *   2. o corpo do `POST /api/v1/automation-rules` leva as duas ações, na ordem
 *      das ligações, e a API aceita (o schema conhece `remove_tag`);
 *   3. o editor em lista abre a mesma regra com "Remover tag" antes de
 *      "Adicionar tag".
 *
 * O que a ação FAZ no banco (subtração atômica, corrida com o `add_tag`) é
 * medido contra o Postgres em `tests/invariants/remove-tag-atomico.test.ts`:
 * este ambiente de e2e não roda o dreno de eventos que executaria a regra.
 *
 * Sem dependência externa: gatilho de etapa e ações que não falam com o cliente.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { test, expect, type Page, type Request } from "./helpers/test";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();
const RULE_NAME = `E2E Troca de tag ${Date.now()}`;
const EVIDENCIA = path.join(process.cwd(), "evidence", "automacao-troca-tag");
fs.mkdirSync(EVIDENCIA, { recursive: true });

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

async function escolher(page: Page, rotulo: string, opcao: string | RegExp): Promise<void> {
  await page.getByRole("combobox", { name: rotulo }).click();
  await page.getByRole("option", { name: opcao }).click();
}

const ehRegra = (metodo: string) => (r: Request) =>
  r.url().includes("/api/v1/automation-rules") && r.method() === metodo;

test.describe("automação que troca a tag", () => {
  test.setTimeout(120_000);
  test.use({ actionTimeout: 15_000 });

  test("Remover tag + Adicionar tag pela paleta: a API grava as duas, na ordem, e o editor em lista as mostra", async ({
    page,
  }) => {
    let ruleId: string | undefined;
    try {
      await login(page, creds.users.manager!.email);
      await page.goto(`${APP_URL}/app/webhooks?aba=automacoes`);
      await page.getByRole("link", { name: "Montar no designer" }).first().click();
      await page.waitForURL(/\/app\/webhooks\/automacoes\/nova$/);
      await page.getByRole("textbox", { name: "Nome da automação" }).fill(RULE_NAME);

      await page.getByTestId("caixa-gatilho").click();
      await escolher(page, "O que dispara a automação", "Quando um lead mudar de etapa");

      // ── 1. Remover tag ───────────────────────────────────────────────────
      await expect(page.getByTestId("paleta-remove_tag")).toBeEnabled();
      await page.getByTestId("paleta-remove_tag").click();
      await expect(page.getByTestId("caixa-acao-1")).toBeVisible();
      await expect(page.getByText("Tags a remover (separadas por vírgula)")).toBeVisible();
      await expect(
        page.getByText("Maiúsculas e espaços nas pontas não importam. Tag que não estiver lá é ignorada."),
      ).toBeVisible();
      await page.getByPlaceholder("boas-vindas, novo-lead").fill("1o-trimestre");
      await page.screenshot({ path: path.join(EVIDENCIA, "01-remover-tag-na-paleta.png"), fullPage: true });

      // ── 2. Adicionar tag ─────────────────────────────────────────────────
      await page.getByTestId("paleta-add_tag").click();
      await expect(page.getByTestId("caixa-acao-2")).toBeVisible();
      await page.getByPlaceholder("boas-vindas, novo-lead").last().fill("2o-trimestre");

      const [criacao] = await Promise.all([
        page.waitForRequest(ehRegra("POST")),
        page.getByTestId("designer-salvar").click(),
      ]);
      const corpo = criacao.postDataJSON() as { actions: unknown[] };
      expect(corpo.actions).toEqual([
        { type: "remove_tag", config: { tags: ["1o-trimestre"] } },
        { type: "add_tag", config: { tags: ["2o-trimestre"] } },
      ]);
      const resposta = await criacao.response();
      expect(resposta?.ok(), "a API recusou a regra com remove_tag").toBeTruthy();
      ruleId = ((await resposta!.json()) as { data: { id: string } }).data.id;
      await page.waitForURL(new RegExp(`/app/webhooks/automacoes/${ruleId}$`));
      await page.screenshot({ path: path.join(EVIDENCIA, "02-regra-salva.png"), fullPage: true });

      // ── 3. O editor em lista abre a mesma regra, na mesma ordem ─────────
      await page.goto(`${APP_URL}/app/webhooks?aba=automacoes`);
      const cartao = page
        .getByText(RULE_NAME, { exact: true })
        .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' border-border ')][1]");
      await cartao.getByRole("button", { name: "Editar automação" }).click();
      const acoes = page.getByRole("dialog").locator("p.font-medium.text-text");
      await expect(acoes.nth(0)).toHaveText("Remover tag");
      await expect(acoes.nth(1)).toHaveText("Adicionar tag");
      await page.screenshot({ path: path.join(EVIDENCIA, "03-editor-em-lista.png"), fullPage: true });
    } finally {
      if (ruleId) await page.request.delete(`${APP_URL}/api/v1/automation-rules/${ruleId}`);
    }
  });
});
