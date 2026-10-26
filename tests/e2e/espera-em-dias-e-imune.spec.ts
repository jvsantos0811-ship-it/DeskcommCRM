/**
 * A ESPERA DO FLUXO EM DIAS, A ESPERA IMUNE E O AVISO DA RESPOSTA — PELA TELA
 * (fork, briefing do Operador item 5).
 *
 * Quem monta a régua de uma gestante (um toque por mês) fazia a conta de
 * cabeça: a tela só aceitava minutos, e 30 dias eram "43200". A espera imune
 * existia no motor, mas só entrava por arquivo. E o publicar não dizia que,
 * com "Cancelar se o lead responder" desligado, a resposta do cliente ADIANTA
 * o próximo envio.
 *
 * A jornada, como o operador faria:
 *
 *   1. monta gatilho → espera → ação → fim;
 *   2. escolhe a unidade "dias" e digita 30 → o cartão diz "30 d";
 *   3. publica → a tela avisa que a resposta adianta o envio (e publica);
 *   4. liga "Continuar esperando mesmo se o cliente responder" → o cartão diz
 *      que a espera não encurta com resposta;
 *   5. publica de novo → sem o aviso, porque a espera não encurta mais;
 *   6. recarrega → a espera continua 30 dias e imune: foi gravada, não só
 *      desenhada.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

import { zoomAte } from "./utils/canvas-do-fluxo";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const ARTIFACTS_DIR = path.join(process.cwd(), "evidence", "espera-em-dias-e-imune");
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  const needsSeed = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (needsSeed()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

/** Arrasta da saída de um nó até a entrada de outro (mesmo gesto de followup-builder.spec.ts). */
async function ligar(page: Page, origem: string, destino: string): Promise<void> {
  const source = page.locator(`.react-flow__node[data-id="${origem}"] .react-flow__handle.source`).first();
  const target = page.locator(`.react-flow__node[data-id="${destino}"] .react-flow__handle.target`);
  const sBox = await source.boundingBox();
  const tBox = await target.boundingBox();
  if (!sBox || !tBox) throw new Error(`handle não encontrado: ${origem} -> ${destino}`);
  await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sBox.x + sBox.width / 2 + 5, sBox.y + sBox.height / 2 + 5, { steps: 3 });
  await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

async function idDoNo(page: Page, tipo: string): Promise<string> {
  const id = await page.locator(`.react-flow__node[data-id^="${tipo}-"]`).getAttribute("data-id");
  if (!id) throw new Error(`nó ${tipo} ausente`);
  return id;
}

async function fecharPainel(page: Page): Promise<void> {
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
  await expect(page.getByTestId("node-config-sheet")).toHaveCount(0);
}

test("espera de 30 dias, imune à resposta, e o aviso de que a resposta adianta o envio", async ({ page }) => {
  await login(page, creds.users.manager!.email);

  await page.goto("/app/ai/followups");
  const nome = `E2E Espera em dias ${Date.now()}`;
  await page.getByRole("button", { name: "Novo fluxo" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nome").fill(nome);
  await dialog.getByRole("button", { name: "Criar fluxo" }).click();
  await expect(dialog).not.toBeVisible();
  await page.locator("li", { hasText: nome }).getByRole("link").click();
  await page.waitForURL(/\/app\/ai\/followups\/[0-9a-f-]+$/);
  const urlDoFluxo = page.url();
  await expect(page.locator(".react-flow")).toBeVisible();

  // 1. gatilho → espera → ação → fim.
  await page.getByTestId("palette-add-trigger").click();
  await page.getByTestId("palette-add-wait").click();
  await page.getByTestId("palette-add-action").click();
  await page.getByTestId("palette-add-end").click();
  await zoomAte(page, 0.85);
  const gatilho = await idDoNo(page, "trigger");
  const espera = await idDoNo(page, "wait");
  const acao = await idDoNo(page, "action");
  const fim = await idDoNo(page, "end");
  await ligar(page, gatilho, espera);
  await ligar(page, espera, acao);
  await ligar(page, acao, fim);
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);

  // 2. A espera em DIAS: 30, e o cartão diz "30 d" — não "43200 min".
  const cartaoDaEspera = page.locator(`[data-testid="node-card-${espera}"]`);
  await cartaoDaEspera.click();
  const painel = page.getByTestId("node-config-panel");
  await expect(painel).toBeVisible();
  await painel.getByTestId("wait-unidade").click();
  await page.getByRole("option", { name: "dias", exact: true }).click();
  await painel.getByLabel("Duração (dias)").fill("30");
  await painel.getByLabel("Duração (dias)").blur();
  await expect(cartaoDaEspera).toContainText("30 d");
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, "espera-01-trinta-dias.png"), fullPage: true });

  await page.locator(`[data-testid="node-card-${acao}"]`).click();
  await painel.getByLabel("Instrução para a IA").fill("Pergunte se {{primeiro_nome}} já tem a data do parto.");
  await painel.getByLabel("Instrução para a IA").blur();
  await fecharPainel(page);

  // 3. Publica: a tela avisa que a resposta adianta o envio — e publica.
  const avisoDaResposta = page.locator("[data-sonner-toast]", { hasText: "ENCURTA a espera" });
  await page.getByTestId("publish-button").click();
  await expect(page.getByText("Fluxo publicado.")).toBeVisible();
  await expect(avisoDaResposta).toBeVisible();
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, "espera-02-aviso-da-resposta.png"), fullPage: true });
  await avisoDaResposta.locator("[data-close-button]").click();
  await expect(avisoDaResposta).toHaveCount(0);

  // 4. Liga a espera imune: o cartão passa a dizer que não encurta.
  await cartaoDaEspera.click();
  await expect(painel).toBeVisible();
  await painel.getByTestId("wait-imune").click();
  await expect(painel.getByTestId("wait-imune")).toHaveAttribute("aria-checked", "true");
  await expect(painel.getByTestId("wait-imune-curta")).toHaveCount(0);
  await expect(cartaoDaEspera).toContainText("30 d · não encurta com resposta");
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, "espera-03-imune.png"), fullPage: true });
  await fecharPainel(page);

  // 5. Publica de novo: sem o aviso, porque nada mais adianta o envio.
  // O "Fluxo publicado." da primeira vez some sozinho (4 s); espera sumir para
  // a confirmação de agora ser a desta publicação.
  await expect(page.getByText("Fluxo publicado.")).toHaveCount(0, { timeout: 15_000 });
  await page.getByTestId("publish-button").click();
  await expect(page.getByText("Fluxo publicado.")).toBeVisible();
  await expect(avisoDaResposta).toHaveCount(0);

  // 6. Recarrega: 30 dias e imune foram GRAVADOS.
  await page.reload();
  await page.waitForURL(urlDoFluxo);
  await expect(page.locator(".react-flow")).toBeVisible();
  await expect(page.locator(`[data-testid="node-card-${espera}"]`)).toContainText(
    "30 d · não encurta com resposta",
  );
  await page.locator(`[data-testid="node-card-${espera}"]`).click();
  await expect(painel.getByLabel("Duração (dias)")).toHaveValue("30");
  await expect(painel.getByTestId("wait-imune")).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, "espera-04-depois-de-recarregar.png"), fullPage: true });
});
