/**
 * OS PAINÉIS DE DADOS, PELA TELA (v3 §4 e §8), como o gerente usaria:
 *
 *   1. Dados abre na aba "Qualidade do lead"; "Atualizar agora" monta o
 *      retrato e o topo passa a dizer "Atualizado hoje às HH:MM"; o botão fica
 *      bloqueado com a hora em que volta, e um segundo pedido é recusado (409)
 *      pelo servidor com a mesma explicação;
 *   2. o nível A lista a Joana (A · 86) e o link "Abrir os N no funil" leva ao
 *      funil com `?nivel=A&recorte=painel`;
 *   3. ⭐ clicar na contagem de um interesse abre o funil filtrado com a MESMA
 *      quantidade (o cadastro manual com o mesmo interesse fica de fora pelo
 *      recorte do painel, e volta quando o recorte sai);
 *   4. as abas Dinheiro em jogo (valor do catálogo × leads), Gestão e Explorar
 *      (agrupar por interesse → a barra → "Abrir os 3 no funil");
 *   5. o atendente em "só os seus" vê a conta ao vivo dos leads dele, sem
 *      "Atualizar agora".
 *
 * O dia no fuso, o limite de 30 min no banco, a limpeza de 90 dias, a RLS e o
 * isolamento estão em `tests/invariants/retrato-de-dados.test.ts`; os totais, em
 * `lib/dados/retrato.test.ts`. Capturas em `evidence/dados-qualidade-do-lead/`.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "dados-qualidade-do-lead");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string; id: string }>;
}

function loadCreds(): Creds {
  const precisaSemear = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager || !c.users?.agent || !c.org_id;
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

async function login(page: Page, papel: "manager" | "agent"): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users[papel]!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

const sufixo = String(Date.now()).slice(-8);
const TIPO = `Tipo Dados E2E ${sufixo}`;
const semeado = {
  pipeline: "",
  etapaProposta: "",
  primeiraEtapa: "",
  sessao: "",
  tipo: "",
  contatos: [] as string[],
  leads: [] as string[],
  joana: `Joana Dados E2E ${sufixo}`,
};
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const cards = (page: Page) => page.getByRole("group", { name: /^Lead: / });

async function cenario(): Promise<void> {
  const org = creds.org_id;
  const { data: funil, error: e0 } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", org)
    .eq("is_default", true)
    .single();
  if (e0 || !funil) throw new Error(`funil padrão: ${e0?.message}`);
  semeado.pipeline = funil.id as string;
  const { data: etapas } = await admin
    .from("crm_stages")
    .select("id, position")
    .eq("pipeline_id", semeado.pipeline)
    .order("position")
    .limit(1);
  semeado.primeiraEtapa = (etapas?.[0]?.id as string) ?? "";
  semeado.etapaProposta = randomUUID();
  const { error: e1 } = await admin.from("crm_stages").insert({
    id: semeado.etapaProposta,
    organization_id: org,
    pipeline_id: semeado.pipeline,
    name: `Proposta E2E ${sufixo}`,
    slug: `proposta-e2e-${sufixo}`,
    position: 990000,
    win_probability: 70,
  });
  if (e1) throw new Error(`etapa: ${e1.message}`);

  const { data: tipo, error: e2 } = await admin
    .from("catalog_products")
    .insert({
      organization_id: org,
      codigo: `tl-dados-e2e-${sufixo}`,
      nome: TIPO,
      preco_cents: 500000,
      tipo_de_lead: true,
      controla_estoque: false,
      ativo: true,
    })
    .select("id")
    .single();
  if (e2 || !tipo) throw new Error(`tipo de lead: ${e2?.message}`);
  semeado.tipo = tipo.id as string;

  const { data: sessao, error: e3 } = await admin
    .from("channel_sessions")
    .insert({ organization_id: org, waha_session_name: `e2e-dados-${sufixo}`, webhook_secret_encrypted: "\\x00", status: "STOPPED" })
    .select("id")
    .single();
  if (e3 || !sessao) throw new Error(`sessão: ${e3?.message}`);
  semeado.sessao = sessao.id as string;

  const { data: contato, error: e4 } = await admin
    .from("contacts")
    .insert({ organization_id: org, phone_number: `+55319${sufixo}`, display_name: semeado.joana, name: semeado.joana })
    .select("id")
    .single();
  if (e4 || !contato) throw new Error(`contato: ${e4?.message}`);
  semeado.contatos.push(contato.id as string);
  const { data: conversa, error: e5 } = await admin
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
  if (e5 || !conversa) throw new Error(`conversa: ${e5?.message}`);

  const base = {
    organization_id: org,
    pipeline_id: semeado.pipeline,
    owner_kind: "user",
    owner_user_id: creds.users.manager!.id,
    custom_fields: { servico: TIPO },
  };
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  semeado.leads = ids;
  // As linhas com as MESMAS chaves (num insert de várias linhas o PostgREST
  // preenche com nulo a que falta).
  const { error: e6 } = await admin.from("crm_leads").insert([
    { ...base, id: ids[0], stage_id: semeado.etapaProposta, title: semeado.joana, contact_id: contato.id, source: "whatsapp", created_at: horasAtras(50) },
    { ...base, id: ids[1], stage_id: semeado.primeiraEtapa, title: `Carlos Dados E2E ${sufixo}`, contact_id: null, source: "meta_ads", created_at: horasAtras(2) },
    { ...base, id: ids[2], stage_id: semeado.primeiraEtapa, title: `Rita Dados E2E ${sufixo}`, contact_id: null, source: "meta_ads", created_at: horasAtras(1) },
    // Cadastro manual com o mesmo interesse: o painel NÃO conta (recorte), o funil sem o recorte mostra.
    { ...base, id: ids[3], stage_id: semeado.primeiraEtapa, title: `Manual Dados E2E ${sufixo}`, contact_id: null, source: "manual", created_at: horasAtras(1) },
  ]);
  if (e6) throw new Error(`negócios: ${e6.message}`);

  // A Joana da prévia: 70% × 0,4 = 28, etapa ≥ 50% (+15), interesse (+15),
  // respondeu 4 vezes (+20), a última há 30 h (+8) = 86.
  for (const [direcao, h, body] of [
    ["outbound", 47, "Olá! Como posso ajudar?"],
    ["inbound", 46, "quero saber do auxílio"],
    ["inbound", 45, "me machuquei no trabalho"],
    ["inbound", 40, "tenho o laudo"],
    ["inbound", 30, "pode me ligar?"],
  ] as const) {
    const { error } = await admin.from("messages").insert({
      organization_id: org,
      conversation_id: conversa.id,
      channel_session_id: semeado.sessao,
      contact_id: contato.id,
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

  // Sem retrato anterior: o "Atualizar agora" do teste não esbarra nos 30 minutos.
  await admin.from("crm_dados_retrato").delete().eq("organization_id", org);
}

test.describe("v3 §4/§8 — os painéis de Dados", () => {
  test.describe.configure({ mode: "serial", timeout: 240_000 });

  test.beforeAll(async () => {
    await cenario();
  });

  test.afterAll(async () => {
    if (semeado.contatos.length > 0) await admin.from("messages").delete().in("contact_id", semeado.contatos);
    if (semeado.leads.length > 0) await admin.from("crm_leads").delete().in("id", semeado.leads);
    if (semeado.contatos.length > 0) {
      await admin.from("conversations").delete().in("contact_id", semeado.contatos);
      await admin.from("contacts").delete().in("id", semeado.contatos);
    }
    if (semeado.etapaProposta) await admin.from("crm_stages").delete().eq("id", semeado.etapaProposta);
    if (semeado.tipo) await admin.from("catalog_products").delete().eq("id", semeado.tipo);
    if (semeado.sessao) await admin.from("channel_sessions").delete().eq("id", semeado.sessao);
    await admin.from("crm_dados_retrato").delete().eq("organization_id", creds.org_id);
  });

  test("\"Atualizar agora\" monta o retrato: \"Atualizado hoje às\", o botão bloqueia e o 2º pedido é recusado", async ({ page }) => {
    await login(page, "manager");
    await page.goto("/app/dados");
    await expect(page.getByTestId("aba-de-dados-qualidade")).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
    await expect(page.getByTestId("dados-sem-retrato")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("dados-atualizado-em")).toHaveText("Ainda sem retrato de hoje");
    await captura(page, "1-sem-retrato");

    const botao = page.getByTestId("dados-atualizar-agora");
    const gravou = page.waitForResponse(
      (r) => r.url().includes("/api/v1/dados/qualidade/atualizar") && r.request().method() === "POST",
      { timeout: 60_000 },
    );
    await botao.click();
    expect((await gravou).status()).toBe(200);
    await expect(page.getByTestId("dados-atualizado-em")).toHaveText(/^Atualizado hoje às \d{2}:\d{2}$/, { timeout: 30_000 });
    await expect(page.getByTestId("dados-legenda")).toContainText("Clicar num número abre o funil ao vivo");
    await expect(botao).toBeDisabled();
    await expect(page.getByTestId("dados-proximo-atualizar")).toHaveText(/^Dá para atualizar de novo às \d{2}:\d{2}\.$/);
    await captura(page, "2-atualizado-hoje");

    // O servidor recusa o segundo pedido (não é só o botão), com a hora de voltar.
    const recusa = await page.request.post("/api/v1/dados/qualidade/atualizar", { data: {} });
    expect(recusa.status()).toBe(409);
    const corpo = (await recusa.json()) as { error: { code: string; message: string; details: { proximo_em: string } } };
    expect(corpo.error.code).toBe("retrato_recente");
    expect(corpo.error.message).toContain("menos de 30 minutos");
    expect(Date.parse(corpo.error.details.proximo_em)).toBeGreaterThan(Date.now());
  });

  test("o nível A lista a Joana (A · 86) e \"Abrir os N no funil\" leva ao funil com ?nivel=A e o recorte", async ({ page }) => {
    await login(page, "manager");
    await page.goto("/app/dados");
    const cartaoA = page.getByTestId("cartao-nivel-A");
    await expect(cartaoA).toBeVisible({ timeout: 30_000 });
    await cartaoA.click();
    const lista = page.getByTestId("lista-da-qualidade");
    const linhaJoana = lista.locator("tr", { hasText: semeado.joana });
    await expect(linhaJoana).toBeVisible();
    await expect(linhaJoana).toContainText("A · 86");
    await expect(linhaJoana).toContainText(TIPO);
    const nA = Number(await page.getByTestId("cartao-nivel-A-valor").innerText());
    await expect(page.getByTestId("titulo-da-lista")).toContainText(`${nA} leads`);
    await captura(page, "3-nivel-A");

    await page.getByTestId("abrir-lista-no-funil").click();
    await expect(page).toHaveURL(new RegExp(`/app/pipelines/${semeado.pipeline}\\?.*nivel=A.*recorte=painel`), { timeout: 30_000 });
    await expect(page.getByRole("group", { name: `Lead: ${semeado.joana}` })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("filtro-qualidade-nivel")).toContainText("Nível: A");
    await expect(page.getByTestId("filtro-qualidade-recorte")).toBeVisible();
  });

  test("⭐ a contagem de um interesse abre o funil filtrado com a MESMA quantidade", async ({ page }) => {
    await login(page, "manager");
    await page.goto("/app/dados");
    const barra = page.locator(`[data-testid="interesse-no-funil"][data-interesse="${TIPO}"]`);
    await expect(barra).toBeVisible({ timeout: 30_000 });
    const noPainel = Number(await barra.getByTestId("interesse-total").innerText());
    expect(noPainel).toBe(3); // a Joana, o Carlos e a Rita; o cadastro manual fica fora
    await barra.click();
    await expect(page).toHaveURL(/servico=.*recorte=painel/, { timeout: 30_000 });
    await expect(page.getByRole("group", { name: `Lead: ${semeado.joana}` })).toBeVisible({ timeout: 30_000 });
    await expect(cards(page)).toHaveCount(noPainel);
    await captura(page, "4-funil-pelo-interesse");

    // Sem o recorte do painel, o cadastro manual com o mesmo interesse aparece.
    await page.getByTestId("filtro-qualidade-recorte-tirar").click();
    await expect(page).not.toHaveURL(/recorte=/, { timeout: 10_000 });
    await expect(cards(page)).toHaveCount(noPainel + 1);
    await expect(page.getByRole("group", { name: `Lead: Manual Dados E2E ${sufixo}` })).toBeVisible();
  });

  test("as abas Dinheiro em jogo, Gestão e Explorar", async ({ page }) => {
    await login(page, "manager");
    await page.goto("/app/dados?aba=dinheiro");
    await expect(page.getByTestId("aba-de-dados-dinheiro")).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
    await expect(page.getByTestId("cartao-em-jogo")).toBeVisible();
    const linhaDoTipo = page.getByTestId("linha-por-tipo").filter({ hasText: TIPO });
    // Valor médio do catálogo (R$ 5.000) × 3 abertos = R$ 15.000 em jogo.
    await expect(linhaDoTipo).toContainText(/R\$\s5\.000/);
    await expect(linhaDoTipo).toContainText(/R\$\s15\.000/);
    await expect(page.getByTestId("onde-esta-o-dinheiro")).toContainText(semeado.joana);
    await captura(page, "5-dinheiro-em-jogo");

    await page.getByTestId("aba-de-dados-gestao").click();
    await expect(page).toHaveURL(/aba=gestao/);
    await expect(page.getByTestId("cartao-leads-hoje")).toBeVisible();
    await expect(page.getByText("Do lead ao contrato")).toBeVisible();
    await expect(page.getByTestId("leads-por-dia").locator(":scope > div")).toHaveCount(14);
    await captura(page, "6-gestao");

    await page.getByTestId("aba-de-dados-explorar").click();
    await page.getByTestId("explorar-agrupar-interesse").click();
    await page.getByTestId("explorar-medir-leads").click();
    const barra = page.locator(`[data-testid="explorar-barra"][data-chave="${TIPO}"]`);
    await expect(barra).toContainText("3");
    await barra.click();
    await expect(page.getByTestId("explorar-lista").getByTestId("linha-de-lead")).toHaveCount(3);
    await captura(page, "7-explorar");
    await page.getByTestId("explorar-abrir-grupo-no-funil").click();
    await expect(page).toHaveURL(/servico=.*recorte=painel/, { timeout: 30_000 });
    await expect(page.getByRole("group", { name: `Lead: ${semeado.joana}` })).toBeVisible({ timeout: 30_000 });
    await expect(cards(page)).toHaveCount(3);
  });

  test("o atendente em \"só os seus\" vê a conta ao vivo dos leads dele, sem \"Atualizar agora\"", async ({ page }) => {
    // "Só os seus" de propósito (a spec não depende de como outra a deixou), e de volta no fim.
    const { data: org } = await admin.from("organizations").select("settings").eq("id", creds.org_id).single();
    const antes = (org?.settings ?? {}) as Record<string, unknown>;
    await admin.from("organizations").update({ settings: { ...antes, visibility_mode: "own" } }).eq("id", creds.org_id);
    try {
      await verComoAtendente(page);
    } finally {
      await admin.from("organizations").update({ settings: antes }).eq("id", creds.org_id);
    }
  });
});

async function verComoAtendente(page: Page): Promise<void> {
  await login(page, "agent");
  await page.goto("/app/dados");
  await expect(page.getByTestId("dados-atualizado-em")).toHaveText("Calculado agora, com os seus leads", { timeout: 30_000 });
  await expect(page.getByTestId("dados-atualizar-agora")).toHaveCount(0);
  // Os leads do teste são do gerente: o atendente não os vê.
  await expect(page.locator(`[data-testid="interesse-no-funil"][data-interesse="${TIPO}"]`)).toHaveCount(0);
  await captura(page, "8-atendente-so-os-seus");
}
