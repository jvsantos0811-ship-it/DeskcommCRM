/**
 * O FUNIL DE CADA NÚMERO (migration 9025) — provado PELA TELA (DoD 12).
 *
 * Briefing do Operador de 06/11/2026, item 5: "numa organização de teste com 2
 * números: um com Não, outro com Sim · funil B; mandar mensagem para os dois e
 * conferir o funil". É o que esta spec faz, como um leigo:
 *
 *   1. a empresa nasce (o mesmo `bootstrap-owner` do instalador) e ganha dois
 *      números e um segundo funil;
 *   2. em Conexões, os dois cartões dizem que abrem card no funil padrão — o
 *      padrão não muda ninguém;
 *   3. pela tela: o número interno vira "Não"; o comercial vira "Funil B";
 *   4. uma mensagem chega em cada número pelo CAMINHO DE PRODUÇÃO
 *      (`POST /api/v1/webhooks/waha/[token]`, como o WAHA chama);
 *   5. no quadro do Funil B aparece o card de quem escreveu no comercial; o de
 *      quem escreveu no interno não aparece em funil nenhum — e a conversa dele
 *      existe (contato e conversa gravados), porque só o card deixou de nascer.
 *
 * Nada de insert em `crm_leads`: o card nasce pela mesma rota da produção.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { nomeDaSessaoNovo } from "../../lib/channels/nome-da-sessao";
import { test, expect } from "./helpers/test";

test.use({ locale: "pt-BR" });

const EVIDENCIA = "evidence/funil-por-numero";

test("cada número escolhe se abre card e em qual funil — pela tela, com mensagem de verdade", async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(EVIDENCIA, { recursive: true });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Somente Supabase local");
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // ── 1 · a empresa, os dois números e o Funil B ─────────────────────────
  const sufixo = randomUUID().slice(0, 8);
  const email = `funil-numero-${sufixo}@example.test`;
  const password = `E2e-${randomUUID()}!`;
  const orgName = `funil-numero-${sufixo}`;
  execFileSync("pnpm", ["exec", "tsx", "scripts/bootstrap-owner.ts"], {
    env: { ...process.env, OWNER_EMAIL: email, OWNER_PASSWORD: password, OWNER_ORG_NAME: orgName },
    stdio: "pipe",
  });
  const { data: org } = await admin.from("organizations").select("id").eq("slug", orgName).single();
  const orgId = org!.id as string;
  expect((await admin.from("organizations").update({ onboarded_at: new Date().toISOString() }).eq("id", orgId)).error).toBeNull();

  const { data: padrao } = await admin
    .from("crm_pipelines")
    .select("id, name")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .single();
  const funilPadrao = padrao as { id: string; name: string };

  const { data: funilB, error: erroFunil } = await admin
    .from("crm_pipelines")
    .insert({ organization_id: orgId, name: "Funil B", slug: `funil-b-${sufixo}`, is_default: false, position: 5000 })
    .select("id")
    .single();
  expect(erroFunil).toBeNull();
  const funilBId = (funilB as { id: string }).id;
  expect(
    (
      await admin.from("crm_stages").insert([
        { organization_id: orgId, pipeline_id: funilBId, name: "Recepção B", slug: `recepcao-b-${sufixo}`, position: 1 },
        { organization_id: orgId, pipeline_id: funilBId, name: "Triagem B", slug: `triagem-b-${sufixo}`, position: 2 },
      ])
    ).error,
  ).toBeNull();

  async function criarNumero(nome: string) {
    const token = `e2e-funil-${randomUUID().replace(/-/g, "")}`;
    const sessao = nomeDaSessaoNovo(orgId);
    const { data, error } = await admin
      .from("channel_sessions")
      .insert({
        organization_id: orgId,
        display_name: nome,
        waha_session_name: sessao,
        webhook_secret_encrypted: "\\x00",
        webhook_path_token: token,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return { id: (data as { id: string }).id, token, sessao };
  }
  const interno = await criarNumero("Número interno");
  const comercial = await criarNumero("Número comercial");

  const lerAjuste = async (id: string) =>
    (await admin.from("channel_sessions").select("abre_card, funil_de_entrada_id, etapa_de_entrada_id").eq("id", id).single())
      .data;

  // ── 2 · o padrão: os dois abrem card no funil padrão ──────────────────
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/);
  await page.goto("/app/connections");

  const cartaoInterno = page.getByTestId(`conexao-${interno.id}`);
  const cartaoComercial = page.getByTestId(`conexao-${comercial.id}`);
  await expect(cartaoInterno.getByText("Número interno", { exact: true })).toBeVisible();
  for (const cartao of [cartaoInterno, cartaoComercial]) {
    await expect(cartao.getByTestId("funil-do-numero-resumo")).toHaveText("Abre card no funil");
    await expect(cartao.getByTestId("funil-do-numero-destino")).toContainText(funilPadrao.name);
    await expect(cartao.getByTestId("funil-do-numero-destino")).toContainText("funil padrão da empresa");
  }
  expect(await lerAjuste(interno.id)).toEqual({ abre_card: true, funil_de_entrada_id: null, etapa_de_entrada_id: null });

  // ── 3a · número interno: "Não" ─────────────────────────────────────────
  await cartaoInterno.getByRole("button", { name: "Configurar funil" }).click();
  const painel = page.getByRole("dialog", { name: "Funil deste número" });
  await expect(painel).toBeVisible();
  const chave = painel.getByRole("switch", { name: "Abrir card no funil" });
  await expect(chave).toHaveAttribute("aria-checked", "true");
  await chave.click();
  await expect(painel.getByText("não criam card no funil", { exact: false })).toBeVisible();
  // Com "Não", não há funil a escolher.
  await expect(painel.getByLabel("Em qual funil")).toHaveCount(0);
  await page.screenshot({ path: `${EVIDENCIA}/painel-nao-abre-card.png`, fullPage: true });
  await painel.getByRole("button", { name: "Salvar funil do número" }).click();
  await expect(painel).toBeHidden();
  await expect(cartaoInterno.getByTestId("funil-do-numero-resumo")).toHaveText("Não abre card no funil");
  await expect(cartaoInterno.getByText("As conversas deste número chegam no Inbox, sem criar card.")).toBeVisible();
  expect(await lerAjuste(interno.id)).toEqual({ abre_card: false, funil_de_entrada_id: null, etapa_de_entrada_id: null });

  // ── 3b · número comercial: "Sim · Funil B" ────────────────────────────
  await cartaoComercial.getByRole("button", { name: "Configurar funil" }).click();
  await expect(painel).toBeVisible();
  await painel.getByLabel("Em qual funil").click();
  await page.getByRole("option", { name: "Funil B", exact: true }).click();
  // Escolhido o funil, aparece a etapa — com a primeira aberta como padrão.
  await expect(painel.getByLabel("Em qual etapa")).toContainText("Primeira etapa (Recepção B)");
  await painel.getByRole("button", { name: "Salvar funil do número" }).click();
  await expect(painel).toBeHidden();
  await expect(cartaoComercial.getByTestId("funil-do-numero-destino")).toContainText("Funil B › Recepção B");
  expect(await lerAjuste(comercial.id)).toEqual({ abre_card: true, funil_de_entrada_id: funilBId, etapa_de_entrada_id: null });

  // Volta depois de recarregar: o que a tela mostra é o que está gravado.
  await page.reload();
  await expect(cartaoInterno.getByTestId("funil-do-numero-resumo")).toHaveText("Não abre card no funil");
  await expect(cartaoComercial.getByTestId("funil-do-numero-destino")).toContainText("Funil B › Recepção B");
  await page.screenshot({ path: `${EVIDENCIA}/conexoes-dois-numeros.png`, fullPage: true });

  // ── 4 · uma mensagem em cada número, pelo caminho da produção ─────────
  const final = String(Date.now()).slice(-6);
  const pessoaInterno = { nome: `Fornecedor Interno ${final}`, telefone: `55318${final}` };
  const pessoaComercial = { nome: `Lead Comercial ${final}`, telefone: `55317${final}` };
  async function mandar(numero: { token: string; sessao: string }, pessoa: { nome: string; telefone: string }) {
    const r = await page.request.post(`/api/v1/webhooks/waha/${numero.token}`, {
      data: {
        event: "message",
        session: numero.sessao,
        payload: {
          id: `e2e-funil-${randomUUID()}`,
          from: `${pessoa.telefone}@c.us`,
          fromMe: false,
          body: "Olá, gostaria de uma informação.",
          timestamp: Math.floor(Date.now() / 1000),
          _data: { notifyName: pessoa.nome },
        },
      },
    });
    expect(r.status(), "o webhook precisa aceitar — 4xx aqui e o resto mede o vazio").toBe(200);
  }
  await mandar(interno, pessoaInterno);
  await mandar(comercial, pessoaComercial);

  // Pelo NOME de quem escreveu (único nesta rodada): o telefone é normalizado
  // na gravação (`fn_upsert_wa_contact`), e comparar a grafia crua mediria a
  // normalização, não o funil.
  const cardsDe = async (nome: string) => {
    const { data: contatos } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", orgId)
      .eq("display_name", nome);
    const ids = ((contatos ?? []) as Array<{ id: string }>).map((c) => c.id);
    if (ids.length === 0) return { contato: false, conversas: 0, cards: [] as Array<{ pipeline_id: string }> };
    const { data: conversas } = await admin.from("conversations").select("id").eq("organization_id", orgId).in("contact_id", ids);
    const { data: cards } = await admin.from("crm_leads").select("pipeline_id").eq("organization_id", orgId).in("contact_id", ids);
    return { contato: true, conversas: (conversas ?? []).length, cards: (cards ?? []) as Array<{ pipeline_id: string }> };
  };

  // O comercial: card no Funil B.
  await expect.poll(async () => (await cardsDe(pessoaComercial.nome)).cards, { timeout: 30_000 }).toEqual([
    { pipeline_id: funilBId },
  ]);
  // O interno: contato e conversa existem; card, nenhum.
  await expect.poll(async () => (await cardsDe(pessoaInterno.nome)).conversas, { timeout: 30_000 }).toBe(1);
  expect((await cardsDe(pessoaInterno.nome)).cards).toEqual([]);

  // ── 5 · o que o leigo vê ──────────────────────────────────────────────
  await page.goto(`/app/pipelines/${funilBId}`);
  await expect(page.getByText(pessoaComercial.nome).first(), "o card do comercial está no Funil B").toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(pessoaInterno.nome)).toHaveCount(0);
  await page.screenshot({ path: `${EVIDENCIA}/funil-b-com-o-card.png`, fullPage: true });

  await page.goto(`/app/pipelines/${funilPadrao.id}`);
  await expect(page.getByText(pessoaInterno.nome)).toHaveCount(0);
  await expect(page.getByText(pessoaComercial.nome)).toHaveCount(0);


  // ── celular: o painel cabe sem rolar de lado ──────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/connections");
  await page.getByTestId(`conexao-${comercial.id}`).getByRole("button", { name: "Configurar funil" }).click();
  const painelNoCelular = page.getByRole("dialog", { name: "Funil deste número" });
  await expect(painelNoCelular.getByLabel("Em qual funil")).toBeVisible();
  expect(await painelNoCelular.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: `${EVIDENCIA}/painel-no-celular.png`, fullPage: true });
});
