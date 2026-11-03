/**
 * AJUSTES DO FUNIL PELA TELA (03/11/2026, pedido do João com o Venda Tech de
 * referência), como quem usa faria:
 *
 *   1. a barra de filtros do quadro fica RECOLHIDA sem o mouse e desce com o
 *      mouse no topo do funil; com um filtro ligado, fica à vista;
 *   2. o card mostra as tarefas em aberto pelo nome — atrasada primeiro, em
 *      vermelho — e "+N" do resto;
 *   3. o "X" do card do negócio aparece no cabeçalho marinho (antes era escuro
 *      sobre escuro) e fecha;
 *   4. a aba "Ligações" fica no topo para gerente, com ou sem telefonia.
 *
 * Medidas por ferramenta (`boundingBox`, `getComputedStyle`), nunca a olho.
 * Capturas em `evidence/funil-ajustes/`.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "funil-ajustes");

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
const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`) });
}

const semeado = { pipeline: "", etapa: "", lead: "", tarefas: [] as string[], titulo: "" };

async function cenario(): Promise<void> {
  const org = creds.org_id;
  const sufixo = String(Date.now()).slice(-8);
  semeado.titulo = `Ajustes E2E ${sufixo}`;
  semeado.pipeline = randomUUID();
  semeado.etapa = randomUUID();
  const { error: e1 } = await admin
    .from("crm_pipelines")
    .insert({ id: semeado.pipeline, organization_id: org, name: `Funil ajustes ${sufixo}`, slug: `funil-ajustes-${sufixo}` });
  if (e1) throw new Error(`funil: ${e1.message}`);
  const { error: e2 } = await admin
    .from("crm_stages")
    .insert({ id: semeado.etapa, organization_id: org, pipeline_id: semeado.pipeline, name: "Triagem", slug: "triagem", position: 1000 });
  if (e2) throw new Error(`etapa: ${e2.message}`);
  const nome = `Maria Ajustes ${sufixo}`;
  const { data: contato, error: e3 } = await admin
    .from("contacts")
    .insert({ organization_id: org, phone_number: `+55318${sufixo}`, display_name: nome, name: nome })
    .select("id")
    .single();
  if (e3 || !contato) throw new Error(`contato: ${e3?.message}`);
  semeado.lead = randomUUID();
  const { error: e4 } = await admin.from("crm_leads").insert({
    id: semeado.lead,
    organization_id: org,
    pipeline_id: semeado.pipeline,
    stage_id: semeado.etapa,
    title: semeado.titulo,
    contact_id: contato.id,
    owner_kind: "user",
    owner_user_id: creds.users.manager!.id,
  });
  if (e4) throw new Error(`negócio: ${e4.message}`);
  const dia = 24 * 3600_000;
  const agora = Date.now();
  const { data: tarefas, error: e5 } = await admin
    .from("crm_tasks")
    .insert([
      { organization_id: org, lead_id: semeado.lead, title: "Enviar contrato", due_date: new Date(agora + 5 * dia).toISOString() },
      { organization_id: org, lead_id: semeado.lead, title: "Pedir laudo do INSS", due_date: new Date(agora - dia).toISOString() },
      { organization_id: org, lead_id: semeado.lead, title: "Retornar a ligação", due_date: new Date(agora + 2 * dia).toISOString() },
    ])
    .select("id");
  if (e5 || !tarefas) throw new Error(`tarefas: ${e5?.message}`);
  semeado.tarefas = tarefas.map((t) => t.id as string);
}

/** Altura da barra de filtros (a caixa que recolhe), medida pelo navegador. */
async function alturaDosFiltros(page: Page): Promise<number> {
  return (await page.getByTestId("filtros-do-funil").boundingBox())?.height ?? -1;
}

/** Luminância relativa (WCAG) de um `rgb(...)`. */
function luminancia(cor: string): number {
  const [r, g, b] = (cor.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

test.describe("ajustes do funil pela tela (03/11/2026)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await cenario();
  });

  test.afterAll(async () => {
    if (semeado.tarefas.length > 0) await admin.from("crm_tasks").delete().in("id", semeado.tarefas);
    if (semeado.lead) await admin.from("crm_leads").delete().eq("id", semeado.lead);
    if (semeado.etapa) await admin.from("crm_stages").delete().eq("id", semeado.etapa);
    if (semeado.pipeline) await admin.from("crm_pipelines").delete().eq("id", semeado.pipeline);
  });

  test("a barra de filtros recolhe sem o mouse, desce com ele e fica com filtro ligado", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await page.goto(`/app/pipelines/${semeado.pipeline}`);
    const card = page.getByRole("group", { name: `Lead: ${semeado.titulo}` });
    await expect(card).toBeVisible({ timeout: 30_000 });

    const topo = page.getByTestId("topo-do-funil");
    const caixa = await topo.boundingBox();
    // Mouse no quadro, longe do topo: a barra fica recolhida.
    await page.mouse.move((caixa?.x ?? 0) + 200, (caixa?.y ?? 0) + (caixa?.height ?? 0) + 320);
    await expect.poll(() => alturaDosFiltros(page), { timeout: 10_000 }).toBeLessThan(2);
    await captura(page, "1-filtros-recolhidos");

    // Mouse no topo: ela desce.
    await topo.hover();
    await expect.poll(() => alturaDosFiltros(page), { timeout: 10_000 }).toBeGreaterThan(30);
    await expect(page.getByPlaceholder("Buscar por título…")).toBeVisible();
    await captura(page, "2-filtros-com-o-mouse");

    // Com um filtro ligado, fica à vista mesmo sem o mouse.
    await page.goto(`/app/pipelines/${semeado.pipeline}?overdue=1`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await page.mouse.move((caixa?.x ?? 0) + 200, (caixa?.y ?? 0) + (caixa?.height ?? 0) + 320);
    await expect.poll(() => alturaDosFiltros(page), { timeout: 10_000 }).toBeGreaterThan(30);
    await expect(page.getByTestId("filtros-do-funil")).toHaveAttribute("data-recolhida", "nunca");
  });

  test("o card mostra as tarefas em aberto: a atrasada primeiro, em vermelho, e +1", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await page.goto(`/app/pipelines/${semeado.pipeline}`);
    const card = page.getByRole("group", { name: `Lead: ${semeado.titulo}` });
    await expect(card).toBeVisible({ timeout: 30_000 });
    const linhas = card.getByTestId("tarefa-do-card");
    await expect(linhas).toHaveCount(2);
    await expect(linhas.nth(0)).toContainText("Pedir laudo do INSS");
    await expect(linhas.nth(0)).toContainText("atrasada");
    await expect(linhas.nth(0)).toHaveAttribute("data-atrasada", "true");
    await expect(linhas.nth(1)).toContainText("Retornar a ligação");
    await expect(card.getByTestId("tarefas-do-card-resto")).toHaveText("+1 tarefa");
    // Vermelho de verdade: a cor da atrasada difere da normal.
    const [corAtrasada, corNormal] = await Promise.all([
      linhas.nth(0).evaluate((el) => getComputedStyle(el).color),
      linhas.nth(1).evaluate((el) => getComputedStyle(el).color),
    ]);
    expect(corAtrasada).not.toBe(corNormal);
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await card.screenshot({ path: path.join(EVIDENCIA, "3-card-com-tarefas.png") });
  });

  test("o X do card do negócio aparece no cabeçalho marinho e fecha", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await page.goto(`/app/pipelines/${semeado.pipeline}`);
    const card = page.getByRole("group", { name: `Lead: ${semeado.titulo}` });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: semeado.titulo }).click();
    const dialogo = page.getByRole("dialog");
    const fechar = dialogo.getByTestId("fechar-o-negocio");
    await expect(fechar).toBeVisible({ timeout: 30_000 });
    // Um X só (o padrão do diálogo não aparece junto).
    await expect(dialogo.getByRole("button", { name: "Fechar", exact: true })).toHaveCount(1);
    const { cor, fundo } = await fechar.evaluate((el) => {
      const cab = el.closest('[data-testid="cabecalho-do-negocio"]') as HTMLElement;
      return { cor: getComputedStyle(el).color, fundo: getComputedStyle(cab).backgroundColor };
    });
    const [claro, escuro] = [luminancia(cor), luminancia(fundo)].sort((a, b) => b - a);
    expect((claro! + 0.05) / (escuro! + 0.05), `X ${cor} sobre ${fundo}`).toBeGreaterThan(4.5);
    await captura(page, "4-x-no-cabecalho");
    await fechar.click();
    await expect(dialogo).toBeHidden({ timeout: 10_000 });
  });

  test("a aba Ligações fica no topo para gerente, com ou sem telefonia", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await page.goto(`/app/pipelines/${semeado.pipeline}`);
    const aba = page.getByTestId("aba-do-funil-ligacoes");
    await expect(aba).toBeVisible({ timeout: 30_000 });
    await aba.click();
    await page.waitForURL(/\/app\/calls/, { timeout: 30_000 });
    const { data: numeros } = await admin
      .from("phone_numbers")
      .select("id")
      .eq("organization_id", creds.org_id)
      .eq("is_active", true);
    if ((numeros ?? []).length === 0) {
      await expect(page.getByTestId("ligacoes-sem-telefonia")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("link", { name: "Conectar um número" })).toHaveAttribute(
        "href",
        "/app/connections?aba=telefonia",
      );
    }
    await captura(page, "5-aba-ligacoes");
  });
});
