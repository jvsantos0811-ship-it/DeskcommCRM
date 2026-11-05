/**
 * A NOTA DE QUALIDADE NO FUNIL, PELA TELA (v3 §2 e §3), como quem usa faria:
 *
 *   1. o card mostra o selo "A · 86" (e "D · 0" no lead que nunca respondeu),
 *      na linha do título — o card não ganha altura;
 *   2. o "por que" abre com o mouse no selo e pelo teclado, com as parcelas
 *      da prévia (+28, +15, +15, +20, +8);
 *   3. `?nivel=A` deixa só o lead A, o chip "Nível: A" aparece e a barra fica
 *      aberta; o "×" tira o filtro e o lead D volta; o menu do chip liga outro
 *      nível;
 *   4. o pop-up do negócio mostra o mesmo selo.
 *
 * Os fatos (respostas DEPOIS da primeira mensagem da empresa, interesse,
 * isolamento, "só os seus") são provados contra o Postgres em
 * `tests/invariants/qualidade-do-lead.test.ts`; a regra e as bordas, em
 * `lib/dados/qualidade.test.ts`. Capturas em `evidence/qualidade-do-lead/`.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "qualidade-do-lead");

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

const semeado = {
  pipeline: "",
  etapas: [] as string[],
  sessao: "",
  contatos: [] as string[],
  leads: [] as string[],
  tituloA: "",
  tituloD: "",
};

const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

async function contatoComConversa(org: string, nome: string, telefone: string) {
  const { data: contato, error: e1 } = await admin
    .from("contacts")
    .insert({ organization_id: org, phone_number: telefone, display_name: nome, name: nome })
    .select("id")
    .single();
  if (e1 || !contato) throw new Error(`contato: ${e1?.message}`);
  semeado.contatos.push(contato.id as string);
  const { data: conversa, error: e2 } = await admin
    .from("conversations")
    .insert({
      organization_id: org,
      contact_id: contato.id,
      channel_session_id: semeado.sessao,
      status: "open",
      assigned_to_user_id: creds.users.manager!.id,
      assigned_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (e2 || !conversa) throw new Error(`conversa: ${e2?.message}`);
  return { contato: contato.id as string, conversa: conversa.id as string };
}

async function mensagens(org: string, c: { contato: string; conversa: string }, linhas: Array<["inbound" | "outbound", number, string]>) {
  for (const [direcao, h, body] of linhas) {
    const { error } = await admin.from("messages").insert({
      organization_id: org,
      conversation_id: c.conversa,
      channel_session_id: semeado.sessao,
      contact_id: c.contato,
      type: "text",
      direction: direcao,
      status: direcao === "inbound" ? "received" : "sent",
      sent_via: direcao === "inbound" ? "external_device" : "ai",
      body,
      sent_at: horasAtras(h),
      created_at: horasAtras(h),
    });
    if (error) throw new Error(`mensagem: ${error.message}`);
  }
}

async function cenario(): Promise<void> {
  const org = creds.org_id;
  const sufixo = String(Date.now()).slice(-8);
  semeado.tituloA = `Joana Nota E2E ${sufixo}`;
  semeado.tituloD = `Carlos Nota E2E ${sufixo}`;
  semeado.pipeline = randomUUID();
  const { error: e1 } = await admin
    .from("crm_pipelines")
    .insert({ id: semeado.pipeline, organization_id: org, name: `Funil nota ${sufixo}`, slug: `funil-nota-${sufixo}` });
  if (e1) throw new Error(`funil: ${e1.message}`);
  const triagem = randomUUID();
  const proposta = randomUUID();
  semeado.etapas = [triagem, proposta];
  const { error: e2 } = await admin.from("crm_stages").insert([
    { id: triagem, organization_id: org, pipeline_id: semeado.pipeline, name: "Triagem", slug: "triagem", position: 1000, win_probability: 10 },
    { id: proposta, organization_id: org, pipeline_id: semeado.pipeline, name: "Proposta", slug: "proposta", position: 2000, win_probability: 70 },
  ]);
  if (e2) throw new Error(`etapas: ${e2.message}`);
  const { data: sessao, error: e3 } = await admin
    .from("channel_sessions")
    .insert({ organization_id: org, waha_session_name: `e2e-nota-${sufixo}`, webhook_secret_encrypted: "\\x00", status: "STOPPED" })
    .select("id")
    .single();
  if (e3 || !sessao) throw new Error(`sessão: ${e3?.message}`);
  semeado.sessao = sessao.id as string;

  // A Joana da prévia: etapa a 70% (70 × 0,4 = 28), etapa ≥ 50% (+15),
  // interesse gravado (+15), respondeu 4 vezes (+20), a última há 30 h (+8) = 86.
  const a = await contatoComConversa(org, semeado.tituloA, `+55317${sufixo}`);
  const d = await contatoComConversa(org, semeado.tituloD, `+55318${sufixo}`);
  const leadA = randomUUID();
  const leadD = randomUUID();
  semeado.leads = [leadA, leadD];
  const { error: e4 } = await admin.from("crm_leads").insert([
    {
      id: leadA,
      organization_id: org,
      pipeline_id: semeado.pipeline,
      stage_id: proposta,
      title: semeado.tituloA,
      contact_id: a.contato,
      owner_kind: "user",
      owner_user_id: creds.users.manager!.id,
      custom_fields: { servico: "Auxílio-acidente" },
      created_at: horasAtras(50),
    },
    {
      // Nunca respondeu e entrou há 60 h: 10 × 0,4 = 4, −10 → nota 0, nível D.
      id: leadD,
      organization_id: org,
      pipeline_id: semeado.pipeline,
      stage_id: triagem,
      title: semeado.tituloD,
      contact_id: d.contato,
      owner_kind: "user",
      owner_user_id: creds.users.manager!.id,
      created_at: horasAtras(60),
    },
  ]);
  if (e4) throw new Error(`negócios: ${e4.message}`);
  await mensagens(org, a, [
    ["outbound", 47, "Olá! Como posso ajudar?"],
    ["inbound", 46, "quero saber do auxílio"],
    ["inbound", 45, "me machuquei no trabalho"],
    ["inbound", 40, "tenho o laudo"],
    ["inbound", 30, "pode me ligar?"],
  ]);
  await mensagens(org, d, [["outbound", 59, "Olá! Como posso ajudar?"]]);
}

test.describe("v3 §2/§3 — a nota de qualidade no funil", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test.beforeAll(async () => {
    await cenario();
  });

  test.afterAll(async () => {
    if (semeado.contatos.length > 0) {
      await admin.from("messages").delete().in("contact_id", semeado.contatos);
    }
    if (semeado.leads.length > 0) await admin.from("crm_leads").delete().in("id", semeado.leads);
    if (semeado.contatos.length > 0) {
      await admin.from("conversations").delete().in("contact_id", semeado.contatos);
      await admin.from("contacts").delete().in("id", semeado.contatos);
    }
    if (semeado.etapas.length > 0) await admin.from("crm_stages").delete().in("id", semeado.etapas);
    if (semeado.pipeline) await admin.from("crm_pipelines").delete().eq("id", semeado.pipeline);
    if (semeado.sessao) await admin.from("channel_sessions").delete().eq("id", semeado.sessao);
  });

  test("o card mostra o selo na linha do título, e o porquê abre com o mouse e pelo teclado", async ({ page }) => {
    await login(page);
    await page.goto(`/app/pipelines/${semeado.pipeline}`);
    const cardA = page.getByRole("group", { name: `Lead: ${semeado.tituloA}` });
    const cardD = page.getByRole("group", { name: `Lead: ${semeado.tituloD}` });
    await expect(cardA).toBeVisible({ timeout: 30_000 });
    const seloA = cardA.getByTestId("selo-da-nota");
    await expect(seloA).toHaveText("A · 86");
    await expect(seloA).toHaveAttribute("data-nivel", "A");
    await expect(cardD.getByTestId("selo-da-nota")).toHaveText("D · 0");

    // Na linha do título (altura fixa de duas linhas): o selo não acrescenta linha ao card.
    const [selo, titulo] = await Promise.all([seloA.boundingBox(), cardA.locator("h3").boundingBox()]);
    expect(selo && titulo, "selo e título medidos").toBeTruthy();
    expect(selo!.y).toBeGreaterThanOrEqual(titulo!.y - 2);
    expect(selo!.y + selo!.height).toBeLessThanOrEqual(titulo!.y + titulo!.height + 2);

    // A cor do nível A (verde da prévia), medida pelo navegador.
    expect(await seloA.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(227, 243, 234)");

    await seloA.hover();
    const porque = page.getByTestId("porque-da-nota");
    await expect(porque).toBeVisible({ timeout: 10_000 });
    await expect(porque).toContainText(`Por que ${semeado.tituloA} tem nota 86`);
    await expect(porque.locator("li")).toHaveText([
      /Chance de fechar 70% × 0,4.*\+28/,
      /Etapa com chance de 50% ou mais\s*\+15/,
      /Interesse identificado\s*\+15/,
      /Respondeu 3 vezes ou mais\s*\+20/,
      /Respondeu nas últimas 72 h\s*\+8/,
    ]);
    await expect(porque).toContainText("86 de 100");
    await expect(porque).toContainText("Nível A (65 ou mais): Fechar agora.");
    await captura(page, "1-selo-e-porque-no-card");

    // Pelo teclado: o selo recebe foco e Enter abre o porquê do lead D.
    await page.mouse.move(0, 0);
    await expect(porque).toBeHidden({ timeout: 10_000 });
    const seloD = cardD.getByTestId("selo-da-nota");
    await seloD.focus();
    await page.keyboard.press("Enter");
    await expect(porque).toBeVisible({ timeout: 10_000 });
    await expect(porque).toContainText(`Por que ${semeado.tituloD} tem nota 0`);
    await expect(porque).toContainText("Nunca respondeu e entrou há mais de 48 h");
    await expect(porque).toContainText("Ajuste ao limite de 0 a 100");
    // Abrir o porquê não abre o negócio.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("?nivel=A filtra, o chip aparece e sai, e o menu do chip liga outro nível", async ({ page }) => {
    await login(page);
    await page.goto(`/app/pipelines/${semeado.pipeline}?nivel=A`);
    const cardA = page.getByRole("group", { name: `Lead: ${semeado.tituloA}` });
    const cardD = page.getByRole("group", { name: `Lead: ${semeado.tituloD}` });
    await expect(cardA).toBeVisible({ timeout: 30_000 });
    await expect(cardD).toHaveCount(0);
    const chip = page.getByTestId("filtro-qualidade-nivel");
    await expect(chip).toHaveAttribute("data-ligado", "sim");
    await expect(chip).toContainText("Nível: A");
    // Filtro ligado mantém a barra aberta, mesmo sem o mouse.
    await expect(page.getByTestId("filtros-do-funil")).toHaveAttribute("data-recolhida", "nunca");
    await expect(chip).toBeVisible();
    await captura(page, "2-funil-filtrado-nivel-A");

    await page.getByTestId("filtro-qualidade-nivel-tirar").click();
    await expect(page).not.toHaveURL(/nivel=/, { timeout: 10_000 });
    await expect(cardD).toBeVisible({ timeout: 10_000 });
    await expect(chip).toHaveAttribute("data-ligado", "nao");

    // Sem filtro a barra recolhe sem o mouse: o mouse no topo a abre.
    await page.getByTestId("topo-do-funil").hover();
    await page.getByTestId("filtro-qualidade-nivel-abrir").click();
    await page.getByTestId("filtro-qualidade-opcao-nivel-D").click();
    await expect(page).toHaveURL(/nivel=D/, { timeout: 10_000 });
    await expect(cardA).toHaveCount(0);
    await expect(cardD).toBeVisible();
    await expect(chip).toContainText("Nível: D");

    // O F5 mantém o filtro (o link do painel sobrevive).
    await page.reload();
    await expect(cardD).toBeVisible({ timeout: 30_000 });
    await expect(cardA).toHaveCount(0);
    await captura(page, "3-funil-filtrado-nivel-D");
  });

  test("o pop-up do negócio mostra o mesmo selo e o mesmo porquê", async ({ page }) => {
    await login(page);
    await page.goto(`/app/pipelines/${semeado.pipeline}?lead=${semeado.leads[0]}`);
    const cabecalho = page.getByTestId("cabecalho-do-negocio");
    await expect(cabecalho).toBeVisible({ timeout: 30_000 });
    const selo = cabecalho.getByTestId("selo-da-nota");
    await expect(selo).toHaveText("A · 86");
    await selo.click();
    const porque = page.getByTestId("porque-da-nota");
    await expect(porque).toBeVisible({ timeout: 10_000 });
    await expect(porque).toContainText("86 de 100");
    await captura(page, "4-selo-no-pop-up-do-negocio");
  });
});
