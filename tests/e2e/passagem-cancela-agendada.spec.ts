/**
 * A PASSAGEM PARA HUMANO CANCELA A MENSAGEM AGENDADA — PELA TELA
 * (fork, migration 9007 — item 2.2 do briefing de 26/10/2026).
 *
 * Como a equipe vive isto:
 *
 *   1. numa conversa que a IA ainda atende, alguém agenda "te mando o link do
 *      pré-natal amanhã" pela caixa "Agendar mensagem" do Inbox;
 *   2. a IA passa a conversa para uma pessoa — aqui, gravando a linha da
 *      passagem que TODO caminho de passagem grava (`registrarPassagem`), que é
 *      onde mora o gatilho. Disparar a passagem por um turno de IA de verdade
 *      exigiria modelo e WhatsApp no CI, e mediria a IA, não o cancelamento;
 *   3. quem abre a conversa NÃO vê mais a mensagem na fila, e vê no fio a nota
 *      do "Sistema" dizendo que ela foi cancelada, o começo do texto e quando
 *      ela sairia — para reagendar se ainda fizer sentido.
 *
 * O que o gatilho faz em cada caso (idioma, fuso, `sending` intocada, falha
 * contida) é medido contra o Postgres em
 * `tests/invariants/passagem-cancela-agendadas.test.ts`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "passagem-cancela-agendada");
const TEXTO = "Te mando o link do pré-natal amanhã de manhã, combinado?";

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
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

/** Uma conversa só deste caso, que a IA ainda atende. */
async function conversaDaIa(): Promise<{ conversa: string; contato: string }> {
  const org = creds.org_id;
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", org)
    .limit(1)
    .maybeSingle();
  const sessaoId =
    (sessao as { id: string } | null)?.id ??
    (
      await admin
        .from("channel_sessions")
        .insert({ organization_id: org, waha_session_name: `e2e-agendada-${Date.now()}`, webhook_secret_encrypted: "\\x00" })
        .select("id")
        .single()
    ).data!.id;

  const sufixo = String(Date.now()).slice(-8);
  const { data: contato, error: e1 } = await admin
    .from("contacts")
    .insert({ organization_id: org, phone_number: `+55119${sufixo}`, display_name: "Gestante E2E", name: "Gestante E2E" })
    .select("id")
    .single();
  if (e1 || !contato) throw new Error(`contato: ${e1?.message}`);
  const { data: conversa, error: e2 } = await admin
    .from("conversations")
    .insert({
      organization_id: org,
      contact_id: contato.id,
      channel_session_id: sessaoId,
      status: "ai_handling",
      assignee_kind: "ai",
      last_inbound_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (e2 || !conversa) throw new Error(`conversa: ${e2?.message}`);
  return { conversa: conversa.id as string, contato: contato.id as string };
}

test("a passagem para humano cancela a mensagem agendada e avisa no fio", async ({ page }) => {
  test.setTimeout(120_000);
  const { conversa, contato } = await conversaDaIa();

  // 1. Alguém da equipe agenda um recado pela tela.
  await login(page, creds.users.manager!.email);
  await page.goto(`/app/inbox/${conversa}`);
  await page.getByRole("button", { name: "Agendar mensagem" }).click();
  await page.getByLabel("Texto da mensagem agendada").fill(TEXTO);
  await page.getByRole("button", { name: "Agendar", exact: true }).click();
  const naFila = page.locator('[data-agendada-status="scheduled"]', { hasText: TEXTO });
  await expect(naFila).toBeVisible({ timeout: 15_000 });
  await captura(page, "01-agendada-antes-da-passagem");

  // 2. A IA passa a conversa para uma pessoa: a linha que todo caminho grava.
  const { error } = await admin.from("passagens_de_atendimento").insert({
    organization_id: creds.org_id,
    contact_id: contato,
    conversation_id: conversa,
    motor: "engine",
    origem: "pedido_explicito",
    motivo_codigo: "requested_human",
    body: "O cliente pediu para falar com uma pessoa.",
  });
  expect(error, "a passagem tem de gravar").toBeNull();
  await expect
    .poll(
      async () =>
        (
          (await admin.from("scheduled_messages").select("status").eq("conversation_id", conversa).maybeSingle())
            .data as { status: string } | null
        )?.status ?? null,
      { timeout: 15_000 },
    )
    .toBe("cancelled");

  // 3. Quem abre a conversa vê o motivo no fio, e a fila vazia.
  await page.goto(`/app/inbox/${conversa}`);
  await expect(page.getByText("Mensagem agendada cancelada: a conversa passou para atendimento humano.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(`Texto: "${TEXTO}"`)).toBeVisible();
  await expect(page.locator("[data-agendada-status]")).toHaveCount(0);
  await captura(page, "02-cancelada-com-nota-no-fio");
});
