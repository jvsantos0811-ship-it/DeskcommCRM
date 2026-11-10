/**
 * J20.18 — EU RESPONDO O CLIENTE À MÃO PELO WHATSAPP, E A IA PARA.
 *
 * Numa conversa que o gate autorizou (o lead veio de uma origem elegível), o
 * dono pega o celular e responde o cliente direto no WhatsApp. Essa mensagem
 * entra pelo webhook do provider (`fromMe=true`, sem passar pelo composer do
 * CRM). A EQUIPE ASSUMIU (PC-029, regra do João de 10/11/2026): a IA para
 * nessa conversa de forma DURÁVEL (`bot_silenced_until = 'infinity'` + rastro
 * de handoff) e o contato fica "só humano" — SEM apagar
 * `contacts.ai_authorized_at`: a origem do lead é estado separado da pausa. A IA
 * só volta pela tela ("devolver ao automático"). Até o PC-029 o silêncio tinha
 * prazo e era renovado a cada fala; o prazo saiu de propósito.
 *
 * O que este spec prova, e por qual observável:
 *   - o webhook `fromMe=true` genuíno cala a IA         → `conversations.bot_silenced_until`
 *   - o silêncio é DURÁVEL ('infinity'), sem prazo      → o valor cru gravado
 *   - o contato fica "só humano"                         → `contacts.force_human`
 *   - a 2ª fala do mesmo atendimento não refaz nada      → `last_handoff_at` não muda
 *   - a tela DIZ que uma pessoa assumiu                  → badge de atendimento humano
 *   - a autorização do lead SOBREVIVE à pausa            → `contacts.ai_authorized_at`
 *   - "devolver ao automático" solta as travas          → `bot_silenced_until` null, `force_human` false
 *     …e a autorização CONTINUA lá                        → `contacts.ai_authorized_at`
 *
 * Pré-requisitos (banco local estilo VPS, app buildada):
 *   npx tsx scripts/seed-e2e-credentials.ts
 *   npx tsx scripts/seed-e2e-elegibilidade.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3001 pnpm exec playwright test tests/e2e/j20-elegibilidade-atendimento-manual.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence/j20-elegibilidade");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
  elegibilidade?: { channel_session_id: string; waha_path_token: string };
}

let creds: Creds;

function seedBase(): void {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  const atual = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!atual.elegibilidade) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-elegibilidade.ts"], { stdio: "inherit" });
  }
  creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!creds.elegibilidade) {
    throw new Error("bloco `elegibilidade` ausente após seed — veja a saída de seed-e2e-elegibilidade.ts");
  }
}

/** Roda 1 subcomando do helper de SQL cru e devolve o JSON da última linha. */
function helper<T = unknown>(...args: string[]): T {
  const stdout = execFileSync("npx", ["tsx", "scripts/e2e-elegibilidade-helpers.ts", ...args], {
    encoding: "utf8",
  });
  const last = stdout.trim().split("\n").filter(Boolean).pop();
  if (!last) throw new Error(`helper ${args[0]} não imprimiu JSON`);
  return JSON.parse(last) as T;
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/** POST no webhook per-tenant do WAHA (mesma rota que o WAHA real chama; sem
 *  assinatura — `.env.e2e` não liga `WAHA_WEBHOOK_REQUIRE_SIGNATURE`). */
async function postWaha(payload: unknown): Promise<number> {
  const token = creds.elegibilidade!.waha_path_token;
  const res = await fetch(`${APP_URL}/api/v1/webhooks/waha/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.status;
}

async function esperarContatoPorTelefone(digits: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const c = helper<{ id: string } | null>("find-contact-by-phone", digits);
    if (c?.id) return c.id;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`contato do telefone ${digits} não apareceu em 10s`);
}

test.describe("J20.18 — resposta manual pelo celular: a equipe assume (sem apagar a autorização)", () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ actionTimeout: 15_000 });

  test.beforeAll(() => {
    seedBase();
  });

  test("conversa autorizada → mensagem fromMe genuína pausa a IA; autorização sobrevive; a volta é pela tela", async ({
    page,
  }) => {
    const session = `e2e-elegibilidade-session`;
    // Telefone do cliente — E.164 sem o `+` vira o chatId `@c.us`.
    const digits = `55119${String(Date.now()).slice(-8)}`;
    const chatId = `${digits}@c.us`;
    let contactId = "";

    try {
      // ---------------------------------------------------------------------
      // (1) O cliente manda uma mensagem — a ingestão real cria contato+conversa.
      // ---------------------------------------------------------------------
      expect(
        await postWaha({
          event: "message",
          session,
          payload: {
            id: `false_${digits}@c.us_J20MANUAL${Date.now()}`,
            from: chatId,
            fromMe: false,
            body: "Oi, vi o formulário de vocês. Podem me passar os valores?",
            type: "chat",
            timestamp: Math.floor(Date.now() / 1000),
            _data: { notifyName: "Cliente J20.18" },
          },
        }),
      ).toBe(200);

      contactId = await esperarContatoPorTelefone(digits);

      // A origem elegível carimba a autorização (aqui, direto — o caso sob teste
      // não é o webhook do Respondi, é a resposta manual).
      expect(helper<{ ok: boolean }>("set-authorized", contactId).ok).toBe(true);

      const conv = helper<{ id: string; bot_silenced_until: string | null }>(
        "conversation-for-contact",
        contactId,
      );
      const conversationId = conv.id;
      expect(conv.bot_silenced_until, "estado de partida: sem silêncio").toBeNull();

      // ---------------------------------------------------------------------
      // (2) O dono responde pelo celular — webhook fromMe=true, sem composer.
      // ---------------------------------------------------------------------
      expect(
        await postWaha({
          event: "message.any",
          session,
          payload: {
            id: `true_${digits}@c.us_J20REPLY${Date.now()}`,
            to: chatId,
            fromMe: true,
            body: "Oi! Já te passo os valores por aqui.",
            type: "text",
            timestamp: Math.floor(Date.now() / 1000),
          },
        }),
      ).toBe(200);

      // ---------------------------------------------------------------------
      // (3) A PROVA QUE IMPORTA: a IA parou de verdade nesta conversa.
      // ---------------------------------------------------------------------
      await expect
        .poll(
          () =>
            helper<{ bot_silenced_until: string | null }>("conversation-silence", conversationId)
              .bot_silenced_until,
          { timeout: 20_000, message: "a resposta manual tem de silenciar a IA nesta conversa" },
        )
        .not.toBeNull();

      const depoisDaPausa = helper<{
        bot_silenced_until: string | null;
        last_handoff_at: string | null;
        last_handoff_reason: string | null;
      }>("conversation-silence", conversationId);
      expect(String(depoisDaPausa.last_handoff_reason)).toMatch(/manual/i);
      expect(depoisDaPausa.last_handoff_at).not.toBeNull();

      // O SILÊNCIO É DURÁVEL (PC-029): a equipe que responde pelo celular
      // assume, e a IA só volta pelo "devolver". Até o PC-029 era um prazo que
      // vencia sozinho — e a IA voltava a falar no meio do atendimento humano.
      expect(
        String(depoisDaPausa.bot_silenced_until),
        "a resposta pelo celular tem de calar a IA até alguém devolver",
      ).toMatch(/infinity/i);

      // A AUTORIZAÇÃO DO LEAD SOBREVIVE — pausar a conversa ≠ apagar a origem.
      const autorizacao = helper<{
        ai_authorized_at: string | null;
        ai_authorized_reason: string | null;
        force_human: boolean | null;
      }>("contact-authorization", contactId);
      expect(
        autorizacao.ai_authorized_at,
        "a resposta manual NÃO pode apagar ai_authorized_at — é estado separado",
      ).not.toBeNull();
      // …e o contato fica "só humano", o mesmo estado da passagem para humano.
      expect(autorizacao.force_human, "a equipe assumiu: o contato fica só humano").toBe(true);

      // ---------------------------------------------------------------------
      // (4) A 2ª mensagem do celular, no MESMO atendimento, não refaz nada:
      //     nem rastro novo, nem nota, nem movimento do card. O silêncio segue
      //     durável — não há prazo a renovar.
      // ---------------------------------------------------------------------
      const handoffAntes = depoisDaPausa.last_handoff_at;
      expect(
        await postWaha({
          event: "message.any",
          session,
          payload: {
            id: `true_${digits}@c.us_J20REPLY2${Date.now()}`,
            to: chatId,
            fromMe: true,
            body: "Segue a tabela.",
            type: "text",
            timestamp: Math.floor(Date.now() / 1000),
          },
        }),
      ).toBe(200);
      const depoisDaSegunda = helper<{
        bot_silenced_until: string | null;
        last_handoff_at: string | null;
      }>("conversation-silence", conversationId);
      expect(String(depoisDaSegunda.bot_silenced_until)).toMatch(/infinity/i);
      expect(
        depoisDaSegunda.last_handoff_at,
        "a segunda fala do mesmo atendimento não abre um episódio novo",
      ).toBe(handoffAntes);

      // ---------------------------------------------------------------------
      // (5) A tela DIZ que uma pessoa assumiu, e oferece a volta.
      // ---------------------------------------------------------------------
      await login(page, creds.users.agent!.email);
      await page.goto(`${APP_URL}/app/inbox/${conversationId}`);
      await expect(
        page.getByTestId("badge-atendimento-humano"),
        "conversa com a IA pausada não pode ter a mesma cara de uma normal",
      ).toBeVisible({ timeout: 30_000 });
      const devolver = page.getByTestId("devolver-ao-automatico");
      await expect(devolver).toBeVisible();
      await captura(page, "18-ia-pausada-por-resposta-manual");

      // ---------------------------------------------------------------------
      // (6) A volta: solta a trava — e a autorização CONTINUA lá.
      // ---------------------------------------------------------------------
      await devolver.click();
      await expect
        .poll(
          () =>
            helper<{ bot_silenced_until: string | null }>("conversation-silence", conversationId)
              .bot_silenced_until,
          { timeout: 20_000 },
        )
        .toBeNull();
      await expect(page.getByTestId("badge-atendimento-humano")).toHaveCount(0, { timeout: 20_000 });
      await captura(page, "18-devolvido-ao-automatico");

      const depoisDaVolta = helper<{ ai_authorized_at: string | null; force_human: boolean | null }>(
        "contact-authorization",
        contactId,
      );
      expect(
        depoisDaVolta.ai_authorized_at,
        "devolver ao automático não pode apagar a origem do lead",
      ).not.toBeNull();
      expect(depoisDaVolta.force_human, "devolver solta também o \"só humano\" do contato").toBe(false);
    } finally {
      if (contactId) {
        try {
          helper("cleanup-contact", contactId);
        } catch (e) {
          console.error("[cleanup] falhou (não mascara o teste):", e);
        }
      }
    }
  });
});
