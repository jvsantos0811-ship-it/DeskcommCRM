/**
 * PC-027 PELA TELA — agendar, remarcar e desmarcar pelo pop-up do negócio, no
 * MESMO serviço da Agenda:
 *
 *   1. notebook: "Agendar" no cabeçalho → tipo e um horário livre → o
 *      compromisso aparece no pop-up, na Agenda (banco) e vinculado ao negócio
 *      (`crm_lead_links`), com a linha na linha do tempo;
 *   2. remarcar pelo pop-up muda o horário; desmarcar pede o motivo e cancela;
 *   3. celular: o botão "Agendar" está à vista e abre o formulário.
 *
 * O tipo e a jornada vêm de `scripts/seed-e2e-agenda.ts` (seg a sex, 09–18h).
 * O dia escolhido é uma quarta-feira da semana seguinte: dia útil inteiro, com
 * horários de sobra a qualquer hora em que a CI rode.
 *
 * Capturas em `evidence/pc-027/`.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "pc-027");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string; id: string }>;
  agenda?: { tipo_id: string; tipo_nome: string; dono_user_id: string };
}

function lerCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.agenda) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  if (!c.agenda) throw new Error("seed-e2e-agenda não gravou o bloco `agenda`");
  return c;
}

const creds = lerCreds();
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

/** Uma quarta-feira da semana seguinte, em `AAAA-MM-DD` (calendário de São Paulo). */
function quartaQueVem(): string {
  const hoje = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const diasAteQuarta = ((3 - hoje.getDay() + 7) % 7) + 7;
  const alvo = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + diasAteQuarta);
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${alvo.getFullYear()}-${dois(alvo.getMonth() + 1)}-${dois(alvo.getDate())}`;
}

interface Cenario {
  funil: string;
  lead: string;
  contato: string;
}

async function cenario(): Promise<Cenario> {
  const org = creds.org_id;
  const sufixo = String(Date.now()).slice(-8);
  const funil = randomUUID();
  const etapa = randomUUID();
  const { error: e1 } = await admin
    .from("crm_pipelines")
    .insert({ id: funil, organization_id: org, name: `Agendar PC vinte e sete ${sufixo}`, slug: `agendar-pc027-${sufixo}` });
  if (e1) throw new Error(`funil: ${e1.message}`);
  const { error: e2 } = await admin
    .from("crm_stages")
    .insert({ id: etapa, organization_id: org, pipeline_id: funil, name: "Triagem", slug: "triagem", position: 1000 });
  if (e2) throw new Error(`etapa: ${e2.message}`);
  const nome = `Paciente PC vinte e sete ${sufixo.replace(/\d/g, (d) => "abcdefghij"[Number(d)]!)}`;
  const { data: contato, error: e3 } = await admin
    .from("contacts")
    .insert({ organization_id: org, display_name: nome, name: nome, phone_number: `+55319${sufixo}` })
    .select("id")
    .single();
  if (e3 || !contato) throw new Error(`contato: ${e3?.message}`);
  const lead = randomUUID();
  const { error: e4 } = await admin
    .from("crm_leads")
    .insert({ id: lead, organization_id: org, pipeline_id: funil, stage_id: etapa, title: nome, contact_id: contato.id });
  if (e4) throw new Error(`negócio: ${e4.message}`);
  return { funil, lead, contato: contato.id };
}

async function compromissosDoContato(contato: string) {
  const { data } = await admin
    .from("calendar_appointments")
    .select("id, starts_at, status")
    .eq("organization_id", creds.org_id)
    .eq("contact_id", contato)
    .order("created_at", { ascending: true });
  return (data ?? []) as Array<{ id: string; starts_at: string; status: string }>;
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.describe("PC-027 — agendar pelo pop-up do negócio", () => {
  let c: Cenario;
  const dia = quartaQueVem();

  test.beforeAll(async () => {
    c = await cenario();
  });

  test("agendar, remarcar e desmarcar pelo pop-up (notebook)", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await login(page);
    await page.goto(`/app/pipelines/${c.funil}?lead=${c.lead}`);
    await page.getByTestId("agendar-no-negocio").first().click();
    const dialogo = page.getByTestId("dialogo-de-agendar");
    await expect(dialogo).toBeVisible({ timeout: 30_000 });
    await dialogo.getByTestId("agendar-tipo").selectOption(creds.agenda!.tipo_id);
    await dialogo.getByTestId("agendar-dia").fill(dia);
    const horarios = dialogo.getByTestId("agendar-horario");
    await expect(horarios.first()).toBeVisible({ timeout: 30_000 });
    await horarios.first().click();
    await captura(page, "1-agendar");
    await dialogo.getByTestId("confirmar-agendar").click();
    await expect(dialogo).toHaveCount(0, { timeout: 30_000 });

    // No pop-up, na Agenda (banco) e vinculado ao negócio.
    const item = page.getByTestId("compromisso-do-negocio");
    await expect(item).toHaveCount(1, { timeout: 30_000 });
    const marcados = await compromissosDoContato(c.contato);
    expect(marcados).toHaveLength(1);
    const primeiroHorario = marcados[0]!.starts_at;
    await expect
      .poll(async () => {
        const { data } = await admin
          .from("crm_lead_links")
          .select("lead_id")
          .eq("organization_id", creds.org_id)
          .eq("target_kind", "appointment")
          .eq("target_id", marcados[0]!.id);
        return (data ?? []).map((l: { lead_id: string }) => l.lead_id);
      }, { timeout: 15_000 })
      .toContain(c.lead);
    await captura(page, "2-compromisso-no-popup");

    // Remarcar: outro horário do mesmo dia.
    await item.getByTestId("compromisso-remarcar").click();
    const remarcar = page.getByTestId("dialogo-de-agendar");
    await remarcar.getByTestId("agendar-dia").fill(dia);
    const outros = remarcar.getByTestId("agendar-horario");
    await expect(outros.nth(2)).toBeVisible({ timeout: 30_000 });
    await outros.nth(2).click();
    await remarcar.getByTestId("confirmar-agendar").click();
    await expect(remarcar).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(async () => (await compromissosDoContato(c.contato))[0]?.starts_at, { timeout: 15_000 })
      .not.toBe(primeiroHorario);

    // Desmarcar: pede o motivo e cancela.
    await page.getByTestId("compromisso-do-negocio").getByTestId("compromisso-desmarcar").click();
    await expect(page.getByTestId("confirmar-desmarcar")).toBeDisabled();
    await page.getByTestId("motivo-de-desmarcar").fill("cliente pediu outro dia");
    await page.getByTestId("confirmar-desmarcar").click();
    await expect
      .poll(async () => (await compromissosDoContato(c.contato))[0]?.status, { timeout: 15_000 })
      .toBe("cancelled");
    await captura(page, "3-desmarcado");
  });

  test("celular: o botão Agendar está à vista e abre o formulário", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.goto(`/app/pipelines/${c.funil}?lead=${c.lead}`);
    const botao = page.getByTestId("agendar-no-negocio").first();
    await expect(botao).toBeVisible({ timeout: 30_000 });
    await botao.click();
    await expect(page.getByTestId("dialogo-de-agendar")).toBeVisible({ timeout: 30_000 });
    const largura = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(largura).toBeLessThanOrEqual(390);
    await captura(page, "4-celular");
  });
});
