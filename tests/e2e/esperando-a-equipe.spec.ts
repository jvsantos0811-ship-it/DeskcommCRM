/**
 * O PAINEL "ESPERANDO A EQUIPE" PELA TELA (PM-027 §6), como o gerente usaria:
 *
 *   1. com o Leitor ligado, Dados › Gestão mostra o painel com o lead que a IA
 *      prometeu à equipe há uma semana e ninguém da equipe respondeu — o motivo,
 *      o "desde", os dias úteis e quem falou por último (a IA);
 *   2. o lead que uma pessoa respondeu pelo CRM depois da promessa NÃO aparece;
 *   3. "Abrir no funil" leva ao quadro com `?esperando=equipe`: o chip
 *      "Esperando a equipe" ligado e só o card que espera; tirar o chip mostra
 *      os dois;
 *   4. com o Leitor desligado, o painel não aparece.
 *
 * A regra (dias úteis, feriado, passagem manual, resposta da IA que não tira,
 * a automática do WhatsApp Business) está em `lib/dados/esperando-a-equipe.test.ts`;
 * a leitura das fontes no banco, em `lib/dados/esperando-a-equipe-da-org.test.ts`.
 * Capturas em `evidence/pm-027-esperando-a-equipe/`.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "pm-027-esperando-a-equipe");

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
  if (precisaSemear()) execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
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

const sufixo = String(Date.now()).slice(-8);
const ESPERA = `Espera Equipe E2E ${sufixo}`;
const ATENDIDO = `Atendido Equipe E2E ${sufixo}`;
const diasAtras = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const semeado = { pipeline: "", sessao: "", contatos: [] as string[], leads: [] as string[], settingsAntes: {} as Record<string, unknown> };

function ficha(desde: string) {
  return {
    contato: "lead",
    interesse: null,
    interesse_texto: null,
    contou_o_caso: "parcial",
    requisitos: "a_confirmar",
    requisitos_faltando: [],
    requisito_em_risco: false,
    negociacao: "nenhuma",
    objecao: "nenhuma",
    fora_da_area: false,
    sem_caso: false,
    recusou: false,
    ja_atendido_por_outro: false,
    confirmar_assinatura: false,
    midia_nao_entendida: false,
    aguardando: null,
    proximo_passo_com: "escritorio",
    palavras_proprias: true,
    esperando_a_equipe: { motivo: "ia_disse_que_equipe_chama", desde, prova: "Vou passar para a equipe, eles te chamam." },
    provas: {},
  };
}

async function ligarLeitor(ligado: boolean): Promise<void> {
  const leitor = { ...((semeado.settingsAntes.leitor as Record<string, unknown> | undefined) ?? {}), ligado };
  const { error } = await admin
    .from("organizations")
    .update({ settings: { ...semeado.settingsAntes, leitor } })
    .eq("id", creds.org_id);
  if (error) throw new Error(`settings: ${error.message}`);
}

async function cenario(): Promise<void> {
  const org = creds.org_id;
  const { data: o } = await admin.from("organizations").select("settings").eq("id", org).single();
  semeado.settingsAntes = (o?.settings ?? {}) as Record<string, unknown>;

  const { data: funil, error: e0 } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", org)
    .eq("is_default", true)
    .single();
  if (e0 || !funil) throw new Error(`funil padrão: ${e0?.message}`);
  semeado.pipeline = funil.id as string;
  const { data: etapa } = await admin
    .from("crm_stages")
    .select("id")
    .eq("pipeline_id", semeado.pipeline)
    .eq("is_won", false)
    .eq("is_lost", false)
    .order("position")
    .limit(1)
    .single();
  if (!etapa) throw new Error("etapa aberta do funil padrão");

  const { data: sessao, error: e1 } = await admin
    .from("channel_sessions")
    .insert({ organization_id: org, waha_session_name: `e2e-espera-${sufixo}`, webhook_secret_encrypted: "\\x00", status: "STOPPED" })
    .select("id")
    .single();
  if (e1 || !sessao) throw new Error(`sessão: ${e1?.message}`);
  semeado.sessao = sessao.id as string;

  const promessa = diasAtras(8);
  for (const [nome, pessoaRespondeu] of [
    [ESPERA, false],
    [ATENDIDO, true],
  ] as const) {
    const fone = `+5531${nome === ESPERA ? "8" : "7"}${sufixo}`;
    const { data: contato, error: e2 } = await admin
      .from("contacts")
      .insert({ organization_id: org, phone_number: fone, display_name: nome, name: nome })
      .select("id")
      .single();
    if (e2 || !contato) throw new Error(`contato: ${e2?.message}`);
    semeado.contatos.push(contato.id as string);
    const { data: conversa, error: e3 } = await admin
      .from("conversations")
      .insert({ organization_id: org, contact_id: contato.id, channel_session_id: semeado.sessao, status: "open" })
      .select("id")
      .single();
    if (e3 || !conversa) throw new Error(`conversa: ${e3?.message}`);
    const leadId = randomUUID();
    semeado.leads.push(leadId);
    const { error: e4 } = await admin.from("crm_leads").insert({
      id: leadId,
      organization_id: org,
      pipeline_id: semeado.pipeline,
      stage_id: etapa.id,
      title: nome,
      contact_id: contato.id,
      source: "whatsapp",
      owner_kind: "user",
      owner_user_id: creds.users.manager!.id,
      created_at: diasAtras(9),
    });
    if (e4) throw new Error(`negócio: ${e4.message}`);
    const falas: Array<[string, string, string, string]> = [
      ["inbound", "external_device", diasAtras(8.01), "quero falar com um advogado"],
      ["outbound", "ai", promessa, "Vou passar para a equipe, eles te chamam."],
    ];
    if (pessoaRespondeu) falas.push(["outbound", "user", diasAtras(7), "Oi! Aqui é da equipe, vamos conversar?"]);
    for (const [direction, sent_via, created_at, body] of falas) {
      const { error } = await admin.from("messages").insert({
        organization_id: org,
        conversation_id: conversa.id,
        channel_session_id: semeado.sessao,
        contact_id: contato.id,
        type: "text",
        direction,
        status: direction === "inbound" ? "received" : "sent",
        sent_via,
        body,
        sent_at: created_at,
        created_at,
      });
      if (error) throw new Error(`mensagem: ${error.message}`);
    }
    const { error: e5 } = await admin.from("crm_lead_ficha").insert({
      organization_id: org,
      lead_id: leadId,
      contact_id: contato.id,
      ficha: ficha(promessa),
      modelo: "anthropic/claude-haiku-5-5",
      versao_prompt: "pm027-v1",
      gatilho: "mensagem_do_lead",
      mensagens_ate: promessa,
    });
    if (e5) throw new Error(`ficha: ${e5.message}`);
  }
  await ligarLeitor(true);
}

async function abrirGestao(page: Page): Promise<void> {
  await page.goto("/app/dados?aba=gestao");
  await expect(page.getByTestId("aba-de-dados-gestao")).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
  // Gestão só aparece com retrato: sem ele, monta pelo "Atualizar agora".
  if (await page.getByTestId("dados-sem-retrato").isVisible({ timeout: 10_000 }).catch(() => false)) {
    const gravou = page.waitForResponse(
      (r) => r.url().includes("/api/v1/dados/qualidade/atualizar") && r.request().method() === "POST",
      { timeout: 60_000 },
    );
    await page.getByTestId("dados-atualizar-agora").click();
    expect((await gravou).status()).toBe(200);
  }
}

test.describe("PM-027 §6 — painel Esperando a equipe", () => {
  test.describe.configure({ mode: "serial", timeout: 240_000 });

  test.beforeAll(async () => {
    await cenario();
  });

  test.afterAll(async () => {
    await admin.from("organizations").update({ settings: semeado.settingsAntes }).eq("id", creds.org_id);
    if (semeado.leads.length > 0) {
      await admin.from("crm_lead_ficha").delete().in("lead_id", semeado.leads);
      await admin.from("crm_leads").delete().in("id", semeado.leads);
    }
    if (semeado.contatos.length > 0) {
      await admin.from("messages").delete().in("contact_id", semeado.contatos);
      await admin.from("conversations").delete().in("contact_id", semeado.contatos);
      await admin.from("contacts").delete().in("id", semeado.contatos);
    }
    if (semeado.sessao) await admin.from("channel_sessions").delete().eq("id", semeado.sessao);
  });

  test("o gerente vê quem espera a equipe, abre o funil filtrado e tira o filtro", async ({ page }) => {
    await login(page);
    await abrirGestao(page);

    const painel = page.getByTestId("esperando-a-equipe");
    await expect(painel).toBeVisible({ timeout: 30_000 });
    const linha = painel.getByTestId("linha-esperando-a-equipe").filter({ hasText: ESPERA });
    await expect(linha).toHaveCount(1);
    await expect(linha).toContainText("A IA disse que a equipe ia chamar");
    await expect(linha).toContainText(/\d+,\d dias úteis/);
    await expect(linha).toContainText("A IA");
    // Uma pessoa respondeu pelo CRM depois da promessa: fora do painel.
    await expect(painel.getByTestId("linha-esperando-a-equipe").filter({ hasText: ATENDIDO })).toHaveCount(0);
    await painel.scrollIntoViewIfNeeded();
    await captura(page, "1-painel-na-gestao");

    const link = painel.getByTestId("esperando-a-equipe-no-funil").filter({ hasText: /Abrir no funil/ }).first();
    await link.click();
    await page.waitForURL(/\/app\/pipelines\/.+esperando=equipe/, { timeout: 30_000 });
    await expect(page.getByTestId("filtro-esperando-a-equipe")).toBeVisible({ timeout: 30_000 });
    const cards = page.getByRole("group", { name: /^Lead: / });
    await expect(cards.filter({ hasText: ESPERA })).toHaveCount(1, { timeout: 30_000 });
    await expect(cards.filter({ hasText: ATENDIDO })).toHaveCount(0);
    await captura(page, "2-funil-filtrado");

    await page.getByTestId("filtro-esperando-a-equipe-tirar").click();
    await expect(page).not.toHaveURL(/esperando=equipe/);
    await expect(cards.filter({ hasText: ATENDIDO })).toHaveCount(1, { timeout: 30_000 });
    await expect(cards.filter({ hasText: ESPERA })).toHaveCount(1);
  });

  test("com o Leitor desligado, o painel não aparece", async ({ page }) => {
    await ligarLeitor(false);
    await login(page);
    await abrirGestao(page);
    await expect(page.getByTestId("cartao-leads-hoje")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("esperando-a-equipe")).toHaveCount(0);
  });
});
