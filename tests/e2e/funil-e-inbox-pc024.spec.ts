/**
 * PC-024 PELA TELA — funil e Inbox, como a equipe do escritório usaria:
 *
 *   1. ASSUMIR pelo pop-up do negócio (notebook e celular): a conversa passa
 *      para quem clicou, a IA cala (silêncio `infinity` no banco), o Inbox mostra
 *      a mesma pessoa; DEVOLVER pelo pop-up solta a conversa para a IA.
 *   2. Conversa com OUTRA pessoa: o pop-up diz com quem está; o gerente assume
 *      depois de confirmar.
 *   3. MARCAR PERDIDO pelo "⋯" do Inbox: motivo obrigatório, o card vai para a
 *      etapa de perda do funil certo.
 *   4. BUSCA PELO NÚMERO no quadro: "+55 (31) 9xxxx-xxxx", só dígitos, sem o 9 e
 *      os últimos 4 dígitos acham o mesmo card.
 *   5. EXPORTAR: só gerente vê o botão; a etapa escolhida filtra; o campo
 *      sensível fica fora por padrão; acentos com BOM; a auditoria registra.
 *
 * Capturas em `evidence/pc-024/`.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "pc-024");

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

async function login(page: Page, quem: "manager" | "agent" = "manager"): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users[quem]!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`) });
}

interface Cenario {
  pipeline: string;
  triagem: string;
  qualificado: string;
  perdido: string;
  lead: string;
  outroLead: string;
  conversa: string;
  titulo: string;
  outroTitulo: string;
  /** 8 dígitos locais depois do 9 — o celular é +55 31 9XXXX-XXXX. */
  local: string;
}

async function cenario(): Promise<Cenario> {
  const org = creds.org_id;
  const sufixo = String(Date.now()).slice(-8);
  const pipeline = randomUUID();
  const [triagem, qualificado, perdido] = [randomUUID(), randomUUID(), randomUUID()];
  const { error: e1 } = await admin.from("crm_pipelines").insert({
    id: pipeline,
    organization_id: org,
    name: `Funil PC-024 ${sufixo}`,
    slug: `funil-pc024-${sufixo}`,
    settings: {
      fields: [
        { key: "servico", label: "Benefício", type: "text" },
        { key: "cid", label: "CID do laudo", type: "text" },
      ],
    },
  });
  if (e1) throw new Error(`funil: ${e1.message}`);
  const { error: e2 } = await admin.from("crm_stages").insert([
    { id: triagem, organization_id: org, pipeline_id: pipeline, name: "Triagem", slug: "triagem", position: 1000 },
    { id: qualificado, organization_id: org, pipeline_id: pipeline, name: "Qualificação", slug: "qualificacao", position: 2000 },
    { id: perdido, organization_id: org, pipeline_id: pipeline, name: "Não fechou", slug: "nao-fechou", position: 3000, is_lost: true },
  ]);
  if (e2) throw new Error(`etapas: ${e2.message}`);

  const local = `8${sufixo.slice(-7)}`;
  const nome = `Maria PC024 ${sufixo}`;
  const { data: contato, error: e3 } = await admin
    .from("contacts")
    .insert({ organization_id: org, phone_number: `+55319${local}`, display_name: nome, name: nome })
    .select("id")
    .single();
  if (e3 || !contato) throw new Error(`contato: ${e3?.message}`);
  const { data: outro, error: e3b } = await admin
    .from("contacts")
    .insert({ organization_id: org, phone_number: `+5511977${sufixo.slice(-6)}`, display_name: `Outro ${sufixo}`, name: `Outro ${sufixo}` })
    .select("id")
    .single();
  if (e3b || !outro) throw new Error(`outro contato: ${e3b?.message}`);

  const { data: sessao, error: e4 } = await admin
    .from("channel_sessions")
    .insert({ organization_id: org, waha_session_name: `e2e-pc024-${sufixo}`, webhook_secret_encrypted: "\\x00", status: "STOPPED" })
    .select("id")
    .single();
  if (e4 || !sessao) throw new Error(`sessão: ${e4?.message}`);
  const agora = new Date().toISOString();
  const { data: conversa, error: e5 } = await admin
    .from("conversations")
    .insert({
      organization_id: org,
      contact_id: contato.id,
      channel_session_id: sessao.id,
      status: "open",
      last_inbound_at: agora,
      last_message_at: agora,
    })
    .select("id")
    .single();
  if (e5 || !conversa) throw new Error(`conversa: ${e5?.message}`);
  const { error: e5b } = await admin.from("messages").insert({
    organization_id: org,
    conversation_id: conversa.id,
    channel_session_id: sessao.id,
    contact_id: contato.id,
    direction: "inbound",
    status: "received",
    sent_via: "external_device",
    type: "text",
    body: "Oi, quero saber do meu benefício",
    sent_at: agora,
  });
  if (e5b) throw new Error(`mensagem: ${e5b.message}`);

  const lead = randomUUID();
  const outroLead = randomUUID();
  // Títulos SEM dígitos: a busca de texto não pode casar o número por acaso.
  const letras = sufixo.replace(/\d/g, (d) => "abcdefghij"[Number(d)]!);
  const titulo = `Maria PC vinte e quatro ${letras}`;
  const outroTitulo = `Outro PC vinte e quatro ${letras}`;
  const { error: e6 } = await admin.from("crm_leads").insert([
    {
      id: lead,
      organization_id: org,
      pipeline_id: pipeline,
      stage_id: triagem,
      title: titulo,
      contact_id: contato.id,
      custom_fields: { servico: "Auxílio-acidente", cid: "M54" },
    },
    {
      id: outroLead,
      organization_id: org,
      pipeline_id: pipeline,
      stage_id: qualificado,
      title: outroTitulo,
      contact_id: outro.id,
      custom_fields: { servico: "BPC" },
    },
  ]);
  if (e6) throw new Error(`negócios: ${e6.message}`);
  return { pipeline, triagem, qualificado, perdido, lead, outroLead, conversa: conversa.id, titulo, outroTitulo, local };
}

async function conversaNoBanco(id: string) {
  const { data } = await admin
    .from("conversations")
    .select("assigned_to_user_id, bot_silenced_until")
    .eq("id", id)
    .single();
  return data as { assigned_to_user_id: string | null; bot_silenced_until: string | null };
}

test.describe("PC-024 — funil e Inbox", () => {
  test.describe.configure({ mode: "serial" });
  let c: Cenario;

  test.beforeAll(async () => {
    c = await cenario();
  });

  test("assumir e devolver pelo pop-up do negócio (notebook)", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await login(page);
    await page.goto(`/app/pipelines/${c.pipeline}?lead=${c.lead}`);
    const assumir = page.getByTestId("assumir-no-negocio");
    await expect(assumir).toBeVisible({ timeout: 30_000 });
    await captura(page, "1-popup-antes-de-assumir");
    await assumir.click();
    await expect(page.getByTestId("com-voce-no-negocio")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("devolver-no-negocio")).toBeVisible();
    await captura(page, "2-popup-com-voce");

    const depois = await conversaNoBanco(c.conversa);
    expect(depois.assigned_to_user_id).toBe(creds.users.manager!.id);
    // A IA cala para o contato: o mesmo silêncio que o "Assumir" do Inbox grava.
    expect(depois.bot_silenced_until).toBe("infinity");

    // O Inbox mostra a conversa com a mesma pessoa (o "Liberar" é só do dono).
    await page.goto(`/app/inbox?id=${c.conversa}`);
    await expect(page.getByRole("button", { name: "Liberar" })).toBeVisible({ timeout: 30_000 });

    // Devolver pelo pop-up: a conversa volta para a IA (sem dono, sem silêncio).
    await page.goto(`/app/pipelines/${c.pipeline}?lead=${c.lead}`);
    await page.getByTestId("devolver-no-negocio").click();
    await expect(page.getByTestId("assumir-no-negocio")).toBeVisible({ timeout: 15_000 });
    const devolvida = await conversaNoBanco(c.conversa);
    expect(devolvida.assigned_to_user_id).toBeNull();
    expect(devolvida.bot_silenced_until).toBeNull();
  });

  test("assumir pelo pop-up no celular", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.goto(`/app/pipelines/${c.pipeline}?lead=${c.lead}`);
    const assumir = page.getByTestId("assumir-no-negocio");
    await expect(assumir).toBeVisible({ timeout: 30_000 });
    // Sem rolagem horizontal no pop-up do celular.
    const largura = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(largura).toBeLessThanOrEqual(390);
    await assumir.click();
    await expect(page.getByTestId("com-voce-no-negocio")).toBeVisible({ timeout: 15_000 });
    await captura(page, "3-celular-com-voce");
    await page.getByTestId("devolver-no-negocio").click();
    await expect(page.getByTestId("assumir-no-negocio")).toBeVisible({ timeout: 15_000 });
  });

  test("conversa com outra pessoa: o gerente assume depois de confirmar", async ({ page }) => {
    await admin
      .from("conversations")
      .update({
        assigned_to_user_id: creds.users.agent!.id,
        assigned_to_user_name: "E2E Agent",
        assignee_kind: "user",
        status: "claimed",
        bot_silenced_until: "infinity",
      })
      .eq("id", c.conversa);
    await login(page);
    await page.goto(`/app/pipelines/${c.pipeline}?lead=${c.lead}`);
    await expect(page.getByTestId("conversa-com-outra-pessoa")).toContainText("E2E Agent", { timeout: 30_000 });
    await page.getByTestId("assumir-no-negocio").click();
    await expect(page.getByRole("alertdialog")).toContainText("A conversa está com E2E Agent");
    await captura(page, "4-confirmar-tomada");
    await page.getByTestId("confirmar-assumir-no-negocio").click();
    await expect(page.getByTestId("com-voce-no-negocio")).toBeVisible({ timeout: 15_000 });
    expect((await conversaNoBanco(c.conversa)).assigned_to_user_id).toBe(creds.users.manager!.id);
  });

  test("busca do funil pelo número", async ({ page }) => {
    await login(page);
    await page.goto(`/app/pipelines/${c.pipeline}`);
    await page.getByTestId("topo-do-funil").hover();
    const busca = page.getByPlaceholder("Buscar por título ou telefone…");
    await expect(busca).toBeVisible({ timeout: 30_000 });
    const l = c.local;
    const formatos = [
      `+55 (31) 9${l.slice(0, 4)}-${l.slice(4)}`,
      `319${l}`,
      `31${l}`,
      l.slice(-4),
    ];
    for (const termo of formatos) {
      await busca.fill(termo);
      await expect(page.getByText(c.titulo, { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(c.outroTitulo, { exact: true })).toHaveCount(0);
    }
    await captura(page, "5-busca-pelo-numero");
  });

  test("exportar: etapa escolhida, campo sensível fora, BOM e auditoria", async ({ page }) => {
    await login(page);
    await page.goto(`/app/pipelines/${c.pipeline}`);
    await page.getByTestId("exportar-funil").click();
    await page.getByTestId("formato-csv").check();
    await page.getByTestId("etapa-do-export").selectOption(c.qualificado);
    // O campo de saúde nasce DESMARCADO; o comum, marcado.
    await expect(page.getByTestId("campo-do-export-cid")).not.toBeChecked();
    await expect(page.getByTestId("campo-do-export-servico")).toBeChecked();
    await captura(page, "6-dialogo-exportar");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("confirmar-exportar-funil").click(),
    ]);
    const arquivo = await download.path();
    const bytes = fs.readFileSync(arquivo!);
    expect(bytes[0]).toBe(0xef); // BOM UTF-8
    const texto = bytes.toString("utf8");
    expect(texto).toContain("Benefício");
    expect(texto).toContain(c.outroTitulo);
    expect(texto).not.toContain(c.titulo); // outra etapa
    expect(texto).not.toContain("CID do laudo");
    expect(texto).not.toContain("M54");

    const { data: auditoria } = await admin
      .from("api_audit_log")
      .select("action, metadata")
      .eq("organization_id", creds.org_id)
      .eq("action", "pipeline.exported")
      .eq("resource_id", c.pipeline)
      .order("created_at", { ascending: false })
      .limit(1);
    expect(auditoria?.[0]?.metadata).toMatchObject({ formato: "csv", linhas: 1 });
  });

  test("exportar: o atendente não vê o botão", async ({ page }) => {
    await login(page, "agent");
    await page.goto(`/app/pipelines/${c.pipeline}`);
    await expect(page.getByRole("button", { name: /Novo Lead/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("exportar-funil")).toHaveCount(0);
  });

  test("marcar perdido pelo ⋯ do Inbox", async ({ page }) => {
    await login(page);
    await page.goto(`/app/inbox?id=${c.conversa}`);
    await page.getByTestId("mais-acoes-da-conversa").click();
    const item = page.getByTestId("marcar-perdido-na-conversa");
    await expect(item).toBeEnabled({ timeout: 15_000 });
    await item.click();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo).toContainText("Marcar como perdido");
    // Motivo obrigatório: sem escolher, "Confirmar" fica desabilitado.
    await expect(dialogo.getByRole("button", { name: "Confirmar" })).toBeDisabled();
    await dialogo.locator('input[name="lost-reason"]').first().check();
    await captura(page, "7-perdido-pelo-inbox");
    await dialogo.getByRole("button", { name: "Confirmar" }).click();
    await expect(dialogo).toHaveCount(0, { timeout: 15_000 });

    await expect
      .poll(async () => {
        const { data } = await admin.from("crm_leads").select("status, stage_id, lost_reason").eq("id", c.lead).single();
        return data;
      }, { timeout: 15_000 })
      .toMatchObject({ status: "lost", stage_id: c.perdido });
  });
});
