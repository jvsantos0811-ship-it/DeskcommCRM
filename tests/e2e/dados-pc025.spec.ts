/**
 * PC-025 PELA TELA E PELA ROTA — Painel de Dados:
 *
 *   1. MOTIVO DE PERDA em Explorar › Medir: num funil de teste com 3 motivos, os
 *      números da tela batem com a contagem direta no banco; o período conta
 *      pela DATA DA PERDA, com as bordas do dia em Brasília (01/11 00:00 entra,
 *      07/11 23:59 entra, 08/11 00:00 fica fora).
 *   2. PERÍODO NO ENDEREÇO: o link com `?periodo=personalizado&de=…&ate=…` abre
 *      com o mesmo recorte (seletor e legenda).
 *   3. PAROU ANTES DA QUALIFICAÇÃO: 4 cards (só a 1ª mensagem; conversou e
 *      parou; chegou ao Qualificado; perdido) → a) = 1, b) = 1; de 24 para 72 h
 *      o b) cai; sem marco configurado, a tela pede para configurar.
 *
 * Capturas em `evidence/pc-025/`.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "pc-025");

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
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

const org = creds.org_id;
const sufixo = String(Date.now()).slice(-8);
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

interface Cenario {
  funil: string;
  semMarco: string;
  etapas: Record<string, string>;
  ids: Record<string, string>;
}

async function criarFunil(nome: string, comMarco: boolean): Promise<{ id: string; etapas: Record<string, string> }> {
  const id = randomUUID();
  const etapas: Record<string, string> = {
    triagem: randomUUID(),
    qualificado: randomUUID(),
    futura: randomUUID(),
    perdido: randomUUID(),
  };
  const { error: e1 } = await admin.from("crm_pipelines").insert({
    id,
    organization_id: org,
    name: `${nome} ${sufixo}`,
    slug: `${nome.toLowerCase().replace(/\s+/g, "-")}-${sufixo}`,
    settings: comMarco ? { marco_de_qualificacao: etapas.qualificado, etapas_fora_da_medida: [etapas.futura] } : {},
  });
  if (e1) throw new Error(`funil: ${e1.message}`);
  const { error: e2 } = await admin.from("crm_stages").insert([
    { id: etapas.triagem, organization_id: org, pipeline_id: id, name: "Triagem", slug: "triagem", position: 1000 },
    { id: etapas.qualificado, organization_id: org, pipeline_id: id, name: "Qualificado", slug: "qualificado", position: 2000 },
    { id: etapas.futura, organization_id: org, pipeline_id: id, name: "Demanda futura", slug: "futura", position: 3000 },
    { id: etapas.perdido, organization_id: org, pipeline_id: id, name: "Não fechou", slug: "nao-fechou", position: 9000, is_lost: true },
  ]);
  if (e2) throw new Error(`etapas: ${e2.message}`);
  return { id, etapas };
}

async function sessao(): Promise<string> {
  const { data, error } = await admin
    .from("channel_sessions")
    .insert({ organization_id: org, waha_session_name: `e2e-pc025-${sufixo}-${randomUUID().slice(0, 4)}`, webhook_secret_encrypted: "\\x00", status: "STOPPED" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`sessão: ${error?.message}`);
  return data.id;
}

/** Card com conversa: cada par é [direção, horas atrás]. Sem dígito no título. */
async function cardComConversa(
  funil: string,
  etapa: string,
  titulo: string,
  conversa: Array<["inbound" | "outbound", number]>,
  sessaoId: string,
): Promise<string> {
  const { data: contato, error: e1 } = await admin
    .from("contacts")
    .insert({ organization_id: org, display_name: titulo, name: titulo })
    .select("id")
    .single();
  if (e1 || !contato) throw new Error(`contato: ${e1?.message}`);
  const { data: conv, error: e2 } = await admin
    .from("conversations")
    .insert({ organization_id: org, contact_id: contato.id, channel_session_id: sessaoId, status: "open", last_message_at: horasAtras(1) })
    .select("id")
    .single();
  if (e2 || !conv) throw new Error(`conversa: ${e2?.message}`);
  for (const [direcao, h] of conversa) {
    const { error } = await admin.from("messages").insert({
      organization_id: org,
      conversation_id: conv.id,
      channel_session_id: sessaoId,
      contact_id: contato.id,
      direction: direcao,
      status: direcao === "inbound" ? "received" : "sent",
      sent_via: direcao === "inbound" ? "external_device" : "ai",
      type: "text",
      body: "texto que a medida nunca lê",
      created_at: horasAtras(h),
      sent_at: horasAtras(h),
    });
    if (error) throw new Error(`mensagem: ${error.message}`);
  }
  const id = randomUUID();
  const { error: e3 } = await admin.from("crm_leads").insert({
    id,
    organization_id: org,
    pipeline_id: funil,
    stage_id: etapa,
    title: titulo,
    contact_id: contato.id,
    source: "whatsapp",
    created_at: horasAtras(100),
  });
  if (e3) throw new Error(`card: ${e3.message}`);
  return id;
}

/** Card perdido com o motivo e a data da perda (no instante dado). */
async function perdido(funil: string, etapaDePerda: string, titulo: string, motivo: string, closedAt: string): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from("crm_leads").insert({
    id,
    organization_id: org,
    pipeline_id: funil,
    stage_id: etapaDePerda,
    title: titulo,
    status: "lost",
    lost_reason: motivo,
    closed_at: closedAt,
    source: "whatsapp",
  });
  if (error) throw new Error(`perdido: ${error.message}`);
  // O gatilho do encerramento pode carimbar o `closed_at` com "agora": a data
  // da perda do teste é gravada depois, numa escrita só dela.
  const { error: e2 } = await admin.from("crm_leads").update({ closed_at: closedAt }).eq("id", id);
  if (e2) throw new Error(`data da perda: ${e2.message}`);
  return id;
}

test.describe("PC-025 — painel de Dados", () => {
  test.describe.configure({ mode: "serial" });
  let c: Cenario;

  test.beforeAll(async () => {
    const f = await criarFunil("Dados PC vinte e cinco", true);
    const semMarco = await criarFunil("Sem marco PC vinte e cinco", false);
    const s = await sessao();
    const ids: Record<string, string> = {};
    // Perdas em 01/11 a 07/11 (Brasília) com 3 motivos, e as bordas do dia.
    ids.borda_inicio = await perdido(f.id, f.etapas.perdido!, "Perda borda inicio", "price", "2026-11-01T03:00:00.000Z");
    ids.borda_fim = await perdido(f.id, f.etapas.perdido!, "Perda borda fim", "price", "2026-11-08T02:59:00.000Z");
    ids.fora = await perdido(f.id, f.etapas.perdido!, "Perda fora do periodo", "price", "2026-11-08T03:00:00.000Z");
    ids.antes = await perdido(f.id, f.etapas.perdido!, "Perda antes do periodo", "no_response", "2026-11-01T02:59:00.000Z");
    ids.sem_resposta = await perdido(f.id, f.etapas.perdido!, "Perda sem resposta", "no_response", "2026-11-03T15:00:00.000Z");
    ids.outro = await perdido(f.id, f.etapas.perdido!, "Perda outro motivo", "other", "2026-11-05T15:00:00.000Z");
    // O cenário de "parou antes da qualificação".
    ids.so_primeira = await cardComConversa(f.id, f.etapas.triagem!, "Cliente so primeira", [["inbound", 100], ["outbound", 99]], s);
    ids.parou = await cardComConversa(
      f.id,
      f.etapas.triagem!,
      "Cliente conversou e parou",
      [["inbound", 100], ["outbound", 99], ["inbound", 50], ["outbound", 49], ["inbound", 30]],
      s,
    );
    ids.qualificado = await cardComConversa(f.id, f.etapas.qualificado!, "Cliente qualificado", [["inbound", 100], ["outbound", 99], ["inbound", 30]], s);
    ids.futura = await cardComConversa(f.id, f.etapas.futura!, "Cliente demanda futura", [["inbound", 100], ["outbound", 99], ["inbound", 30]], s);
    c = { funil: f.id, semMarco: semMarco.id, etapas: f.etapas, ids };
  });

  test("motivo de perda: tela e rota batem com a contagem direta no banco; bordas do dia em Brasília", async ({ page }) => {
    await login(page);
    const qs = `periodo=personalizado&de=2026-11-01&ate=2026-11-07&pipeline_id=${c.funil}`;
    const r = await page.request.get(`/api/v1/dados/perdas?${qs}`);
    expect(r.ok()).toBe(true);
    const corpo = (await r.json()) as { data: { total: number; motivos: Array<{ motivo: string; leads: number; pct: number; ids: string[] }> } };

    // A contagem direta no banco, com os instantes do período em Brasília.
    const { data: direto } = await admin
      .from("crm_leads")
      .select("id, lost_reason")
      .eq("organization_id", org)
      .eq("pipeline_id", c.funil)
      .eq("status", "lost")
      .gte("closed_at", "2026-11-01T03:00:00.000Z")
      .lt("closed_at", "2026-11-08T03:00:00.000Z");
    const porMotivo = new Map<string, number>();
    for (const l of direto ?? []) porMotivo.set(l.lost_reason, (porMotivo.get(l.lost_reason) ?? 0) + 1);
    expect(corpo.data.total).toBe((direto ?? []).length);
    expect(Object.fromEntries(corpo.data.motivos.map((m) => [m.motivo, m.leads]))).toEqual(Object.fromEntries(porMotivo));
    // As bordas: 01/11 00:00 e 07/11 23:59 entram; 08/11 00:00 e 31/10 23:59 ficam fora.
    const todos = corpo.data.motivos.flatMap((m) => m.ids);
    expect(todos).toContain(c.ids.borda_inicio);
    expect(todos).toContain(c.ids.borda_fim);
    expect(todos).not.toContain(c.ids.fora);
    expect(todos).not.toContain(c.ids.antes);
    expect(corpo.data.motivos.find((m) => m.motivo === "price")).toMatchObject({ leads: 2, pct: 50 });

    // Pela tela: o link do período abre com o mesmo recorte.
    await page.goto(`/app/dados?aba=explorar&periodo=personalizado&de=2026-11-01&ate=2026-11-07`);
    await expect(page.getByTestId("periodo-personalizado")).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
    await expect(page.getByTestId("periodo-de")).toHaveValue("2026-11-01");
    await expect(page.getByTestId("periodo-ate")).toHaveValue("2026-11-07");
    await page.getByTestId("explorar-medir-motivo_de_perda").click();
    await page.getByTestId("perdas-funil").selectOption(c.funil);
    const barras = page.getByTestId("perdas-barra");
    await expect(barras).toHaveCount(porMotivo.size, { timeout: 30_000 });
    await expect(page.locator('[data-testid="perdas-barra"][data-motivo="price"] [data-testid="perdas-numero"]')).toHaveText("2");
    await page.locator('[data-testid="perdas-barra"][data-motivo="price"]').click();
    await expect(page.getByTestId("perdas-card")).toHaveCount(2);
    await captura(page, "1-motivo-de-perda");
  });

  test("parou antes da qualificação: a) = 1, b) = 1; 72 h derruba o b); etapa fora não entra", async ({ page }) => {
    await login(page);
    await page.goto(`/app/dados?aba=explorar&periodo=30d`);
    await page.getByTestId("explorar-medir-parou_antes").click();
    await page.getByTestId("parou-funil").selectOption(c.funil);
    await expect(page.getByTestId("parou-numero-so_primeira")).toHaveText("1", { timeout: 30_000 });
    await expect(page.getByTestId("parou-numero-parou")).toHaveText("1");
    await page.getByTestId("parou-medida-parou").click();
    await expect(page.getByTestId("parou-card")).toHaveCount(1);
    await expect(page.getByTestId("parou-card")).toContainText("Cliente conversou e parou");
    await captura(page, "2-parou-antes-24h");
    await page.getByTestId("parou-horas-72").click();
    await expect(page.getByTestId("parou-numero-parou")).toHaveText("0", { timeout: 30_000 });
    await expect(page.getByTestId("parou-numero-so_primeira")).toHaveText("1");

    // Funil sem marco: a tela pede para configurar.
    await page.getByTestId("parou-funil").selectOption(c.semMarco);
    await expect(page.getByTestId("parou-configure-o-marco")).toBeVisible({ timeout: 30_000 });
    await captura(page, "3-sem-marco");
  });
});
