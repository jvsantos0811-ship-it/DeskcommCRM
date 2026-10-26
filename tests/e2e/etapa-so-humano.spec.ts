/**
 * A CHAVE «SÓ ATENDIMENTO HUMANO» DA ETAPA, provada pela tela (fork, migration 9005).
 *
 * Na ordem em que o dono de um escritório faria: em Configurações › Funis ›
 * Etapas ele liga «Só atendimento humano» na etapa «Análise humana»; a chave
 * fica ligada depois de recarregar a tela; a vizinha segue desligada; e
 * desligar volta atrás. O que a chave FAZ — a IA não responde o cliente com o
 * negócio ali e a conversa vai para uma pessoa — é provado contra o Postgres
 * pelo turno real do agent-engine em
 * `tests/invariants/etapa-so-humano-cala-a-ia.test.ts`: este ambiente de e2e não
 * roda o worker de agentes nem tem modelo.
 *
 * ⚠️ O QUE É SETUP, e por que não é pela tela: organização, usuário e funil são
 * o cenário, criados pela service role no Supabase local (o mesmo desenho de
 * `etapa-avisa-na-central.spec.ts`). O que esta spec dirige pela tela é o que a
 * mudança entregou: a chave da etapa.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { test, expect, type Page } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });

// `evidence/` é VERSIONADO: evidência citada que não entra no repo é evidência
// que ninguém consegue conferir depois.
const EVIDENCIA = path.join(process.cwd(), "evidence", "etapa-so-humano");
fs.mkdirSync(EVIDENCIA, { recursive: true });

const ESPERA = 60_000;
const SENHA = `Local-${randomUUID()}!`;
const SUFIXO = randomUUID().slice(0, 8);

let userId = "";
let email = "";
let orgId = "";
let etapaTriagem = "";
let etapaAnalise = "";

async function inserir(tabela: string, valor: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function entrar(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(SENHA);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: ESPERA });
}

async function gravadoNoBanco(etapa: string): Promise<boolean> {
  const { data, error } = await db.from("crm_stages").select("requires_human").eq("id", etapa).single();
  if (error) throw error;
  return (data as { requires_human: boolean }).requires_human;
}

test.beforeAll(async () => {
  email = `etapa-so-humano-${SUFIXO}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password: SENHA, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("usuário não nasceu");
  userId = data.user.id;

  orgId = await inserir("organizations", {
    slug: `etapa-so-humano-${SUFIXO}`,
    legal_name: `Escritório ${SUFIXO}`,
    display_name: `Escritório ${SUFIXO}`,
    onboarded_at: new Date().toISOString(),
  });
  const { error: erroDoVinculo } = await db.from("user_organizations").insert({
    organization_id: orgId,
    user_id: userId,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (erroDoVinculo) throw erroDoVinculo;

  const funilId = await inserir("crm_pipelines", {
    organization_id: orgId,
    name: `Gestantes ${SUFIXO}`,
    slug: `gestantes-${SUFIXO}`,
  });
  etapaTriagem = await inserir("crm_stages", {
    organization_id: orgId, pipeline_id: funilId, name: "Triagem IA", slug: "triagem-ia", position: 1,
  });
  etapaAnalise = await inserir("crm_stages", {
    organization_id: orgId, pipeline_id: funilId, name: "Análise humana", slug: "analise-humana", position: 2,
  });
});

test.afterAll(async () => {
  if (orgId) await db.from("organizations").delete().eq("id", orgId);
  if (userId) await db.auth.admin.deleteUser(userId);
});

test("ligar «Só atendimento humano» na etapa grava a marca; a vizinha não muda; desligar volta atrás", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await entrar(page);

  await page.goto("/app/settings/tenant/pipelines");
  const chave = page.getByTestId(`so-humano-${etapaAnalise}`);
  await expect(chave).toBeVisible({ timeout: ESPERA });
  await expect(chave, "vem desligada").toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId(`etapa-${etapaAnalise}`)).toContainText(
    "Só atendimento humano: com um negócio aqui, a IA não responde o cliente e chama a equipe",
  );

  await chave.click();
  await expect(chave).toHaveAttribute("aria-checked", "true", { timeout: ESPERA });
  await page.screenshot({ path: path.join(EVIDENCIA, "01-chave-ligada.png"), fullPage: true });

  // Recarregar mostra a mesma coisa: a chave foi gravada, não só desenhada.
  await page.reload();
  await expect(page.getByTestId(`so-humano-${etapaAnalise}`)).toHaveAttribute("aria-checked", "true", { timeout: ESPERA });
  await expect(page.getByTestId(`so-humano-${etapaTriagem}`)).toHaveAttribute("aria-checked", "false");
  expect(await gravadoNoBanco(etapaAnalise), "a coluna que o motor lê").toBe(true);
  expect(await gravadoNoBanco(etapaTriagem)).toBe(false);

  await page.getByTestId(`so-humano-${etapaAnalise}`).click();
  await expect(page.getByTestId(`so-humano-${etapaAnalise}`)).toHaveAttribute("aria-checked", "false", { timeout: ESPERA });
  await expect.poll(() => gravadoNoBanco(etapaAnalise), { timeout: ESPERA }).toBe(false);
  await page.screenshot({ path: path.join(EVIDENCIA, "02-chave-desligada.png"), fullPage: true });
});
