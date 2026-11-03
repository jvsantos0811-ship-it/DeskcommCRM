/**
 * MÍDIAS NÃO ENTENDIDAS — PELA TELA (PC-021, fork).
 *
 * O áudio que o sistema não entendeu (só ruído, curto demais) chega ao agente
 * como "ÁUDIO NÃO ENTENDIDO (duração Ns)", e a IA pede para repetir ou escrever
 * (a régua e a moldura do turno são provadas nos testes puros de
 * `lib/messaging/media/nao-entendida.test.ts` e do worker). Aqui, o que a
 * equipe vê: no Inbox, o balão do áudio diz que ele não foi entendido (em vez de
 * mostrar o marcador como se fosse transcrição); em Configurações › IA, a conta
 * por dia.
 *
 * Capturas em `evidence/pc-021/`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "pc-021");

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

test.describe("PC-021 — áudio não entendido", () => {
  let conversa = "";

  test.beforeAll(async () => {
    const org = creds.org_id;
    const sufixo = String(Date.now()).slice(-8);
    const { data: sessao, error: e0 } = await admin
      .from("channel_sessions")
      .insert({ organization_id: org, waha_session_name: `e2e-pc021-${sufixo}`, webhook_secret_encrypted: "\\x00", status: "STOPPED" })
      .select("id")
      .single();
    if (e0 || !sessao) throw new Error(`sessão: ${e0?.message}`);
    const nome = `Rosa Audio ${sufixo}`;
    const { data: contato, error: e1 } = await admin
      .from("contacts")
      .insert({ organization_id: org, phone_number: `+55317${sufixo}`, display_name: nome, name: nome })
      .select("id")
      .single();
    if (e1 || !contato) throw new Error(`contato: ${e1?.message}`);
    const agora = new Date().toISOString();
    const { data: conv, error: e2 } = await admin
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
    if (e2 || !conv) throw new Error(`conversa: ${e2?.message}`);
    conversa = conv.id;
    const { error: e3 } = await admin.from("messages").insert({
      organization_id: org,
      conversation_id: conv.id,
      channel_session_id: sessao.id,
      contact_id: contato.id,
      direction: "inbound",
      status: "received",
      sent_via: "external_device",
      type: "audio",
      media_url: "https://example.invalid/audio.ogg",
      media_storage_path: `${org}/${conv.id}/audio.ogg`,
      media_mime: "audio/ogg",
      media_derived_status: "ready",
      media_derived_text: "ÁUDIO NÃO ENTENDIDO (duração 9s)",
      sent_at: agora,
    });
    if (e3) throw new Error(`mensagem: ${e3.message}`);
  });

  test("o Inbox diz que o áudio não foi entendido, e Configurações › IA conta por dia", async ({ page }) => {
    test.setTimeout(150_000);
    await login(page);

    await page.goto(`/app/inbox/${conversa}`);
    await expect(page.getByTestId("audio-nao-entendido")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("audio-nao-entendido")).toContainText("Áudio não entendido");
    await expect(page.getByTestId("transcricao-de-audio")).toHaveCount(0);
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCIA, "inbox-audio-nao-entendido.png") });

    await page.goto("/app/settings/ia");
    const card = page.getByTestId("midias-nao-entendidas");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole("heading", { name: "Mídias não entendidas" })).toBeVisible();
    // Hoje há pelo menos o áudio semeado (a organização de teste pode ter outros).
    const primeiraLinha = card.locator("tbody tr").first();
    await expect(primeiraLinha).toBeVisible();
    expect(Number(await primeiraLinha.locator("td").nth(1).innerText())).toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: path.join(EVIDENCIA, "configuracoes-midias-nao-entendidas.png"), fullPage: true });
  });
});
