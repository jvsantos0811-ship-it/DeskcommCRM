/**
 * PC-028 PELA TELA E PELA ROTA — o painel da agência no /admin:
 *
 *   1. uma organização de teste com pagamentos lançados: total pago, recebido
 *      no período e dias em atraso batem com a conta à mão;
 *   2. o custo de IA da organização no período bate com o da tela de Usage
 *      (mesma janela), e o custo por conversa = (IA + WhatsApp) ÷ conversas,
 *      com "estimado" no WhatsApp;
 *   3. alertas: pagamento em atraso e teste vencendo;
 *   4. nenhum dado de lead (nome, telefone, texto) no painel nem na planilha;
 *   5. quem não é dono da instalação não acessa a rota nem a exportação; a
 *      exportação do dono vai para a auditoria.
 *
 * Capturas em `evidence/pc-028/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoDono } from "./helpers/login-admin";
import { afirmarDonoDoServidor } from "./utils/precondicao";

const { url, serviceRole } = credenciaisSupabaseDeTeste();
const db = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
const EVIDENCIA = path.join(process.cwd(), "evidence", "pc-028");
const SUFIXO = Date.now().toString(36);

/** Hoje e dias relativos, no calendário de São Paulo. */
function dia(deslocamento = 0): string {
  const hoje = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const d = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + deslocamento);
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
}

const LEAD_NOME = `Lead Secreto ${SUFIXO}`;
const LEAD_FONE = `+5531977${String(Date.now()).slice(-6)}`;
let orgA = "";
let orgB = "";

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

async function novaOrg(nome: string): Promise<string> {
  const { data, error } = await db
    .from("organizations")
    .insert({ slug: `e2e-agencia-${nome}-${SUFIXO}`, legal_name: `${nome} LTDA`, display_name: `Agência ${nome} ${SUFIXO}`, onboarded_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error || !data) throw new Error(`organizations: ${error?.message}`);
  return data.id as string;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await afirmarDonoDoServidor(lerCreds().users.dono!.email);
  orgA = await novaOrg("a");
  orgB = await novaOrg("b");

  // A: mensalidade R$ 1.000,00, vencimento há 5 dias (em atraso), dois pagamentos no período e um antes.
  await db.from("agencia_clientes").insert({
    organization_id: orgA,
    plano: "Crescimento",
    mensalidade_cents: 100000,
    implantacao_cents: 150000,
    implantacao_paga: true,
    inicio: dia(-90),
    proximo_vencimento: dia(-5),
  });
  for (const [quando, valor] of [
    [dia(-2), 60000],
    [dia(-1), 40000],
    [dia(-45), 100000],
  ] as const) {
    const { error } = await db.from("agencia_pagamentos").insert({
      organization_id: orgA,
      tipo: "outro",
      pago_em: quando,
      valor_cents: valor,
      forma: "pix",
    });
    if (error) throw new Error(`pagamento: ${error.message}`);
  }
  // B: em teste, vence em 2 dias, sem pagamento.
  await db.from("agencia_clientes").insert({ organization_id: orgB, plano: "Entrada", teste_ate: dia(2) });

  // Custo de IA e conversas da IA da A, com um lead de nome e telefone que NÃO podem aparecer.
  const { data: sessao } = await db
    .from("channel_sessions")
    .insert({ organization_id: orgA, waha_session_name: `e2e-agencia-${SUFIXO}`, webhook_secret_encrypted: "\\x00", status: "WORKING" })
    .select("id")
    .single();
  // Duas conversas da IA: uma por contato (a conversa é única por contato e canal).
  for (const n of [1, 2]) {
    const { data: contato, error: erroContato } = await db
      .from("contacts")
      .insert({ organization_id: orgA, display_name: LEAD_NOME, name: LEAD_NOME, phone_number: `${LEAD_FONE}${n}` })
      .select("id")
      .single();
    if (erroContato || !contato) throw new Error(`contacts: ${erroContato?.message}`);
    const { data: conversa, error: erroConversa } = await db
      .from("conversations")
      .insert({ organization_id: orgA, contact_id: contato.id, channel_session_id: sessao!.id, status: "open" })
      .select("id")
      .single();
    if (erroConversa || !conversa) throw new Error(`conversations: ${erroConversa?.message}`);
    const { error: erroMensagem } = await db.from("messages").insert({
      organization_id: orgA,
      conversation_id: conversa.id,
      channel_session_id: sessao!.id,
      contact_id: contato.id,
      direction: "outbound",
      status: "sent",
      sent_via: "ai",
      type: "text",
      body: `Mensagem secreta ${SUFIXO} ${n}`,
    });
    if (erroMensagem) throw new Error(`messages: ${erroMensagem.message}`);
  }
  const { error: erroLlm } = await db.from("llm_calls").insert([
    { organization_id: orgA, provider: "anthropic", model: "x", cost_cents: 300, created_at: new Date(Date.now() - 86_400_000).toISOString() },
    { organization_id: orgA, provider: "anthropic", model: "x", cost_cents: 200, created_at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
  ]);
  if (erroLlm) throw new Error(`llm_calls: ${erroLlm.message}`);
});

test("o dono vê os números que batem com a conta à mão e com o Usage", async ({ page }) => {
  await loginComoDono(page, lerCreds());
  const periodo = `periodo=personalizado&de=${dia(-29)}&ate=${dia(0)}`;
  const r = await page.request.get(`/api/v1/admin/agencia?${periodo}`);
  expect(r.ok()).toBe(true);
  const texto = await r.text();
  const corpo = JSON.parse(texto) as {
    data: { clientes: Array<Record<string, unknown> & { organization_id: string }>; config: { cotacao_usd_brl: number; precos_whatsapp: { marketing: number } } };
  };
  const a = corpo.data.clientes.find((c) => c.organization_id === orgA)!;
  const b = corpo.data.clientes.find((c) => c.organization_id === orgB)!;

  // 1. Cobrança: à mão — total 2.000,00; no período 1.000,00; 5 dias de atraso.
  expect(a.total_pago_cents).toBe(200000);
  expect(a.recebido_no_periodo_cents).toBe(100000);
  expect(a.dias_em_atraso).toBe(5);
  expect(a.situacao).toBe("em_atraso");
  expect(a.alertas).toContain("pagamento_em_atraso");
  expect(b.situacao).toBe("teste");
  expect(b.alertas).toContain("teste_vencendo");

  // 2. Custo de IA = Usage (mesma janela de 30 dias) e custo por conversa.
  const usage = await page.request.get(`/api/v1/admin/usage?range=30d&tenant_id=${orgA}`);
  const linhaDoUsage = ((await usage.json()) as { data: { tenants: Array<{ organization_id: string; ai_cost_cents: number }> } }).data.tenants.find(
    (t) => t.organization_id === orgA,
  );
  expect(a.ia_usd_cents).toBe(500);
  expect(linhaDoUsage?.ai_cost_cents).toBe(500);
  const custo = Math.round(500 * corpo.data.config.cotacao_usd_brl) + (a.whatsapp_brl_cents as number);
  expect(a.custo_total_brl_cents).toBe(custo);
  expect(a.conversas_ia).toBe(2);
  expect(a.custo_por_conversa_cents).toBe(Math.round(custo / 2));
  expect(a.whatsapp_estimado).toBe(true);

  // 4. Nenhum dado de lead.
  expect(texto).not.toContain(LEAD_NOME);
  expect(texto).not.toContain(LEAD_FONE);
  expect(texto).not.toContain("Mensagem secreta");

  // Pela tela.
  await page.goto(`/admin/agencia?${periodo}&org=${orgA}`);
  const linha = page.locator(`[data-testid="agencia-linha"][data-org="${orgA}"]`);
  await expect(linha).toBeVisible({ timeout: 30_000 });
  await expect(linha.getByTestId("agencia-dias-em-atraso")).toHaveText("5");
  await expect(linha.locator('[data-alerta="pagamento_em_atraso"]')).toBeVisible();
  await expect(linha).toContainText("estimado");
  await linha.click();
  await expect(page.getByTestId("agencia-total-pago")).toContainText("2.000,00");
  await captura(page, "1-painel-da-agencia");

  // 5. A exportação do dono vai para a auditoria e não leva dado de lead.
  const exp = await page.request.get(`/api/v1/admin/agencia/export?${periodo}&formato=csv`);
  expect(exp.ok()).toBe(true);
  const csv = await exp.text();
  expect(csv).toContain(`Agência a ${SUFIXO}`);
  expect(csv).not.toContain(LEAD_NOME);
  expect(csv).not.toContain(LEAD_FONE);
  await expect
    .poll(async () => {
      const { count } = await db.from("api_audit_log").select("id", { count: "exact", head: true }).eq("action", "agencia.exported");
      return count ?? 0;
    }, { timeout: 15_000 })
    .toBeGreaterThan(0);
});

test("quem não é dono da instalação não acessa a rota nem a exportação", async ({ page }) => {
  const creds = lerCreds();
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
  expect((await page.request.get("/api/v1/admin/agencia")).status()).toBe(403);
  expect((await page.request.get("/api/v1/admin/agencia/export?formato=csv")).status()).toBe(403);
  await page.goto("/admin/agencia");
  await expect(page.getByTestId("painel-da-agencia")).toHaveCount(0);
});
