/**
 * O CONTRATO DO NEGÓCIO, PELA TELA (fork, migration 9008 — item 7 do briefing
 * de 26/10/2026).
 *
 * Como a equipe do escritório vive isto, na ordem em que faria — com o papel
 * `agent`, porque a decisão do dono é que "qualquer atendente" envia:
 *
 *   1. abre o card do negócio no quadro e anexa o PDF do contrato do escritório;
 *   2. clica em "Enviar ao cliente": o arquivo sai pela conversa do contato no
 *      WhatsApp, com o nome legível — aqui a conexão está desligada, então a
 *      mensagem fica NA FILA e a tela diz isso (é o estado real de uma VPS com
 *      o WhatsApp caído, e sai sozinha quando ele volta);
 *   3. a linha do tempo do negócio registra o envio;
 *   4. marca como assinado, anexando a via assinada — e consegue abri-la;
 *   5. quem só lê (`viewer`) vê o contrato e não tem botão nenhum — nem o
 *      servidor aceita o envio dele.
 *
 * Fora da tela, o que esta spec confere no banco é só o que a tela não mostra:
 * a mensagem do envio é um DOCUMENTO na conversa certa, e o arquivo dela tem o
 * nome legível. A trava de organização, a LGPD e a RLS estão em
 * `tests/invariants/contratos-do-negocio.test.ts`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "contratos-do-negocio");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string }>;
}

function loadCreds(): Creds {
  const precisaSemear = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.agent || !c.users?.viewer || !c.org_id;
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

/** Um PDF de verdade, mínimo: os bytes `%PDF-` são o que a rota confere. */
function pdf(texto: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n% ${texto}\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

interface Cenario {
  titulo: string;
  pipelineId: string;
  conversaId: string;
}

/**
 * Negócio de um cliente com conversa no WhatsApp, numa conexão DESLIGADA
 * (`STOPPED`): o envio vira mensagem na fila, que é o desfecho determinístico
 * sem WhatsApp no CI. O dono do negócio é a atendente, para o card estar no
 * quadro dela qualquer que seja o escopo de visão do papel.
 */
async function cenario(page: Page): Promise<Cenario> {
  const org = creds.org_id;
  const sufixo = String(Date.now()).slice(-8);
  const titulo = `Contrato E2E ${sufixo}`;

  const { data: sessao, error: e0 } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: org,
      waha_session_name: `e2e-contrato-${sufixo}`,
      webhook_secret_encrypted: "\\x00",
      status: "STOPPED",
    })
    .select("id")
    .single();
  if (e0 || !sessao) throw new Error(`sessão: ${e0?.message}`);

  const { data: contato, error: e1 } = await admin
    .from("contacts")
    .insert({ organization_id: org, phone_number: `+55119${sufixo}`, display_name: titulo, name: titulo })
    .select("id")
    .single();
  if (e1 || !contato) throw new Error(`contato: ${e1?.message}`);

  const { data: conversa, error: e2 } = await admin
    .from("conversations")
    .insert({
      organization_id: org,
      contact_id: contato.id,
      channel_session_id: sessao.id,
      status: "open",
      last_inbound_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (e2 || !conversa) throw new Error(`conversa: ${e2?.message}`);

  const funil = await page.request.get("/api/v1/pipelines/default");
  expect(funil.status()).toBe(200);
  const { data } = (await funil.json()) as { data: { pipeline: { id: string }; stages: Array<{ id: string }> } };
  const stageId = data.stages[0]?.id;
  if (!stageId) throw new Error("funil padrão sem etapas");

  const { error: e3 } = await admin.from("crm_leads").insert({
    organization_id: org,
    pipeline_id: data.pipeline.id,
    stage_id: stageId,
    title: titulo,
    contact_id: contato.id,
    owner_kind: "user",
    owner_user_id: creds.users.agent!.id,
  });
  if (e3) throw new Error(`negócio: ${e3.message}`);

  return { titulo, pipelineId: data.pipeline.id, conversaId: conversa.id as string };
}

async function abrirOCard(page: Page, c: Cenario) {
  await page.goto(`/app/pipelines/${c.pipelineId}`);
  const card = page.getByRole("group", { name: `Lead: ${c.titulo}` });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: c.titulo }).click();
  const dossie = page.getByRole("dialog");
  await expect(dossie).toBeVisible();
  return dossie;
}

test("a atendente anexa o contrato, envia ao cliente pelo WhatsApp e marca como assinado", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, creds.users.agent!.email);
  const c = await cenario(page);

  // 1. anexar o PDF do escritório pelo card.
  const dossie = await abrirOCard(page, c);
  const secao = dossie.getByTestId("contratos-do-negocio");
  await expect(secao).toContainText("Nenhum contrato neste negócio.");
  await secao.getByRole("button", { name: "Anexar contrato" }).click();
  await secao.getByLabel("Arquivo do contrato (PDF, até 20 MB)").setInputFiles({
    name: "Contrato de Honorários.pdf",
    mimeType: "application/pdf",
    buffer: pdf("contrato do escritório"),
  });
  // O nome nasce do arquivo, e é o que o cliente verá no WhatsApp.
  await expect(secao.getByLabel("Nome do contrato")).toHaveValue("Contrato de Honorários");
  await secao.getByRole("button", { name: "Anexar", exact: true }).click();

  const item = secao.locator("[data-contrato-status]");
  await expect(item).toHaveCount(1, { timeout: 15_000 });
  await expect(item).toHaveAttribute("data-contrato-status", "rascunho");
  await expect(item).toContainText("Ainda não enviado");
  await captura(page, "01-contrato-anexado");

  // 2. enviar ao cliente: a mensagem já vem escrita, e pode ser trocada.
  await item.getByRole("button", { name: "Enviar ao cliente" }).click();
  await expect(item.getByLabel("Mensagem que vai junto com o arquivo (opcional)")).toHaveValue(
    "Segue o contrato para sua assinatura. Qualquer dúvida, é só me chamar.",
  );
  await item.getByRole("button", { name: "Enviar pelo WhatsApp" }).click();
  await expect(item).toHaveAttribute("data-contrato-status", "enviado", { timeout: 30_000 });
  await expect(item).toContainText("Aguardando assinatura");
  // A conexão está desligada: a tela diz que o contrato está na fila.
  await expect(item).toContainText("Na fila: sai assim que a conexão do WhatsApp voltar.");
  await captura(page, "02-contrato-enviado-na-fila");

  // O que a tela não mostra: um DOCUMENTO na conversa do cliente, com o nome legível.
  const { data: mensagens } = await admin
    .from("messages")
    .select("type, status, media_storage_path, body")
    .eq("conversation_id", c.conversaId);
  expect(mensagens).toHaveLength(1);
  expect(mensagens![0]!.type).toBe("document");
  expect(mensagens![0]!.status).toBe("queued");
  expect(String(mensagens![0]!.media_storage_path)).toMatch(
    new RegExp(`^${creds.org_id}/${c.conversaId}/contrato-[0-9a-f-]{36}/Contrato_de_Honorarios\\.pdf$`),
  );
  expect(mensagens![0]!.body).toBe("Segue o contrato para sua assinatura. Qualquer dúvida, é só me chamar.");

  // 3. a linha do tempo do negócio registra o envio, com a atendente como autora.
  await expect(dossie).toContainText("Contrato enviado ao cliente", { timeout: 15_000 });

  // 4. marcar como assinado, com a via assinada.
  await item.getByRole("button", { name: "Marcar como assinado" }).click();
  await item.getByLabel("Via assinada em PDF (opcional)").setInputFiles({
    name: "contrato-assinado.pdf",
    mimeType: "application/pdf",
    buffer: pdf("via assinada pelo cliente"),
  });
  await item.getByRole("button", { name: "Confirmar assinatura" }).click();
  await expect(item).toHaveAttribute("data-contrato-status", "assinado", { timeout: 15_000 });
  await expect(item).toContainText("Assinado");
  await expect(item.getByRole("button")).toHaveCount(0);
  await expect(dossie).toContainText("Contrato assinado", { timeout: 15_000 });
  await captura(page, "03-contrato-assinado");

  // A via assinada abre: a rota confere a organização e assina a URL.
  const link = item.getByRole("link", { name: "Abrir via assinada" });
  const href = await link.getAttribute("href");
  const redirect = await page.request.get(href!, { maxRedirects: 0 });
  expect(redirect.status()).toBe(302);
  const arquivo = await page.request.get(redirect.headers()["location"]!);
  expect(arquivo.status()).toBe(200);
  expect((await arquivo.body()).subarray(0, 5).toString()).toBe("%PDF-");

  // 5. quem só lê vê o contrato e não tem botão — nem o servidor aceita.
  const contratoId = (await item.getAttribute("data-testid"))!.replace(/^contrato-/, "");
  await page.context().clearCookies();
  await login(page, creds.users.viewer!.email);
  const dossieDoViewer = await abrirOCard(page, c);
  const secaoDoViewer = dossieDoViewer.getByTestId("contratos-do-negocio");
  await expect(secaoDoViewer.locator("[data-contrato-status]")).toHaveAttribute("data-contrato-status", "assinado");
  await expect(secaoDoViewer.getByRole("button", { name: "Anexar contrato" })).toHaveCount(0);
  await captura(page, "04-viewer-so-le");
  const negado = await page.request.post(`/api/v1/contracts/${contratoId}/send`, { data: {} });
  expect(negado.status()).toBe(403);
});
