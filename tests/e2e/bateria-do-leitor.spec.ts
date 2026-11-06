/**
 * PM-027 §8–§9 — a bateria do Leitor da conversa, PELA TELA.
 *
 *  1. O dono abre Administração › Bateria do Leitor, carrega um caso inventado
 *     do arquivo do Gestor e pede "Testar na bateria" para o Haiku 5.5: a rodada
 *     aparece em andamento (quem a roda é o cron, com a chave da empresa; aqui não
 *     há chave de IA, e a prova é a fila, não a nota).
 *  2. O admin de uma empresa abre IA › Provedores e vê o cartão do Leitor:
 *     desligado, o aviso da bateria, a nota de um modelo aprovado e o seletor que
 *     só aceita modelo aprovado COM chave do provedor (sem chave, a opção fica
 *     desabilitada e a linha diz "sem chave nesta empresa").
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { expect, test } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin, loginComoDono, type CredsE2E } from "./helpers/login-admin";
import { afirmarDonoDoServidor } from "./utils/precondicao";

const { url, serviceRole } = credenciaisSupabaseDeTeste();
const db = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });

const EVIDENCIA = path.join(process.cwd(), "evidence", "bateria-do-leitor");
const SUFIXO = Date.now().toString(36);
const CASO = `E2E-${SUFIXO}`;
const MODELO = "anthropic/claude-haiku-5-5";

let creds: CredsE2E;
const rodadasCriadas: string[] = [];

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.beforeAll(async () => {
  creds = lerCreds();
  await afirmarDonoDoServidor(creds.users.dono!.email);
});

test.afterAll(async () => {
  await db.from("leitor_bateria_rodadas").delete().in("id", rodadasCriadas.length ? rodadasCriadas : ["00000000-0000-0000-0000-000000000000"]);
  await db.from("leitor_bateria_rodadas").delete().eq("model_id", "claude-haiku-5-5").in("status", ["pendente", "rodando"]);
  await db.from("leitor_bateria_casos").delete().like("caso_id", "E2E-%");
});

test("o dono carrega um caso do Gestor e pede o teste na bateria", async ({ page }) => {
  await loginComoDono(page, creds);
  await page.goto("/admin/bateria-do-leitor");
  await expect(page.getByRole("heading", { level: 1, name: "Bateria do Leitor da conversa" })).toBeVisible({ timeout: 30_000 });

  const arquivo = {
    casos: [
      {
        id: CASO,
        origem: "inventado",
        organizacao: "Clínica de teste",
        bloqueia: true,
        relogio: ["2026-11-09T06:00-03:00"],
        conversa: [
          ["lead", "bom dia, quanto custa clareamento?"],
          ["ia", "Bom dia! Você já faz algum acompanhamento com dentista hoje?"],
          ["lead", "faço com o meu dentista há anos, só queria comparar o preço"],
        ],
        esperado: { ficha: { ja_atendido_por_outro: true, interesse: "Clareamento" }, situacao: "Já atendido por outro" },
      },
      { id: `${CASO}-aviso`, origem: "inventado", bloqueia: true, conversa: [["lead", "bom dia"]], esperado: { aviso_ninguem_respondeu: true } },
    ],
  };
  await page.getByTestId("bateria-formato").selectOption("gestor");
  await page.getByTestId("bateria-arquivo").setInputFiles({
    name: "Casos_Novos_Gestor.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(arquivo)),
  });
  await page.getByTestId("bateria-carregar").click();
  await expect(page.getByTestId("bateria-resultado-da-carga")).toContainText("1 criados, 1 ignorados.", { timeout: 15_000 });
  await expect(page.getByTestId("bateria-resultado-da-carga")).toContainText("não testa a ficha");
  await expect(page.getByTestId("bateria-totais")).toContainText("casos ativos");

  const linha = page.locator(`[data-testid="bateria-modelo"][data-modelo="${MODELO}"]`);
  await expect(linha).toBeVisible();
  const pediu = page.waitForResponse((r) => r.url().includes("/api/v1/admin/bateria-do-leitor/rodadas") && r.request().method() === "POST");
  await linha.getByTestId("bateria-testar").click();
  const resposta = await pediu;
  expect(resposta.status()).toBe(201);
  const corpo = (await resposta.json()) as { data: { rodada: { id: string; juiz_model_id: string } } };
  rodadasCriadas.push(corpo.data.rodada.id);
  // O juiz nunca é o testado: no automático, o Opus 5.5.
  expect(corpo.data.rodada.juiz_model_id).toBe("claude-opus-5-5");
  await expect(linha.getByTestId("bateria-progresso")).toContainText("rodando: 0 de", { timeout: 15_000 });
  await expect(linha.getByTestId("bateria-testar")).toBeDisabled();

  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, "1-bateria-do-dono.png"), fullPage: true });
});

test("o admin da empresa vê o cartão do Leitor: desligado, a nota e o seletor só com aprovado com chave", async ({ page }) => {
  // Uma rodada terminada e aprovada do Haiku 5.5, como o cron deixaria.
  const { data: rodada, error } = await db
    .from("leitor_bateria_rodadas")
    .insert({
      provider: "anthropic",
      model_id: "claude-haiku-5-5",
      juiz_provider: "anthropic",
      juiz_model_id: "claude-opus-5-5",
      status: "terminada",
      terminada_em: new Date().toISOString(),
      casos_total: 3,
      casos_feitos: 3,
      acertos: 3,
      bloqueantes: 3,
      bloqueantes_acertos: 3,
      aprovado: true,
      tempo_medio_ms: 2400,
    })
    .select("id")
    .single();
  if (error || !rodada) throw new Error(`rodada: ${error?.message}`);
  rodadasCriadas.push(rodada.id as string);

  creds = await loginComoAdmin(page, creds);
  await page.goto("/app/ai/providers");
  const cartao = page.getByTestId("cartao-do-leitor");
  await expect(cartao).toBeVisible({ timeout: 30_000 });
  await expect(cartao.getByTestId("leitor-estado")).toHaveText("Desligado");
  await expect(cartao.getByTestId("leitor-aviso-bateria")).toContainText("A bateria ainda é pequena (3 casos)");

  const haiku = cartao.locator(`[data-testid="leitor-modelo"][data-modelo="${MODELO}"]`);
  await expect(haiku).toContainText("3/3 em");
  await expect(haiku).toContainText("Aprovado");
  await expect(haiku).toContainText("2.4 s");

  // Sem a chave da Anthropic nesta empresa, o aprovado aparece desabilitado no seletor.
  const opcao = cartao.getByTestId("leitor-escolher-modelo").locator(`option[value="${MODELO}"]`);
  await expect(opcao).toHaveCount(1);
  if (await haiku.getByText("sem chave nesta empresa").count()) {
    // `toBeDisabled()` não lê o `disabled` de um <option> (medido no CI: o
    // Playwright achou `<option disabled …>` e respondeu "enabled"). A
    // propriedade do elemento é a pergunta certa.
    await expect(opcao).toHaveJSProperty("disabled", true);
    await expect(cartao.getByTestId("leitor-ligar")).toBeDisabled();
  }

  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await cartao.screenshot({ path: path.join(EVIDENCIA, "2-cartao-do-leitor.png") });
});
