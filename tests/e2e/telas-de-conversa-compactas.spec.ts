/**
 * TELAS DE CONVERSA COMPACTAS — PELA TELA (PC-011, fork).
 *
 * Quem mais lê a conversa é a pessoa da Análise humana: ela precisa ler tudo
 * rápido para assumir. No notebook (1366×768) o cabeçalho, as caixas de agendar
 * e de sugerir, a faixa de conformidade, a régua de etapas e as colunas
 * laterais comiam a altura e a largura da conversa. Este spec mede, como quem
 * usa, o que o PC-011 promete:
 *
 *   1. Inbox e card do negócio: área de mensagens ≥ 60% da altura da janela em
 *      1366×768 (medido com `getBoundingClientRect`, não a olho), e nos outros
 *      dois tamanhos (1920×1080 e celular 390×844) sem rolagem horizontal;
 *   2. Assumir e Fechar à vista; Transferir, Lembrar, Arquivar e Marcar como
 *      pessoal no "⋯";
 *   3. a faixa de conformidade recolhe e REABRE sozinha com um opt-out novo;
 *   4. a régua de um funil de 10 etapas sem barra de rolagem;
 *   5. as laterais do card recolhem e continuam recolhidas depois de recarregar;
 *   6. o modo foco liga pelo botão e sai pelo Esc, nas duas telas.
 *
 * As capturas vão para `evidence/pc-011/` (o CI as publica no artefato
 * `evidencia-parte-N`), e as medidas para `evidence/pc-011/medidas.json`.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "pc-011");
const NOME = "Maria Aparecida dos Santos Oliveira Ferreira da Silva";

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

const TAMANHOS = {
  notebook: { width: 1366, height: 768 },
  monitor: { width: 1920, height: 1080 },
  celular: { width: 390, height: 844 },
} as const;

const medidas: Record<string, unknown> = {};

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

/** Altura da área de mensagens sobre a altura da janela, medida na página. */
async function proporcaoDasMensagens(page: Page, escopo?: string): Promise<{ altura: number; janela: number; proporcao: number }> {
  return page.evaluate((sel) => {
    const raiz = sel ? document.querySelector(sel) : document;
    const area = raiz?.querySelector<HTMLElement>('[data-testid="area-de-mensagens"]');
    const altura = area ? area.getBoundingClientRect().height : 0;
    return { altura, janela: window.innerHeight, proporcao: altura / window.innerHeight };
  }, escopo ?? null);
}

async function semRolagemHorizontal(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

interface Cenario {
  conversa: string;
  contato: string;
  sessao: string;
  pipeline: string;
  titulo: string;
}

async function cenario(): Promise<Cenario> {
  const org = creds.org_id;
  const sufixo = String(Date.now()).slice(-8);
  const titulo = `Compacta E2E ${sufixo}`;

  const { data: sessao, error: e0 } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: org,
      waha_session_name: `e2e-compacta-${sufixo}`,
      webhook_secret_encrypted: "\\x00",
      status: "STOPPED",
    })
    .select("id")
    .single();
  if (e0 || !sessao) throw new Error(`sessão: ${e0?.message}`);

  const { data: contato, error: e1 } = await admin
    .from("contacts")
    .insert({ organization_id: org, phone_number: `+55119${sufixo}`, display_name: NOME, name: NOME })
    .select("id")
    .single();
  if (e1 || !contato) throw new Error(`contato: ${e1?.message}`);

  const agora = new Date();
  const { data: conversa, error: e2 } = await admin
    .from("conversations")
    .insert({
      organization_id: org,
      contact_id: contato.id,
      channel_session_id: sessao.id,
      status: "open",
      last_inbound_at: agora.toISOString(),
      last_message_at: agora.toISOString(),
    })
    .select("id")
    .single();
  if (e2 || !conversa) throw new Error(`conversa: ${e2?.message}`);

  // Uma conversa de verdade, longa o bastante para a área de mensagens rolar.
  const linhas = Array.from({ length: 24 }, (_, i) => ({
    organization_id: org,
    conversation_id: conversa.id,
    channel_session_id: sessao.id,
    contact_id: contato.id,
    direction: i % 2 === 0 ? "inbound" : "outbound",
    status: i % 2 === 0 ? "received" : "delivered",
    sent_via: "external_device",
    type: "text",
    body:
      i % 2 === 0
        ? `Mensagem ${i + 1} do cliente contando o que aconteceu no acidente e o que o médico disse.`
        : `Resposta ${i + 1} da equipe perguntando a data e se há afastamento pelo INSS.`,
    sent_at: new Date(agora.getTime() - (24 - i) * 60_000).toISOString(),
  }));
  const { error: e3 } = await admin.from("messages").insert(linhas);
  if (e3) throw new Error(`mensagens: ${e3.message}`);

  // Um funil de 10 etapas, como o Funil de Vendas da Bórbora.
  const pipeline = randomUUID();
  const { error: e4 } = await admin.from("crm_pipelines").insert({
    id: pipeline,
    organization_id: org,
    name: `Funil compacto ${sufixo}`,
    slug: `funil-compacto-${sufixo}`,
  });
  if (e4) throw new Error(`funil: ${e4.message}`);
  const nomes = [
    "Recepção",
    "Em análise",
    "Reativação",
    "Demanda futura",
    "Qualificado",
    "Análise humana",
    "Falta documento",
    "Aguardando assinatura",
    "Fechado",
    "Desqualificado",
  ];
  const etapas = nomes.map((name, i) => ({
    id: randomUUID(),
    organization_id: org,
    pipeline_id: pipeline,
    name,
    slug: `etapa-${i + 1}`,
    position: (i + 1) * 1000,
  }));
  const { error: e5 } = await admin.from("crm_stages").insert(etapas);
  if (e5) throw new Error(`etapas: ${e5.message}`);

  const { error: e6 } = await admin.from("crm_leads").insert({
    organization_id: org,
    pipeline_id: pipeline,
    stage_id: etapas[5]!.id,
    title: titulo,
    contact_id: contato.id,
    owner_kind: "user",
    owner_user_id: creds.users.manager!.id,
  });
  if (e6) throw new Error(`negócio: ${e6.message}`);

  return {
    conversa: conversa.id as string,
    contato: contato.id as string,
    sessao: sessao.id as string,
    pipeline,
    titulo,
  };
}

/** Um veto de envio por opt-out — o que a faixa de conformidade mostra. */
async function optOutSimulado(c: Cenario): Promise<void> {
  const { data: job, error: e1 } = await admin
    .from("job_queue")
    .insert({ organization_id: creds.org_id, contact_id: c.contato, kind: "inbound_turn", payload: {} })
    .select("id")
    .single();
  if (e1 || !job) throw new Error(`job: ${e1?.message}`);
  const { error } = await admin.from("before_send_traces").insert({
    organization_id: creds.org_id,
    job_id: job.id,
    contact_id: c.contato,
    channel_session_id: c.sessao,
    trace: [],
    vetoed_gate: "contato",
    vetoed_code: "contato_bloqueado",
  });
  if (error) throw new Error(`veto: ${error.message}`);
}

async function abrirOCard(page: Page, c: Cenario) {
  await page.goto(`/app/pipelines/${c.pipeline}`);
  const card = page.getByRole("group", { name: `Lead: ${c.titulo}` });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: c.titulo }).click();
  const dossie = page.getByRole("dialog");
  await expect(dossie).toBeVisible();
  await expect(dossie.getByTestId("area-de-mensagens")).toBeVisible({ timeout: 30_000 });
  return dossie;
}

test.describe("PC-011 — telas de conversa compactas", () => {
  test.describe.configure({ mode: "serial" });
  let c: Cenario;

  test.beforeAll(async () => {
    c = await cenario();
  });

  test.afterAll(() => {
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCIA, "medidas.json"), `${JSON.stringify(medidas, null, 2)}\n`);
  });

  test("Inbox: mensagens ≥ 60% no notebook, ações no lugar, faixa que reabre e modo foco", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(TAMANHOS.notebook);
    await login(page);
    await optOutSimulado(c);
    await page.goto(`/app/inbox/${c.conversa}`);
    await expect(page.getByRole("heading", { level: 2, name: NOME })).toBeVisible({ timeout: 30_000 });

    // Cabeçalho: Assumir e Fechar à vista; o resto no ⋯.
    await expect(page.getByRole("button", { name: "Assumir", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Fechar", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Transferir", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Mais ações" }).click();
    for (const item of ["Transferir", "Lembrar", "Arquivar", "Marcar como pessoal"]) {
      await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    // Quem manda, sem passar o mouse.
    await expect(page.getByTestId("comando-da-conversa")).toBeVisible();
    // Agendar e Sugerir são ícones na barra de escrever, sem caixa própria.
    await expect(page.getByRole("button", { name: "Agendar mensagem" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sugerir resposta", exact: true })).toBeVisible();
    await expect(page.locator('section[aria-label="Assistência do agente"]')).toHaveCount(0);

    // A faixa de conformidade: aberta, recolhe, e REABRE com um opt-out novo.
    const faixa = page.getByTestId("retention-notice");
    await expect(faixa).toBeVisible({ timeout: 30_000 });
    await expect(faixa).toHaveAttribute("data-recolhida", "false");
    await captura(page, "inbox-1366x768-faixa-aberta");
    await faixa.getByRole("button", { name: "Recolher o aviso" }).click();
    await expect(faixa).toHaveAttribute("data-recolhida", "true");
    await expect(faixa, "recolhida, a faixa não pode sumir").toBeVisible();

    const notebook = await proporcaoDasMensagens(page);
    medidas["inbox-1366x768"] = notebook;
    expect(notebook.proporcao, `mensagens com ${notebook.altura}px de ${notebook.janela}px`).toBeGreaterThanOrEqual(0.6);
    await captura(page, "inbox-1366x768");

    await optOutSimulado(c);
    await page.reload();
    await expect(page.getByTestId("retention-notice")).toHaveAttribute("data-recolhida", "false", {
      timeout: 30_000,
    });

    // Modo foco: a lista sai, a conversa fica; o Esc devolve.
    const grade = page.locator("[data-modo-foco]").first();
    await page.getByTestId("modo-foco").click();
    await expect(grade).toHaveAttribute("data-modo-foco", "true");
    await expect(page.getByTestId("comando-da-conversa"), "o modo foco escondeu o estado da IA").toBeVisible();
    medidas["inbox-1366x768-modo-foco"] = await proporcaoDasMensagens(page);
    await captura(page, "inbox-1366x768-modo-foco");
    await page.keyboard.press("Escape");
    await expect(grade).toHaveAttribute("data-modo-foco", "false");

    await page.setViewportSize(TAMANHOS.monitor);
    await page.reload();
    await expect(page.getByTestId("area-de-mensagens")).toBeVisible({ timeout: 30_000 });
    medidas["inbox-1920x1080"] = await proporcaoDasMensagens(page);
    expect(await semRolagemHorizontal(page)).toBe(true);
    await captura(page, "inbox-1920x1080");

    await page.setViewportSize(TAMANHOS.celular);
    await page.reload();
    await expect(page.getByTestId("area-de-mensagens")).toBeVisible({ timeout: 30_000 });
    medidas["inbox-390x844"] = await proporcaoDasMensagens(page);
    expect(await semRolagemHorizontal(page), "rolagem horizontal no celular").toBe(true);
    await expect(page.getByRole("button", { name: "Mais ações" })).toBeVisible();
    await captura(page, "inbox-390x844");
  });

  test("Card do negócio: mensagens ≥ 60% no notebook, régua sem rolagem, laterais que lembram e modo foco", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(TAMANHOS.notebook);
    await login(page);
    let dossie = await abrirOCard(page, c);

    // Cabeçalho em uma linha: nome, etapa atual e responsável.
    const cabecalho = dossie.getByTestId("cabecalho-do-negocio");
    await expect(cabecalho.getByTestId("etapa-atual-do-negocio")).toHaveText("Análise humana");
    const altura = await cabecalho.evaluate((el) => el.getBoundingClientRect().height);
    expect(altura, "o cabeçalho do card quebrou em mais de uma linha").toBeLessThanOrEqual(56);

    // Régua de 10 etapas, sem barra de rolagem; o nome no `title`.
    const regua = dossie.locator("[data-etapas-do-negocio]");
    await expect(regua).toBeVisible();
    await expect(regua.getByRole("button")).toHaveCount(10);
    expect(
      await regua.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      "a régua de 10 etapas rola",
    ).toBe(true);
    await expect(regua.getByRole("button", { name: "8. Aguardando assinatura" })).toHaveAttribute(
      "title",
      /Aguardando assinatura/,
    );

    const notebook = await proporcaoDasMensagens(page, "[data-popup-do-negocio]");
    medidas["card-1366x768"] = notebook;
    expect(notebook.proporcao, `mensagens com ${notebook.altura}px de ${notebook.janela}px`).toBeGreaterThanOrEqual(0.6);
    await captura(page, "card-1366x768");

    // Laterais recolhem, e o estado volta depois de recarregar a página.
    await dossie.getByRole("button", { name: "Recolher: Contato e dados" }).click();
    await dossie.getByRole("button", { name: "Recolher: Tarefas e linha do tempo" }).click();
    await expect(dossie.getByTestId("coluna-dados-do-negocio")).toHaveAttribute("data-recolhida", "true");
    await expect(dossie.getByTestId("coluna-detalhes-do-negocio")).toHaveAttribute("data-recolhida", "true");
    medidas["card-1366x768-laterais-recolhidas"] = await proporcaoDasMensagens(page, "[data-popup-do-negocio]");
    await captura(page, "card-1366x768-laterais-recolhidas");
    await page.reload();
    dossie = await abrirOCard(page, c);
    await expect(dossie.getByTestId("coluna-dados-do-negocio")).toHaveAttribute("data-recolhida", "true");
    await expect(dossie.getByTestId("coluna-detalhes-do-negocio")).toHaveAttribute("data-recolhida", "true");
    await dossie.getByRole("button", { name: "Mostrar: Contato e dados" }).click();
    await dossie.getByRole("button", { name: "Mostrar: Tarefas e linha do tempo" }).click();
    await expect(dossie.getByTestId("coluna-dados-do-negocio")).toHaveAttribute("data-recolhida", "false");

    // Modo foco: some a régua; o Esc sai do foco e NÃO fecha o card.
    await dossie.getByTestId("modo-foco").click();
    await expect(dossie).toHaveAttribute("data-modo-foco", "true");
    await expect(dossie.locator("[data-etapas-do-negocio]")).toHaveCount(0);
    medidas["card-1366x768-modo-foco"] = await proporcaoDasMensagens(page, "[data-popup-do-negocio]");
    await captura(page, "card-1366x768-modo-foco");
    await page.keyboard.press("Escape");
    await expect(dossie).toHaveAttribute("data-modo-foco", "false");
    await expect(dossie, "o Esc do modo foco fechou o card").toBeVisible();

    await page.setViewportSize(TAMANHOS.monitor);
    medidas["card-1920x1080"] = await proporcaoDasMensagens(page, "[data-popup-do-negocio]");
    await captura(page, "card-1920x1080");

    // Celular: abas, régua só com a etapa atual + seletor, sem rolagem lateral.
    await page.setViewportSize(TAMANHOS.celular);
    await expect(dossie.getByRole("tab", { name: "Conversa" })).toBeVisible();
    await expect(dossie.getByRole("button", { name: "Mudar etapa" })).toBeVisible();
    expect(await semRolagemHorizontal(page), "rolagem horizontal no card, no celular").toBe(true);
    medidas["card-390x844"] = await proporcaoDasMensagens(page, "[data-popup-do-negocio]");
    await captura(page, "card-390x844");
    await dossie.getByRole("tab", { name: "Tarefas" }).click();
    await expect(dossie.getByTestId("coluna-detalhes-do-negocio")).toBeVisible();
    await captura(page, "card-390x844-aba-tarefas");
  });
});
